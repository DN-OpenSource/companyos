import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions, RenderInput } from 'claude-code'

import type { GateCheck, GateState } from '../types'
import { readChanges } from './diff'
import { log, readEvents } from './events'
import { SECRET } from './guard'
import { clip } from './util'

type Mode = 'block' | 'warn' | 'off'
type Config = { commands: Record<'tests' | 'types' | 'lint' | 'coverage', string>; modes: Record<string, Mode>; coverageTarget: number }

const CHECKS: [GateCheck['id'], string][] = [
  ['tests', 'Tests'],
  ['types', 'Types'],
  ['lint', 'Lint'],
  ['secrets', 'Secrets'],
  ['scope', 'Scope'],
  ['coverage', 'Coverage'],
  ['leftovers', 'Leftovers'],
]
const DEFAULT_MODES = 'tests:block,types:block,lint:warn,secrets:block,scope:warn,coverage:warn,leftovers:warn'
// A held turn is sent back at most this many times in a row, so a gate that cannot pass never loops forever.
const MAX_HOLDS = 3
const MANIFEST = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(\.lock)?|pubspec\.(yaml|lock))$/
const LEFTOVER = /\bconsole\.(log|debug)\(|\bdebugger\b|\bprint\(|\bTODO\b|\bFIXME\b/
const TEST_FILE = /(\.|_|\/)(test|spec)s?(\.|\/|_)|(^|\/)tests?\//

const gate = atom({ plugin: 'companyos', key: 'gate' } as const, { ts: 0, isRunning: false, checks: [], review: [], holds: 0 })

export async function readGate($: EngineInterface): Promise<GateState> {
  return read($, gate)
}

// A held turn's count starts over with each prompt the person sends.
export async function resetGateHolds($: EngineInterface) {
  await update($, gate, g => ({ ...g, holds: 0 }))
}

function configOf(options: PluginOptions): Config {
  const modes: Record<string, Mode> = {}
  for (const pair of `${DEFAULT_MODES},${String(options.gateModes ?? '')}`.split(',')) {
    const [id, mode] = pair.split(':').map(x => x.trim())
    if (id && (mode === 'block' || mode === 'warn' || mode === 'off')) modes[id] = mode
  }
  return {
    commands: {
      tests: String(options.gateTests ?? ''),
      types: String(options.gateTypes ?? ''),
      lint: String(options.gateLint ?? ''),
      coverage: String(options.gateCoverage ?? ''),
    },
    modes,
    coverageTarget: Number(options.gateCoverageTarget ?? 80) || 80,
  }
}

async function line($: EngineInterface, cmd: string, cwd: string): Promise<{ code: number; out: string } | undefined> {
  for (const argv of [['sh', '-c', cmd], ['cmd', '/c', cmd]]) {
    try {
      const r = await $.process.run(argv, { cwd, timeoutMs: 240_000 })
      return { code: r.exitCode, out: `${r.stdout}\n${r.stderr}`.trim() }
    } catch {
      // that shell is not installed
    }
  }
  return undefined
}

// The package.json script for a check when the person named no command.
async function guess($: EngineInterface, root: string, id: 'tests' | 'types' | 'lint'): Promise<string> {
  try {
    const scripts = (JSON.parse(await $.fs.read(`${root}/package.json`)) as { scripts?: Record<string, string> }).scripts ?? {}
    const pick = { tests: ['test'], types: ['typecheck', 'type-check', 'types', 'tsc'], lint: ['lint'] }[id].find(k => scripts[k])
    return pick ? `npm run -s ${pick}` : ''
  } catch {
    return ''
  }
}

type Added = { file: string; line: number; text: string }

// The lines this work adds, with where they land, from `git diff HEAD -U0`.
function addedLines(diff: string): Added[] {
  const out: Added[] = []
  let file = ''
  let at = 0
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) file = l.slice(4).replace(/^b\//, '')
    else if (l.startsWith('@@')) at = Number(l.match(/\+(\d+)/)?.[1] ?? 0)
    else if (l.startsWith('+')) out.push({ file, line: at++, text: l.slice(1) })
    else if (!l.startsWith('-')) at++
  }
  return out
}

const lastLines = (out: string, n = 3) => out.split('\n').filter(x => x.trim()).slice(-n).join(' · ')

export async function runGate($: EngineInterface, options: PluginOptions): Promise<GateState> {
  const cfg = configOf(options)
  const root = (await $.session.repo())?.root ?? (await $.session.cwd())
  await update($, gate, g => ({ ...g, isRunning: true, checks: CHECKS.map(([id, name]): GateCheck => ({ id, name, status: cfg.modes[id] === 'off' ? 'off' : 'running', note: '' })) }))

  const git = async (args: string[]) => (await line($, ['git', ...args].join(' '), root))?.out ?? ''
  const diff = await git(['diff', 'HEAD', '-U0', '--no-color'])
  const names = (await git(['diff', 'HEAD', '--name-only'])).split('\n').filter(Boolean)
  const added = addedLines(diff)

  const checks: GateCheck[] = []
  for (const [id, name] of CHECKS) {
    const mode = cfg.modes[id] ?? 'warn'
    const bad = mode === 'block' ? 'fail' : 'warn'
    let c: GateCheck = { id, name, status: 'pass', note: '' }
    if (mode === 'off') c = { ...c, status: 'off', note: 'off in /cos config' }
    else if (id === 'tests' || id === 'types' || id === 'lint' || id === 'coverage') {
      const cmd = cfg.commands[id] || (id === 'coverage' ? '' : await guess($, root, id))
      if (!cmd) c = { ...c, status: 'off', note: 'no command found; set one in /cos config' }
      else {
        const r = await line($, cmd, root)
        if (r === undefined) c = { ...c, status: bad, note: `${cmd} could not start` }
        else if (id === 'coverage') {
          const pct = Number([...r.out.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].at(-1)?.[1] ?? NaN)
          c = Number.isNaN(pct)
            ? { ...c, status: 'warn', note: `${cmd} printed no percentage` }
            : pct >= cfg.coverageTarget
              ? { ...c, note: `${pct}% covered · target ${cfg.coverageTarget}%` }
              : { ...c, status: bad, note: `${pct}% covered · target ${cfg.coverageTarget}%` }
        } else c = r.code === 0 ? { ...c, note: `${cmd} · clean` } : { ...c, status: bad, note: `${cmd} · exit ${r.code} · ${clip(lastLines(r.out), 200)}` }
      }
    } else if (id === 'secrets') {
      const hit = added.find(a => SECRET.test(a.text))
      c = hit ? { ...c, status: bad, note: `a key-shaped string in ${hit.file}:${hit.line}` } : { ...c, note: 'no keys in the changes' }
    } else if (id === 'scope') {
      const deps = names.filter(n => MANIFEST.test(n))
      c = deps.length ? { ...c, status: bad, note: `dependency files changed: ${deps.join(', ')}` } : { ...c, note: `${names.length} files changed, no dependency files` }
    } else {
      const left = added.filter(a => LEFTOVER.test(a.text))
      c = left.length ? { ...c, status: bad, note: `${left.length} left: ${left.slice(0, 3).map(a => `${a.file}:${a.line}`).join(', ')}` } : { ...c, note: 'no debug output or TODO left' }
    }
    checks.push(c)
    await update($, gate, g => ({ ...g, checks: g.checks.map(x => (x.id === id ? c : x)) }))
  }

  // Where a reviewer should look first.
  const perFile = new Map<string, number>()
  for (const a of added) perFile.set(a.file, (perFile.get(a.file) ?? 0) + 1)
  const busiest = [...perFile].sort((a, b) => b[1] - a[1])[0]
  const tests = names.filter(n => TEST_FILE.test(n))
  const stem = (n: string) => (n.split('/').pop() ?? n).replace(/\.[^.]+$/, '')
  const untested = names.filter(n => !TEST_FILE.test(n) && !MANIFEST.test(n) && /\.(ts|tsx|js|jsx|py|go|rs|dart|swift|kt|java|rb)$/.test(n) && !tests.some(t => stem(t).startsWith(stem(n))))
  const review = [
    ...(busiest ? [`Read first: ${busiest[0]} · ${busiest[1]} lines added`] : []),
    ...(untested.length ? [`No test changed beside: ${untested.slice(0, 3).join(', ')}`] : []),
    ...names.filter(n => MANIFEST.test(n)).map(n => `Dependency change: ${n}`),
  ]

  const state: GateState = { ts: await $.clock.now(), isRunning: false, checks, review, holds: (await read($, gate)).holds }
  await update($, gate, () => state)
  const failed = checks.filter(c => c.status === 'fail')
  await log($, 'guard', undefined, `gate: ${failed.length ? `${failed.map(c => c.name).join(', ')} failed` : 'passed'}`, { isDone: true, isError: failed.length > 0 })
  const tests1 = checks.find(c => c.id === 'tests')
  if (tests1?.status === 'fail') $.ui.log(`✕ Done gate: ${tests1.note}`)
  return state
}

function holdReason(state: GateState) {
  const failed = state.checks.filter(c => c.status === 'fail')
  return [
    'The CompanyOS done gate held this turn: fix these before finishing.',
    ...failed.map(c => `- ${c.name}: ${c.note}`),
    ...state.checks.filter(c => c.status === 'warn').map(c => `- (warning only) ${c.name}: ${c.note}`),
  ].join('\n')
}

export async function qualityBody($: EngineInterface, e: RenderInput<'Pane'>, options: PluginOptions) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const g = await read($, gate)
  const icon = { pass: '✓', fail: '✕', warn: '!', off: '·', running: '…' } as const
  const color = { pass: 'success', fail: 'error', warn: 'warning', off: 'inactive', running: 'suggestion' } as const
  const fixable = g.checks.filter(c => c.status === 'fail' || c.status === 'warn')
  const fix = (text: string) => () => $.prompt.submit({ text }).then(() => {})
  return (
    <Box flexDirection="column">
      <Text bold>Done gate · runs before Claude ends a turn that changed files</Text>
      <Text dimColor>{g.ts ? `last run ${new Date(g.ts).toTimeString().slice(0, 8)}${g.isRunning ? ' · running' : ''}` : 'not run yet'} · block · warn · off per check in /cos config</Text>
      {g.checks.map(c => (
        <Box flexDirection="row">
          <Text color={color[c.status]}>
            {icon[c.status]} {c.name.padEnd(10)} {clip(c.note, Math.max(20, e.props.bodyColumns - 30))}{' '}
          </Text>
          {(c.status === 'fail' || c.status === 'warn') && (
            <Button key={`fix-${c.id}`} plain onPress={fix(`Fix the ${c.name} check from the CompanyOS done gate: ${c.note}`)}>
              fix
            </Button>
          )}
        </Box>
      ))}
      <Box flexDirection="row">
        <Button key="gate-run" hotkey="r" variant="primary" onPress={() => runGate($, options).then(() => {})}>
          r: re-run gate
        </Button>
        {fixable.length > 0 && (
          <Button key="gate-fix-all" hotkey="f" onPress={fix(holdReason({ ...g, checks: fixable.map(c => ({ ...c, status: 'fail' })) }))}>
            f: ask Claude to fix all
          </Button>
        )}
      </Box>
      {g.review.length > 0 && <Text bold>Before you review</Text>}
      {g.review.map(r => (
        <Text>▸ {r}</Text>
      ))}
    </Box>
  )
}

export function gates(on: On, options: PluginOptions) {
  on('command.run', { command: 'gate' }, async $ => {
    const g = await runGate($, options)
    const failed = g.checks.filter(c => c.status === 'fail')
    return { text: failed.length ? holdReason(g) : `Done gate passed (${g.checks.filter(c => c.status === 'warn').length} warnings).` }
  })

  gateOptions = options

  // Before Claude ends a turn that changed files, the gate runs; a failing block check sends it back with the reason.
  on('classic.Stop', async ($, e, next) => {
    stopSeenAt = await $.clock.now()
    const reason = await judge($, options)
    return reason === undefined ? next(e) : { block: reason }
  })
}

// The settings in force, for the turn-end fallback the feed calls.
let gateOptions: PluginOptions = {}
// When classic.Stop last reached the mod; a plugin above may pass that event on past it.
let stopSeenAt = 0

// Runs the gate for a turn that changed files; the reason to send Claude back with, or undefined to let it end.
async function judge($: EngineInterface, options: PluginOptions): Promise<string | undefined> {
  const events = await readEvents($)
  const since = [...events].reverse().find(x => x.kind === 'prompt')?.ts ?? 0
  const edited = (await readChanges($)).some(c => c.ts >= since)
  const g = await read($, gate)
  if (!edited || g.holds >= MAX_HOLDS) return undefined
  const state = await runGate($, options)
  if (!state.checks.some(c => c.status === 'fail')) return undefined
  await update($, gate, x => ({ ...x, holds: x.holds + 1 }))
  $.ui.toast(`CompanyOS: done gate held the turn (${state.checks.filter(c => c.status === 'fail').map(c => c.name).join(', ')})`)
  return holdReason(state)
}

// Where classic.Stop never reached the mod this turn, the gate runs as the turn completes and a failing
// block check sends Claude back with a prompt of its own: the same hold, one step later.
export async function gateAtTurnEnd($: EngineInterface, turnStartedAt: number) {
  if (stopSeenAt >= turnStartedAt) return
  const reason = await judge($, gateOptions)
  if (reason !== undefined) await $.prompt.submit({ text: reason })
}
