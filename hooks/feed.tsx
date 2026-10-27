import type { On } from 'claude-code'

import { clip, flush, log, mark, readEvents } from './events'
import { statusLine } from './accounts'

const PANE = 'companyos-feed'
const time = (ts: number) => new Date(ts).toISOString().slice(11, 19)

// The one argument worth a glance, whatever the tool.
function argOf(e: object): string {
  const a = e as Record<string, unknown>
  for (const k of ['command', 'file_path', 'pattern', 'url', 'description', 'prompt', 'query']) {
    if (typeof a[k] === 'string') return a[k] as string
  }
  return ''
}

export function feed(on: On) {
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
      const ctx = `ctx ${pct === undefined ? '?' : Math.round(pct)}% · $${(usage.cost?.usd ?? 0).toFixed(2)}`
      $.ui.status(`CompanyOS · ${ctx}${await statusLine($)}`)
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
    const list = await readEvents($)
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
