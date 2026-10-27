import type { EngineInterface, On } from 'claude-code'

import type { MemoryEntry } from '../types'
import { log, readEvents } from './events'
import { clip, ctxColor, day, meter, tokens } from './util'

export const MEMORY = 'companyos-memory'
const KEY = 'memory/entries'
const LAYERS = 'memory/layers'
const STALE = 60 * 24 * 3600_000
const INJECT = 20

type Layer = { path: string; kind: string; tokens: number }

export async function entries($: EngineInterface): Promise<MemoryEntry[]> {
  return ((await $.store.get(KEY)) as MemoryEntry[] | undefined) ?? []
}

async function save($: EngineInterface, list: MemoryEntry[]) {
  await $.store.set(KEY, list)
  $.ui.invalidate('ui.render')
}

async function scopeOf($: EngineInterface) {
  return (await $.session.repo())?.root ?? 'global'
}

// Entries this repo sees: its own and the global ones, unexpired, pinned first.
async function visible($: EngineInterface) {
  const [list, scope, now] = await Promise.all([entries($), scopeOf($), $.clock.now()])
  return list
    .filter(m => (m.scope === 'global' || m.scope === scope) && (m.expires === undefined || m.expires > now))
    .sort((a, b) => Number(!!b.isPinned) - Number(!!a.isPinned) || b.ts - a.ts)
}

export async function remember($: EngineInterface, text: string, source: MemoryEntry['source'], isGlobal = false) {
  const now = await $.clock.now()
  const list = await entries($)
  const same = list.find(m => m.text.toLowerCase() === text.toLowerCase())
  if (same !== undefined) return `Already remembered (#${same.id}).`
  const entry: MemoryEntry = {
    id: now.toString(36).slice(-5),
    text,
    source,
    scope: isGlobal ? 'global' : await scopeOf($),
    ts: now,
    lastUsed: now,
  }
  await save($, [...list, entry])
  await log($, 'memory', undefined, `remembered: ${text}`)
  return `Remembered #${entry.id}${isGlobal ? ' (global)' : ''}: ${text}`
}

// `/mem` and `@mem`: remember [--global] <text> | forget <id> | pin <id> | unpin <id> | list
export async function memoryCommand($: EngineInterface, args: string): Promise<string> {
  const [verb = 'list', ...rest] = args.trim().split(/\s+/)
  const arg = rest.join(' ')
  const list = await entries($)

  if (verb === 'remember' && arg) {
    const isGlobal = arg.startsWith('--global ')
    return remember($, isGlobal ? arg.slice(9) : arg, 'you', isGlobal)
  }
  if (verb === 'forget' || verb === 'pin' || verb === 'unpin') {
    const hit = list.find(m => m.id === arg)
    if (hit === undefined) return `No memory #${arg}.`
    await save(
      $,
      verb === 'forget'
        ? list.filter(m => m !== hit)
        : list.map(m => (m === hit ? { ...m, isPinned: verb === 'pin' } : m)),
    )
    await log($, 'memory', undefined, `${verb} #${arg}: ${hit.text}`)
    return `${verb === 'forget' ? 'Forgot' : verb === 'pin' ? 'Pinned' : 'Unpinned'} #${arg}.`
  }
  if (verb === 'prune') {
    const now = await $.clock.now()
    const kept = list.filter(m => m.isPinned || now - m.lastUsed < STALE)
    await save($, kept)
    return `Pruned ${list.length - kept.length} stale memories.`
  }
  if (verb === 'export') {
    return (await visible($)).map(m => `- ${m.text} _(${m.source}, ${day(m.ts)}${m.isPinned ? ', pinned' : ''})_`).join('\n') || 'Nothing to export.'
  }
  await $.ui.open({ id: MEMORY, title: 'CompanyOS · memory' })
  return `${(await visible($)).length} memories here. Usage: remember [--global] <text> | forget <id> | pin <id> | prune | export`
}

export function memory(on: On) {
  on('command.run', { command: 'mem' }, async ($, e) => ({ text: await memoryCommand($, e.args) }))

  // The elephant reaches the model: chosen entries join the first message's context.
  on('prompt.context', async ($, e, next) => {
    const now = await $.clock.now()
    const chosen = (await visible($)).slice(0, INJECT)
    await $.store.set(LAYERS, e.instructionFiles?.map(f => ({ path: f.path, kind: f.kind, tokens: Math.round(f.content.length / 4) })) ?? [])
    if (chosen.length === 0) return next(e)

    const ids = new Set(chosen.map(m => m.id))
    await $.store.set(KEY, (await entries($)).map(m => (ids.has(m.id) ? { ...m, lastUsed: now } : m)))
    await log($, 'memory', undefined, `injected ${chosen.length} memories`)
    const text = ['Long-term memory kept by CompanyOS (facts the person or a council recorded):', ...chosen.map(m => `- ${m.text}`)].join('\n')
    return next({ ...e, blocks: [...e.blocks, { name: 'companyos-memory', text }] })
  })

  on('ui.render', { component: 'Pane', requestId: MEMORY }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const [list, usage, layers, evts, now] = await Promise.all([
      visible($),
      $.session.usage(),
      $.store.get(LAYERS) as Promise<Layer[] | undefined>,
      readEvents($),
      $.clock.now(),
    ])
    const pct = usage.context.percent ?? 0
    const lastCompact = [...evts].reverse().find(x => x.kind === 'compaction')
    const width = e.props.bodyColumns

    return (
      <Box flexDirection="column">
        <Text bold>🐘 Elephant · {list.length} memories</Text>
        {list.length === 0 && <Text dimColor>Nothing yet. @mem remember we use pnpm, not npm</Text>}
        {list.map(m => (
          <Box flexDirection="row">
            <Button key={`pin-${m.id}`} plain onPress={() => memoryCommand($, `${m.isPinned ? 'unpin' : 'pin'} ${m.id}`).then(() => {})}>
              {m.isPinned ? '📌' : '·'}
            </Button>
            <Text color={now - m.lastUsed > STALE ? 'warning' : undefined}>
              {' '}#{m.id} {clip(m.text, width - 30)} <Text dimColor>{m.source} {day(m.ts)}{m.scope === 'global' ? ' global' : ''}</Text>{' '}
            </Text>
            <Button key={`forget-${m.id}`} plain onPress={() => memoryCommand($, `forget ${m.id}`).then(() => {})}>
              ✗
            </Button>
          </Box>
        ))}
        <Text> </Text>
        <Text bold>CLAUDE.md layers</Text>
        {(layers ?? []).map(l => (
          <Text dimColor>
            {tokens(l.tokens).padStart(6)} tok {l.kind.padEnd(8)} {clip(l.path, width - 22)}
          </Text>
        ))}
        <Text> </Text>
        <Text bold>🐟 Goldfish · context window</Text>
        <Text color={ctxColor(pct)}>
          {meter(pct, 20)} {Math.round(pct)}%
        </Text>
        <Text dimColor>{lastCompact ? `Last forgot: ${lastCompact.detail}` : 'Has not forgotten anything yet.'}</Text>
      </Box>
    )
  })
}
