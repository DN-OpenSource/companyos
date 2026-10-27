import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderInput } from 'claude-code'

import type { CosEvent } from '../types'
import { statusLine } from './accounts'
import { routeFor, sampleLimits } from './anthropic'
import { flush, log, mark, readEvents } from './events'
import { recordEdit } from './diff'
import { gateAtTurnEnd } from './gate'
import { resetMemory } from './memory'
import { isPlain, plain, setMode } from './mode'
import { argOf, clip, COL, skillOf, time, tokens, usd } from './util'

export const FEED = 'companyos-feed'
const PANE = FEED

// Which agent the events tab shows; empty for all.
const eventAgent = atom({ plugin: 'companyos', key: 'eventAgent' } as const, '')

// The design's names and colours for each kind of event.
const KIND: Partial<Record<CosEvent['kind'], [string, string]>> = {
  prompt: ['prompt', COL.fg],
  memory: ['memory', COL.sage],
  delegation: ['subagent', COL.acc],
  skill_load: ['skill', COL.sage],
  tool_call: ['tool', COL.fg],
  guard: ['guard', COL.red],
  identity: ['guard', COL.red],
  vote: ['vote', COL.accL],
  ticket_update: ['ticket', COL.acc],
  compaction: ['compact', COL.dim],
}

// The technical rendering: what happened, as the event log spells it.
function technical(x: CosEvent): string {
  if (x.kind === 'prompt') return `prompt · ${x.detail.split(/\s+/).length} words`
  if (x.kind === 'delegation') return `Task(${x.detail.split(' ')[0]}) start`
  if (x.kind === 'skill_load') return `skill.load ${x.detail}${x.tokensIn ? ` ${tokens(x.tokensIn)}` : ''}`
  if (x.kind === 'tool_call') return `tool ${x.detail}${x.isError ? ' exit=1' : ''}`
  if (x.kind === 'memory') return `mem.${x.detail.startsWith('injected') ? 'inject' : 'note'} ${x.detail}`
  if (x.kind === 'guard' || x.kind === 'identity') return `guard.${x.isError ? 'blocked' : 'pass'} ${x.detail.replace(/^blocked:?\s*/, '')}`
  if (x.kind === 'vote') return `council ${x.detail}`
  if (x.kind === 'ticket_update') return `ticket.move ${x.detail}`
  if (x.kind === 'compaction') return `compaction ${x.detail}`
  return x.detail
}

export async function eventsBody($: EngineInterface, e: RenderInput<'Pane'>) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const [all, isPlainMode, only] = await Promise.all([readEvents($), isPlain($), read($, eventAgent)])
  const agents = ['', ...new Set(all.map(x => x.agent))]
  const list = all.filter(x => x.kind !== 'turn' && (!only || x.agent === only || x.agent === 'you'))
  const room = Math.max(1, (e.viewport?.rows ?? 24) - 6)
  const width = e.props.bodyColumns
  const pick = (on: boolean) => (on ? { backgroundColor: COL.fg, color: COL.ink } : { color: COL.fg })

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={COL.acc}>/events </Text>
        <Button key="events-agent" hotkey="a" plain onPress={() => update($, eventAgent, a => agents[(agents.indexOf(a) + 1) % agents.length] ?? '').then(() => {})}>
          <Text dimColor>agent: {only || 'all'} </Text>
        </Button>
        <Button key="events-plain" hotkey="p" plain onPress={() => setMode($, 'plain')}>
          <Text {...pick(isPlainMode)}>[ p: plain ]</Text>
        </Button>
        <Text> </Text>
        <Button key="events-tech" hotkey="t" plain onPress={() => setMode($, 'technical')}>
          <Text {...pick(!isPlainMode)}>[ t: technical ]</Text>
        </Button>
      </Box>
      {list.length === 0 && <Text dimColor>No events yet.</Text>}
      {list.slice(-room).map(x => {
        const [kind, color] = KIND[x.kind] ?? [x.kind, COL.fg]
        return (
          <Text>
            <Text color={COL.dim}>{time(x.ts)} </Text>
            <Text color={color}>{kind.padEnd(9)}</Text>
            <Text color={x.isError ? COL.red : COL.fg}>{clip(isPlainMode ? plain(x) : technical(x), Math.max(10, width - 19))}</Text>
          </Text>
        )
      })}
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
