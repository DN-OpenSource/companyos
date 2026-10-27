import type { EngineInterface, On, RenderInput } from 'claude-code'

import type { MemoryEntry } from '../types'
import { log, readEvents } from './events'
import { clip, COL, day, meter, tokens } from './util'

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

// Whether this load has handed memory to the model yet. prompt.context does it when it reaches the mod;
// where a plugin above passes that event on, the first prompt carries it instead (router).
// ponytail: module flag, so a reload injects once more; a $.state flag if that ever matters
let isInjected = false

// After /clear the next conversation starts empty: memory goes with its first prompt again.
export function resetMemory() {
  isInjected = false
}

export function needsMemory() {
  return !isInjected
}

// The memory block for the model, marking the chosen entries used; undefined when there is none.
export async function memoryBlock($: EngineInterface): Promise<string | undefined> {
  isInjected = true
  const now = await $.clock.now()
  const chosen = (await visible($)).slice(0, INJECT)
  if (chosen.length === 0) return undefined
  const ids = new Set(chosen.map(m => m.id))
  await $.store.set(KEY, (await entries($)).map(m => (ids.has(m.id) ? { ...m, lastUsed: now } : m)))
  await log($, 'memory', undefined, `injected ${chosen.length} memories`)
  const layers = ((await $.store.get(LAYERS)) as Layer[] | undefined)?.length ?? 0
  $.ui.log(`memory: ${chosen.length} entries given with first prompt${layers ? ` · CLAUDE.md ${layers} layers` : ''}`)
  return ['Long-term memory kept by CompanyOS (facts the person or a council recorded):', ...chosen.map(m => `- ${m.text}`)].join('\n')
}

export async function memoryBody($: EngineInterface, e: RenderInput<'Pane'>) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const [list, usage, layers, now] = await Promise.all([visible($), $.session.usage(), $.store.get(LAYERS) as Promise<Layer[] | undefined>, $.clock.now()])
  const pct = Math.round(usage.context.percent ?? 0)
  const width = e.props.bodyColumns
  const top = Math.max(1, ...(layers ?? []).map(l => l.tokens))
  const home = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:\/Users\/[^/]+|^\/(Users|home)\/[^/]+/, '~')

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={COL.acc}>/mem</Text> <Text dimColor>· repo + global</Text>
      </Text>
      {list.length === 0 && <Text dimColor>Nothing yet. @mem remember we use pnpm, not npm</Text>}
      {list.map(m => (
        <Box flexDirection="row">
          <Text>
            <Text color={m.isPinned ? COL.acc : COL.dim}>{m.isPinned ? '◆' : '·'} </Text>
            <Text color={COL.sage}>{(m.scope === 'global' ? 'global' : 'repo').padEnd(7)}</Text>
            <Text color={now - m.lastUsed > STALE ? COL.accL : COL.fg}>{clip(m.text, Math.max(10, width - 30)).padEnd(Math.min(60, Math.max(10, width - 30)))}</Text>{' '}
          </Text>
          <Button key={`pin-${m.id}`} plain onPress={() => memoryCommand($, `${m.isPinned ? 'unpin' : 'pin'} ${m.id}`).then(() => {})}>
            <Text dimColor>pin </Text>
          </Button>
          <Button key={`forget-${m.id}`} plain onPress={() => memoryCommand($, `forget ${m.id}`).then(() => {})}>
            <Text dimColor>forget</Text>
          </Button>
        </Box>
      ))}
      <Box flexDirection="row">
        <Button key="mem-prune" plain onPress={() => memoryCommand($, 'prune').then(msg => $.ui.toast(msg))}>
          <Text color={COL.fg}>[ prune ] </Text>
        </Button>
        <Button key="mem-export" plain onPress={() => memoryCommand($, 'export').then(text => $.ui.copy({ text }).then(() => $.ui.toast('memories copied as Markdown')))}>
          <Text color={COL.fg}>[ export ]</Text>
        </Button>
        <Text dimColor> · given to Claude with your first prompt</Text>
      </Box>
      <Text color={COL.acc}>CLAUDE.md layers</Text>
      {(layers ?? []).length === 0 && <Text dimColor>  read with the first prompt</Text>}
      {(layers ?? []).map(l => (
        <Text>
          {'  '}
          {clip(home(l.path), 28).padEnd(28)} <Text color={COL.sage}>{'█'.repeat(Math.max(1, Math.round((l.tokens / top) * 5)))}</Text> {tokens(l.tokens)}
        </Text>
      ))}
      <Text>
        <Text dimColor>context </Text>
        <Text color={pct >= 90 ? COL.red : pct >= 70 ? COL.accL : COL.sage}>{meter(pct, 24)}</Text> {pct}%
      </Text>
    </Box>
  )
}

export function memory(on: On) {
  on('command.run', { command: 'mem' }, async ($, e) => ({ text: await memoryCommand($, e.args) }))

  // The elephant reaches the model: chosen entries join the first message's context.
  on('prompt.context', async ($, e, next) => {
    await $.store.set(LAYERS, e.instructionFiles?.map(f => ({ path: f.path, kind: f.kind, tokens: Math.round(f.content.length / 4) })) ?? [])
    const text = await memoryBlock($)
    return text === undefined ? next(e) : next({ ...e, blocks: [...e.blocks, { name: 'companyos-memory', text }] })
  })

  on('ui.render', { component: 'Pane', requestId: MEMORY }, ($, e) => memoryBody($, e))
}
