import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderInput } from 'claude-code'

import { statusLine } from './accounts'
import { routeFor, sampleLimits } from './anthropic'
import { flush, log, mark, readEvents } from './events'
import { recordEdit } from './diff'
import { gateAtTurnEnd } from './gate'
import { resetMemory } from './memory'
import { isPlain, plain, setMode } from './mode'
import { argOf, clip, skillOf, time, usd } from './util'

export const FEED = 'companyos-feed'
const PANE = FEED

// Which agent the events tab shows; empty for all.
const eventAgent = atom({ plugin: 'companyos', key: 'eventAgent' } as const, '')

export async function eventsBody($: EngineInterface, e: RenderInput<'Pane'>) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const [all, isPlainMode, only] = await Promise.all([readEvents($), isPlain($), read($, eventAgent)])
  const agents = ['', ...new Set(all.map(x => x.agent))]
  const list = only ? all.filter(x => x.agent === only) : all
  const room = Math.max(1, (e.viewport?.rows ?? 24) - 5)
  const width = e.props.bodyColumns

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Button key="events-agent" hotkey="a" plain onPress={() => update($, eventAgent, a => agents[(agents.indexOf(a) + 1) % agents.length] ?? '').then(() => {})}>
          agent: {only || 'all'}{' '}
        </Button>
        <Button key="events-plain" hotkey="p" variant={isPlainMode ? 'primary' : undefined} onPress={() => setMode($, 'plain')}>
          p: plain
        </Button>
        <Button key="events-tech" hotkey="t" variant={isPlainMode ? undefined : 'primary'} onPress={() => setMode($, 'technical')}>
          t: technical
        </Button>
      </Box>
      {list.length === 0 && <Text dimColor>No events yet.</Text>}
      {list.slice(-room).map(x => (
        <Text color={x.isError ? 'error' : undefined} dimColor={x.isDone && !x.isError}>
          {clip(isPlainMode ? `${time(x.ts).slice(0, 5)} ${plain(x)}` : `${time(x.ts)} ${x.agent.slice(0, 8).padEnd(8)} ${x.kind.padEnd(10)} ${x.detail}`, width)}
        </Text>
      ))}
    </Box>
  )
}

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
    // Skill loads also come as Skill tool calls: count one here when skill.prompt never reached the mod.
    if (String(e.tool) === 'Skill' && ran.deny === undefined) {
      const skill = String((e as { skill?: unknown }).skill ?? '')
      const now = await $.clock.now()
      const seen = (await readEvents($)).some(x => x.kind === 'skill_load' && skillOf(x.detail) === skill && now - x.ts < 60_000)
      if (skill && !seen) await log($, 'skill_load', e.agentId, `${skill} (Skill tool)`, { tokensIn: Math.round((ran.text?.length ?? 0) / 4) })
    }
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
    // An agent type the person routed (/anthropic route) runs on that model.
    const routed = e.subagentType === 'fork' ? undefined : await routeFor($, e.subagentType)
    const ran = await next(routed ? { ...e, model: routed } : e)
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
    if (e.agentId === undefined) await sampleLimits($, usage)
    if (e.agentId === undefined && e.reason === 'answer') await gateAtTurnEnd($, (await $.clock.now()) - e.durationMs)
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
    resetMemory()
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => eventsBody($, e))
}
