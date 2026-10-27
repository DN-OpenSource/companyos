import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions, RenderInput } from 'claude-code'

import type { Binding } from '../types'
import { forecast } from './anthropic'
import { councilBody } from './council'
import { diffBody, revert } from './diff'
import { eventsBody } from './feed'
import { qualityBody } from './gate'
import { memoryBody } from './memory'
import { officeBody, officeCommand, startOffice } from './office'
import { checkpoints, restore } from './sessions'
import { telemetryBody } from './stats'
import { tickets, ticketsBody } from './tickets'
import { argOf, clip, COL } from './util'

export const HUB = 'companyos'
// The design's tabs: id, hotkey, label as drawn, icon.
const TABS: [string, string, string, string][] = [
  ['events', '1', 'Events', '≋'],
  ['telemetry', '2', 'Telemetry', '▥'],
  ['diff', '3', 'Diff', '±'],
  ['office', '4', 'Office', '▦'],
  ['council', '5', 'Council', '◇'],
  ['memory', '6', 'Memory', '◉'],
  ['tickets', '7', 'Tickets', '▤'],
  ['account', '8', 'Account', '☺'],
  ['checkpoint', '9', 'Checkpoints', '⧗'],
  ['config', '0', 'Config', '⚙'],
  ['quality', 'q', 'Quality', '✓'],
]
const ROUTINE = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'TodoWrite', 'ToolSearch'])
// The design's suggestions, in its order; running agents join the @ list.
const AT = ['@lead', '@all', '@mem', '@jira', '@notion', '@linear', '@office', '@council', '@gh']
const SLASH = ['/events', '/telemetry', '/graph', '/cos diff', '/office', '/council', '/mem', '/ticket', '/account', '/anthropic', '/checkpoint', '/gate', '/mode', '/daily', '/report', '/replay', '/handover', '/cos config']
const IDLE_HINT = '? for shortcuts · @ agents · / commands · $ shell'

const tab = atom({ plugin: 'companyos', key: 'tab' } as const, 'office')
// Focus starts on, as in the design: routine reads and searches fold to one line.
const focus = atom({ plugin: 'companyos', key: 'focus' } as const, true)
// What is typed in the prompt so far, so the hint line can suggest how to finish it.
const draftToken = atom({ plugin: 'companyos', key: 'draftToken' } as const, '')

export async function openHub($: EngineInterface, to?: string): Promise<string> {
  if (to && TABS.some(t => t[0] === to)) await update($, tab, () => to)
  const opened = await $.ui.open({ id: HUB, title: 'CompanyOS' })
  // The office tab animates; its clock stops by itself once the hub is closed.
  if (opened.isPlaced) await startOffice($, isLowPower)
  return opened.isPlaced ? `companyos · opened ${to || (await read($, tab))}` : `CompanyOS waits: ${opened.reason}`
}

async function accountBody($: EngineInterface, e: RenderInput<'Pane'>) {
  const { Box, Text } = $.ui.resolve(e)
  const keys = (await $.store.keys()).filter(k => k.startsWith('accounts/'))
  const bound = await Promise.all(keys.map(async k => [k.slice(9), (await $.store.get(k)) as Binding] as const))
  const [repo, who, usage, ahead, profiles, routes] = await Promise.all([
    $.session.repo(),
    $.session.identity(),
    $.session.usage(),
    forecast($),
    $.store.get('anthropic/profiles') as Promise<{ name: string; provider: string }[] | undefined>,
    $.store.get('anthropic/routes') as Promise<Record<string, string> | undefined>,
  ])
  const name = (root: string) => root.replace(/\\/g, '/').split('/').slice(-2).join('/')
  const limit = usage.rateLimits[0]
  const pace = ahead.find(a => limit && a.startsWith(limit.kind))?.match(/hit in (.+)$/)?.[1]
  const plan = who.deny === undefined ? [who.email, who.organizationType ?? who.kind].filter(Boolean).join(' · ') : 'signed in'
  return (
    <Box flexDirection="column">
      <Text color={COL.acc}>/account</Text>
      {bound.length === 0 && <Text dimColor>  no repo bound yet · /account bind &lt;login&gt; [email]</Text>}
      {bound.map(([root, b]) => (
        <Text>
          {'  '}
          {name(root).padEnd(24)} → <Text color={COL.sage}>gh:{b.login}</Text>
          {repo && repo.root === root ? <Text dimColor> (bound)</Text> : ''}
        </Text>
      ))}
      <Text dimColor>  Commit or push under the wrong account is blocked, with the fix in the message.</Text>
      <Text color={COL.acc}>/anthropic</Text>
      <Text>  signed in · {plan}</Text>
      <Text>
        {'  '}rate limit
        {limit ? ` · ${limit.kind === 'five_hour' ? '5h' : limit.kind} window ${Math.round(limit.percentUsed)}%` : ' · none reported'}
        {pace ? ` · limit hit in ~${pace.replace(' minutes', ' min')}` : ''}
      </Text>
      <Text>
        {'  '}next session profile: <Text color={COL.sage}>{(profiles ?? []).map(p => `${p.name} (${p.provider})`).join(' · ') || 'subscription · API · Bedrock · Vertex · gateway'}</Text>
      </Text>
      <Text>
        {'  '}route{' '}
        {Object.entries(routes ?? {}).length === 0 ? (
          <Text dimColor>none · /anthropic route &lt;agent&gt; &lt;model&gt;</Text>
        ) : (
          Object.entries(routes ?? {}).map(([agent, model]) => `${agent} → ${model.replace(/^claude-/, '').split('-')[0]}`).join('  ')
        )}
      </Text>
    </Box>
  )
}

async function checkpointBody($: EngineInterface, e: RenderInput<'Pane'>) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const root = (await $.session.repo())?.root
  const all = root ? await checkpoints($, root) : []
  const list = all.map((c, i) => ({ c, label: `cp-${String(i + 1).padStart(2, '0')}` })).reverse()
  return (
    <Box flexDirection="column">
      <Text color={COL.acc}>/checkpoint list</Text>
      {root === undefined && <Text dimColor>  Checkpoints need a git repository.</Text>}
      {root !== undefined && list.length === 0 && <Text dimColor>  none yet · /checkpoint [label]</Text>}
      {list.map(({ c, label }) => (
        <Box flexDirection="row">
          <Text>
            {'  '}
            <Text color={COL.sage}>{label}</Text> <Text dimColor>{new Date(c.ts).toTimeString().slice(0, 5)}</Text> {clip(c.label, Math.max(10, e.props.bodyColumns - 30)).padEnd(Math.min(36, Math.max(10, e.props.bodyColumns - 30)))}{' '}
          </Text>
          <Button key={`restore-${c.id}`} plain onPress={() => restore($, c.id).then(msg => $.ui.toast(msg))}>
            <Text color={COL.fg}>restore</Text>
          </Button>
        </Box>
      ))}
      <Text dimColor>Snapshots don't touch your files. Restore asks for a yes.</Text>
    </Box>
  )
}

async function configBody($: EngineInterface, e: RenderInput<'Pane'>, options: PluginOptions) {
  const { Box, Text } = $.ui.resolve(e)
  const show = (k: string) => {
    const v = options[k]
    if (k === 'protectedPaths') return JSON.stringify(String(v ?? '').split(',').map(s => s.trim()).filter(Boolean))
    if (typeof v === 'number') return k === 'costCapUsd' ? v.toFixed(2) : String(v)
    if (typeof v === 'boolean') return String(v)
    return JSON.stringify(v ?? '')
  }
  const keys = ['protectedPaths', 'costCapUsd', 'theme', 'lowPower', 'webhookUrl', 'openOnStart', 'gateModes', 'gateTests', 'gateTypes', 'gateLint', 'gateCoverage', 'gateCoverageTarget']
  return (
    <Box flexDirection="column">
      <Text color={COL.acc}>/cos config</Text>
      {keys.map(k => (
        <Text>
          {'  '}
          {k.padEnd(20)}
          <Text color={COL.sage}>{show(k)}</Text>
        </Text>
      ))}
      <Text dimColor>Change these in /config, under companyos; the mod reloads with the new values.</Text>
    </Box>
  )
}

async function hubBody($: EngineInterface, e: RenderInput<'Pane'>, options: PluginOptions) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const [shown, isFocused] = await Promise.all([read($, tab), read($, focus)])
  const body =
    shown === 'events'
      ? await eventsBody($, e)
      : shown === 'telemetry'
        ? await telemetryBody($, e)
        : shown === 'diff'
          ? await diffBody($, e)
          : shown === 'office'
            ? await officeBody($, e, String(options.theme ?? 'loft'), options.lowPower === true)
            : shown === 'council'
              ? await councilBody($, e)
              : shown === 'memory'
                ? await memoryBody($, e)
                : shown === 'tickets'
                  ? await ticketsBody($, e)
                  : shown === 'account'
                    ? await accountBody($, e)
                    : shown === 'checkpoint'
                      ? await checkpointBody($, e)
                      : shown === 'config'
                        ? await configBody($, e, options)
                        : await qualityBody($, e, options)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={COL.acc}>✻ </Text>
        <Text color={COL.fg}>Claude Code</Text>
        <Text dimColor>· companyos </Text>
        <Button key="focus" plain onPress={() => update($, focus, f => !f).then(() => {})}>
          <Text {...(isFocused ? { backgroundColor: COL.sage, color: COL.ink } : { color: COL.dim })}> ◉ focus {isFocused ? 'on' : 'off'} </Text>
        </Button>
      </Box>
      <Box flexDirection="row" flexWrap="wrap">
        {TABS.map(([id, hk, label, icon]) => {
          const on = id === shown
          return (
            <Button key={`tab-${id}`} hotkey={hk} plain onPress={() => update($, tab, () => id).then(() => {})}>
              <Text {...(on ? { backgroundColor: COL.acc, color: COL.ink } : { color: '#c0b6a5' })}>
                {' '}
                <Text color={on ? COL.ink : COL.acc}>{hk.toUpperCase()}</Text>
                <Text color={on ? COL.ink : COL.sage}>{icon}</Text> {label}{' '}
              </Text>
              <Text> </Text>
            </Button>
          )
        })}
      </Box>
      {body}
    </Box>
  )
}

async function suggestions($: EngineInterface, draft: string): Promise<string> {
  if (/^(\/ticket|@jira|@linear|@notion) (start|move|done|block) ?$/.test(draft)) return (await tickets($)).map(t => t.key).join('  ') || 'no tickets on the wall'
  const head = draft.split(' ')[0] ?? ''
  if (head.startsWith('@')) {
    const agents = (await $.agent.list()).filter(a => a.status !== 'completed' && a.status !== 'killed').map(a => `@${a.name ?? a.id}`)
    return [...new Set([...AT.slice(0, 1), ...agents, ...AT.slice(1)])].filter(x => x.startsWith(head.toLowerCase())).join('  ')
  }
  if (head.startsWith('/')) return SLASH.filter(x => x.startsWith(head)).join('  ') || 'no match'
  return ''
}

// Low-power mode keeps the office still; set once from the settings when the hub registers.
let isLowPower = false

export function hub(on: On, options: PluginOptions) {
  isLowPower = options.lowPower === true

  on('command.run', { command: 'office' }, async ($, e) => {
    const said = await officeCommand($, e.args, isLowPower)
    const opened = await openHub($, 'office')
    return { text: opened.startsWith('companyos') ? said : opened }
  })

  // `/cos [tab] | diff [revert <id> [hunk]] | config | focus`: the hub, and the names that clash with built-ins.
  on('command.run', { command: 'cos' }, async ($, e) => {
    const [verb = '', a = '', b = '', c] = e.args.trim().split(/\s+/)
    if (verb === 'diff' && a === 'revert') return { text: await revert($, b, c === undefined ? undefined : Number(c) - 1) }
    if (verb === 'focus') {
      const now = await update($, focus, f => !f)
      return { text: `focus ${now ? 'on · routine reads and searches fold to one line' : 'off'}` }
    }
    if (verb === 'gate') return { text: await openHub($, 'quality') }
    return { text: await openHub($, verb || undefined) }
  })

  on('ui.render', { component: 'Pane', requestId: HUB }, ($, e) => hubBody($, e, options))

  // Focus mode folds routine reads and searches to one dim line each.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!ROUTINE.has(e.props.tool) || e.props.isErrored || !(await read($, focus))) return next(e)
    const { Text } = $.ui.resolve(e)
    return (
      <Text dimColor>
        ▸ {e.props.tool} {clip(argOf((e.props.input ?? {}) as object), 80)}
      </Text>
    )
  })

  // Claude Code's own prompt has no completion site: the suggestions go on the hint line beneath it.
  on('prompt.change', async ($, e, next) => {
    const draft = e.text.slice(0, e.cursor)
    const keep = /^[@/]/.test(draft) && draft.split(' ').length <= 3 ? draft : ''
    if (keep !== (await read($, draftToken))) await update($, draftToken, () => keep)
    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const draft = await read($, draftToken)
    if (!e.props.isDraft) return next({ ...e, props: { ...e.props, hint: IDLE_HINT } })
    const found = draft ? await suggestions($, draft) : ''
    return found ? next({ ...e, props: { ...e.props, hint: found } }) : next(e)
  })
}
