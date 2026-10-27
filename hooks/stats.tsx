import type { EngineInterface, On, RenderInput } from 'claude-code'

import type { CosEvent } from '../types'
import { forecast } from './anthropic'
import { readEvents } from './events'
import { clip, COL, meter, skillOf, tokens, usd } from './util'

export const STATS = 'companyos-stats'

type Row = { name: string; count: number; tokens: number; errors: number }

function tally(list: CosEvent[], kind: CosEvent['kind'], keyOf: (x: CosEvent) => string): Row[] {
  const rows = new Map<string, Row>()
  for (const x of list) {
    if (x.kind !== kind) continue
    const name = keyOf(x)
    const r = rows.get(name) ?? { name, count: 0, tokens: 0, errors: 0 }
    r.count += 1
    r.tokens += (x.tokensIn ?? 0) + (x.tokensOut ?? 0)
    r.errors += x.isError ? 1 : 0
    rows.set(name, r)
  }
  return [...rows.values()].sort((a, b) => b.tokens - a.tokens || b.count - a.count)
}

export async function telemetryBody($: EngineInterface, e: RenderInput<'Pane'>) {
  const { Box, Text } = $.ui.resolve(e)
  const [list, usage, ahead] = await Promise.all([readEvents($), $.session.usage(), forecast($)])
  const pct = Math.round(usage.context.percent ?? 0)
  const turns = list.filter(x => x.kind === 'turn' && x.agent === 'lead')
  const perTurn = turns.length > 1 ? pct / turns.length : 0
  const toCompact = perTurn > 0 ? Math.max(0, Math.floor((95 - pct) / perTurn)) : undefined
  const limit = usage.rateLimits[0]
  const pace = ahead.find(a => limit && a.startsWith(limit.kind))?.match(/hit in (.+)$/)?.[1]

  const byAgent = tally(list, 'turn', x => x.agent)
  const skills = new Map<string, { tokens: number; to: Set<string> }>()
  for (const x of list) {
    if (x.kind !== 'skill_load') continue
    const s = skills.get(skillOf(x.detail)) ?? { tokens: 0, to: new Set<string>() }
    s.tokens += x.tokensIn ?? 0
    s.to.add(x.agent)
    skills.set(skillOf(x.detail), s)
  }
  const heavy = list
    .filter(x => x.kind === 'tool_call' && (x.tokensOut ?? 0) > usage.context.window * 0.02)
    .sort((a, b) => (b.tokensOut ?? 0) - (a.tokensOut ?? 0))
    .slice(0, 3)
  const top = Math.max(1, ...byAgent.map(r => r.tokens))
  const topSkill = Math.max(1, ...[...skills.values()].map(s => s.tokens))
  const call = (detail: string) => detail.replace(/^(\S+) (.*)$/, (_, tool: string, arg: string) => `${tool}(${clip(arg, 30)})`)

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={COL.acc}>Context</Text> <Text color={pct >= 90 ? COL.red : pct >= 70 ? COL.accL : COL.sage}>{meter(pct, 24)}</Text> {pct}%
        {toCompact === undefined ? '' : ` · ~${toCompact} turns until compaction`}
      </Text>
      <Text>
        <Text color={COL.acc}>Cost &amp; rate limits</Text>
        {usd(usage.cost?.usd)} this session
        {limit ? ` · ${limit.kind === 'five_hour' ? '5h' : limit.kind} window ${Math.round(limit.percentUsed)}%` : ''}
        {pace ? ` · limit hit in ~${pace.replace(' minutes', ' min')}` : ''}
      </Text>
      <Text color={COL.acc}>Tokens by agent</Text>
      {byAgent.length === 0 && <Text dimColor>  no turns yet</Text>}
      {byAgent.map(r => (
        <Text>
          {'  '}
          {r.name.slice(0, 10).padEnd(10)}
          <Text color={COL.sage}>{'█'.repeat(Math.max(1, Math.round((r.tokens / top) * 20)))}</Text> {tokens(r.tokens)}
        </Text>
      ))}
      <Text color={COL.acc}>Tokens by skill · passed to subagents</Text>
      {skills.size === 0 && <Text dimColor>  no skill loaded yet</Text>}
      {[...skills].map(([name, s]) => (
        <Text>
          {'  '}
          {name.slice(0, 22).padEnd(22)}
          <Text color={COL.sage}>{'█'.repeat(Math.max(1, Math.round((s.tokens / topSkill) * 6)))}</Text> {tokens(s.tokens)} → {[...s.to].join(', ')}
        </Text>
      ))}
      <Text>
        <Text color={COL.acc}>Oversized tool results</Text>
        {heavy.length === 0 ? <Text dimColor>none</Text> : <Text color={COL.accL}>⚠ {heavy.map(x => `${call(x.detail)} ${tokens(x.tokensOut ?? 0)}${x === heavy[0] ? ' tokens' : ''}`).join(' · ')}</Text>}
      </Text>
      <Text dimColor>/graph agents|skills|files|memory|decisions|cost → Mermaid you can copy</Text>
    </Box>
  )
}

export function stats(on: On) {
  on('command.run', { command: 'telemetry' }, async $ => {
    const opened = await $.ui.open({ id: STATS, title: 'CompanyOS · context, cost, skills' })
    return { text: opened.isPlaced ? 'Stats opened.' : `Stats wait: ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: STATS }, ($, e) => telemetryBody($, e))
}
