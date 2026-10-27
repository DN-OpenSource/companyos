import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CosEvent, EventKind } from '../types'

const PANE = 'companyos-feed'
const MAX = 500
// Change the tag when CosEvent's fields change.
const events = atom({ plugin: 'companyos', key: 'events' } as const, [], {
  shape: 'events-1',
})

const clip = (s: string, n = 160) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const time = (ts: number) => new Date(ts).toISOString().slice(11, 19)

async function log(
  $: EngineInterface,
  kind: EventKind,
  agent: string | undefined,
  detail: string,
  extra: Partial<CosEvent> = {},
): Promise<string> {
  const ts = await $.clock.now()
  const id = `evt_${ts.toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const evt: CosEvent = { id, ts, agent: agent ?? 'lead', kind, detail: clip(detail), ...extra }
  await update($, events, list => [...list, evt].slice(-MAX))
  return id
}

const mark = ($: EngineInterface, id: string, patch: Partial<CosEvent>) =>
  update($, events, list => list.map(x => (x.id === id ? { ...x, ...patch } : x)))

// The one argument worth a glance, whatever the tool.
function argOf(e: object): string {
  const a = e as Record<string, unknown>
  for (const k of ['command', 'file_path', 'pattern', 'url', 'description', 'prompt', 'query']) {
    if (typeof a[k] === 'string') return a[k] as string
  }
  return ''
}

async function flush($: EngineInterface) {
  // ponytail: one key per session, overwritten; daily roll-ups when $.store nears 4 MiB
  await $.store.set(`events/${await $.session.id()}`, await read($, events))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'events', description: 'CompanyOS: show the live event feed' })
    return next(e)
  })

  on('command.run', { command: 'events' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'CompanyOS · events' })
    return { text: opened.isPlaced ? 'Event feed opened.' : `Event feed waits: ${opened.reason}` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!e.isMeta) await log($, 'prompt', undefined, e.text.replace(/\s+/g, ' '))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const id = await log($, 'tool_call', e.agentId, `${String(e.tool)} ${argOf(e)}`.trim())
    const ran = await next(e)
    await mark($, id, { isDone: true, isError: ran.deny !== undefined || ran.isError === true })
    return ran
  })

  on('skill.prompt', async ($, e, next) => {
    const source = typeof e.source === 'string' ? e.source : JSON.stringify(e.source)
    await log($, 'skill_load', undefined, `${e.skill} (${source})`, {
      tokensIn: Math.round(e.text.length / 4),
    })
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    await log($, 'delegation', undefined, `${e.subagentType}: ${e.description}`)
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    await log($, 'compaction', e.agentId, `${e.trigger}, ${e.messages.length} messages`)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const usage = await $.session.usage()
    await log($, 'turn', e.agentId, `${e.reason} in ${Math.round(e.durationMs / 1000)}s`, {
      isDone: true,
      isError: e.reason === 'error',
      tokensIn: e.usage?.input_tokens,
      tokensOut: e.usage?.output_tokens,
      cost: usage.cost?.usd,
    })
    if (e.agentId === undefined) {
      const pct = usage.context.percent
      $.ui.status(
        `CompanyOS · ctx ${pct === undefined ? '?' : Math.round(pct)}% · $${(usage.cost?.usd ?? 0).toFixed(2)}`,
      )
      await flush($)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await flush($)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, events)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 3)
    const width = e.props.bodyColumns

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>No events yet.</Text>}
        {list.slice(-room).map(x => (
          <Text color={x.isError ? 'error' : undefined} dimColor={x.isDone && !x.isError}>
            {clip(`${time(x.ts)} ${x.agent.slice(0, 8).padEnd(8)} ${x.kind.padEnd(10)} ${x.detail}`, width)}
          </Text>
        ))}
      </Box>
    )
  })
}
