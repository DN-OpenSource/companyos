import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions, RenderInput } from 'claude-code'

import { accountSummary } from './accounts'
import { anthropicSummary } from './anthropic'
import { councilBody } from './council'
import { diffBody, revert } from './diff'
import { eventsBody } from './feed'
import { qualityBody } from './gate'
import { memoryBody } from './memory'
import { officeBody } from './office'
import { checkpoints, restore } from './sessions'
import { telemetryBody } from './stats'
import { tickets, ticketsBody } from './tickets'
import { argOf, clip } from './util'

export const HUB = 'companyos'
const TABS: [string, string, string][] = [
  ['events', '1', 'Events'],
  ['telemetry', '2', 'Telemetry'],
  ['diff', '3', 'Diff'],
  ['office', '4', 'Office'],
  ['council', '5', 'Council'],
  ['memory', '6', 'Memory'],
  ['tickets', '7', 'Tickets'],
  ['account', '8', 'Account'],
  ['checkpoint', '9', 'Checkpoints'],
  ['config', '0', 'Config'],
  ['quality', 'q', 'Quality'],
]
const ROUTINE = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'TodoWrite', 'ToolSearch'])
const PREFIXES = ['@lead', '@all', '@council', '@mem', '@jira', '@notion', '@linear', '@gh', '@office']
const COMMANDS = ['/cos', '/events', '/telemetry', '/graph', '/office', '/council', '/mem', '/ticket', '/account', '/anthropic', '/checkpoint', '/gate', '/mode', '/daily', '/report', '/replay', '/handover']

const tab = atom({ plugin: 'companyos', key: 'tab' } as const, 'events')
const focus = atom({ plugin: 'companyos', key: 'focus' } as const, false)
// The word being typed in the prompt, so the hint line can suggest how to finish it.
const draftToken = atom({ plugin: 'companyos', key: 'draftToken' } as const, '')

export async function openHub($: EngineInterface, to?: string): Promise<string> {
  if (to && TABS.some(t => t[0] === to)) await update($, tab, () => to)
  const opened = await $.ui.open({ id: HUB, title: 'CompanyOS' })
  return opened.isPlaced ? `CompanyOS · ${to || (await read($, tab))}` : `CompanyOS waits: ${opened.reason}`
}

async function accountBody($: EngineInterface, e: RenderInput<'Pane'>) {
  const { Box, Text } = $.ui.resolve(e)
  const [gh, claude] = await Promise.all([accountSummary($), anthropicSummary($)])
  return (
    <Box flexDirection="column">
      <Text bold>/account</Text>
      {gh.split('\n').map(l => (
        <Text>{l}</Text>
      ))}
      <Text dimColor>A commit or push under the wrong account is blocked, with the fix in the message.</Text>
      <Text> </Text>
      <Text bold>/anthropic</Text>
      {claude.split('\n').map(l => (
        <Text>{l}</Text>
      ))}
    </Box>
  )
}

async function checkpointBody($: EngineInterface, e: RenderInput<'Pane'>) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const root = (await $.session.repo())?.root
  const list = root ? [...(await checkpoints($, root))].reverse() : []
  return (
    <Box flexDirection="column">
      <Text bold>/checkpoint list</Text>
      {root === undefined && <Text dimColor>Checkpoints need a git repository.</Text>}
      {root !== undefined && list.length === 0 && <Text dimColor>No checkpoints yet. /checkpoint [label]</Text>}
      {list.map(c => (
        <Box flexDirection="row">
          <Text>
            #{c.id} {new Date(c.ts).toTimeString().slice(0, 5)} {c.sha.slice(0, 8)} {clip(c.label, Math.max(10, e.props.bodyColumns - 40))}{' '}
          </Text>
          <Button key={`restore-${c.id}`} plain onPress={() => restore($, c.id).then(msg => $.ui.toast(msg))}>
            restore
          </Button>
        </Box>
      ))}
      <Text dimColor>Snapshots the whole workspace, not only Claude's edits, and doesn't touch your files. Restore asks for a yes.</Text>
    </Box>
  )
}

async function configBody($: EngineInterface, e: RenderInput<'Pane'>, options: PluginOptions) {
  const { Box, Text } = $.ui.resolve(e)
  const keys = ['protectedPaths', 'costCapUsd', 'theme', 'lowPower', 'webhookUrl', 'gateModes', 'gateTests', 'gateTypes', 'gateLint', 'gateCoverage', 'gateCoverageTarget']
  return (
    <Box flexDirection="column">
      <Text bold>/cos config</Text>
      {keys.map(k => (
        <Text>
          {k.padEnd(20)} <Text color="suggestion">{JSON.stringify(options[k] ?? '')}</Text>
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
        {TABS.map(([id, hk, label]) => (
          <Button key={`tab-${id}`} hotkey={hk} {...(id !== shown ? { plain: true as const } : {})} variant={id === shown ? 'primary' : undefined} onPress={() => update($, tab, () => id).then(() => {})}>
            {label}
          </Button>
        ))}
        <Button key="focus" plain onPress={() => update($, focus, f => !f).then(() => {})}>
          {isFocused ? ' ◉ focus on' : ' ○ focus off'}
        </Button>
      </Box>
      <Text dimColor>{'─'.repeat(Math.max(10, e.props.bodyColumns - 2))}</Text>
      {body}
    </Box>
  )
}

async function suggestions($: EngineInterface, token: string): Promise<string[]> {
  if (token.startsWith('@')) {
    const agents = (await $.agent.list()).filter(a => a.status !== 'completed' && a.status !== 'killed').map(a => `@${a.name ?? a.id}`)
    return [...PREFIXES, ...agents].filter(x => x.startsWith(token.toLowerCase()) && x !== token)
  }
  if (token.startsWith('/')) return COMMANDS.filter(x => x.startsWith(token) && x !== token)
  if (/^[A-Z][A-Z0-9]*-\d*$/.test(token)) return (await tickets($)).map(t => t.key).filter(k => k.startsWith(token) && k !== token)
  return []
}

export function hub(on: On, options: PluginOptions) {
  // `/cos [tab] | diff [revert <id> [hunk]] | config | focus`: the hub, and the names that clash with built-ins.
  on('command.run', { command: 'cos' }, async ($, e) => {
    const [verb = '', a = '', b = '', c] = e.args.trim().split(/\s+/)
    if (verb === 'diff' && a === 'revert') return { text: await revert($, b, c === undefined ? undefined : Number(c) - 1) }
    if (verb === 'focus') {
      const now = await update($, focus, f => !f)
      return { text: `Focus ${now ? 'on: routine reads and searches fold to one line' : 'off'}.` }
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
    const token = e.text.slice(0, e.cursor).split(/\s/).pop() ?? ''
    const keep = token.startsWith('@') || token.startsWith('/') || /^[A-Z][A-Z0-9]*-\d*$/.test(token) ? token : ''
    if (keep !== (await read($, draftToken))) await update($, draftToken, () => keep)
    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const token = await read($, draftToken)
    if (!e.props.isDraft || !token) return next(e)
    const found = (await suggestions($, token)).slice(0, 6)
    const shell = token === '/' ? ' · ! runs a shell line (so does $ …)' : ''
    return found.length ? next({ ...e, props: { ...e.props, hint: `${found.join('  ')}${shell}` } }) : next(e)
  })
}
