import type { On } from 'claude-code'

import { statusLine } from './accounts'
import { flush, log, mark, readEvents } from './events'
import { recordEdit } from './diff'
import { isPlain, plain } from './mode'
import { argOf, clip, skillOf, time, usd } from './util'

export const FEED = 'companyos-feed'
const PANE = FEED

export function feed(on: On, capUsd: number) {
  on('command.run', { command: 'events' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'CompanyOS · events' })
    return { text: opened.isPlaced ? 'Event feed opened.' : `Event feed waits: ${opened.reason}` }
  })

  on('tool.call', async ($, e, next) => {
    const id = await log($, 'tool_call', e.agentId, `${String(e.tool)} ${argOf(e)}`.trim())
    const path = (e as { file_path?: unknown }).file_path
    const isFileEdit = typeof path === 'string' && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(String(e.tool))
    let ran: Awaited<ReturnType<typeof next>> | undefined
    if (isFileEdit) {
      try {
        await recordEdit($, path, e.agentId, async () => {
          ran = await next(e)
          return ran.deny === undefined && ran.isError !== true
        })
      } catch {
        // a failed recording never costs the edit itself
      }
    }
    if (ran === undefined) ran = await next(e)
    await mark($, id, {
      isDone: true,
      isError: ran.deny !== undefined || ran.isError === true,
      tokensOut: Math.round((ran.text?.length ?? 0) / 4),
    })
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
    const ran = await next(e)
    const child = ran.agentId ?? e.subagentType
    await log($, 'delegation', undefined, `${e.subagentType} → ${child}: ${e.description}`, {
      tokensIn: Math.round(e.prompt.length / 4),
    })
    // Multi-agent skill tracing: a skill named in the delegated prompt rides along to the child.
    const skills = new Set((await readEvents($)).filter(x => x.kind === 'skill_load').map(x => skillOf(x.detail)))
    for (const skill of skills) {
      if (e.prompt.includes(skill)) await log($, 'skill_load', child, `${skill} (inherited from lead)`)
    }
    return ran
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
      const ctx = `ctx ${pct === undefined ? '?' : Math.round(pct)}% · ${usd(usage.cost?.usd)}`
      $.ui.status(`CompanyOS · ${ctx}${await statusLine($)}`)
      if (capUsd > 0 && (usage.cost?.usd ?? 0) > capUsd) $.ui.toast(`CompanyOS: session cost ${usd(usage.cost?.usd)} is over the ${usd(capUsd)} cap`)
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
    const [list, isPlainMode] = await Promise.all([readEvents($), isPlain($)])
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 3)
    const width = e.props.bodyColumns

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>No events yet.</Text>}
        {list.slice(-room).map(x => (
          <Text color={x.isError ? 'error' : undefined} dimColor={x.isDone && !x.isError}>
            {clip(isPlainMode ? `${time(x.ts).slice(0, 5)} ${plain(x)}` : `${time(x.ts)} ${x.agent.slice(0, 8).padEnd(8)} ${x.kind.padEnd(10)} ${x.detail}`, width)}
          </Text>
        ))}
      </Box>
    )
  })
}
