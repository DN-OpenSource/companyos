import type { On } from 'claude-code'

import type { CosEvent } from '../types'
import { readEvents } from './events'
import { ctxColor, meter, skillOf, tokens, usd } from './util'

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

export function stats(on: On) {
  on('command.run', { command: 'stats' }, async $ => {
    const opened = await $.ui.open({ id: STATS, title: 'CompanyOS · context, cost, skills' })
    return { text: opened.isPlaced ? 'Stats opened.' : `Stats wait: ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: STATS }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const [list, usage, agents] = await Promise.all([readEvents($), $.session.usage(), $.agent.list()])
    const pct = usage.context.percent ?? 0
    const turns = list.filter(x => x.kind === 'turn' && x.agent === 'lead')
    const perTurn = turns.length > 1 ? pct / turns.length : 0
    const toCompact = perTurn > 0 ? Math.max(0, Math.floor((95 - pct) / perTurn)) : undefined

    const byAgent = tally(list, 'turn', x => x.agent)
    const bySkill = tally(list, 'skill_load', x => skillOf(x.detail))
    const heavy = list
      .filter(x => x.kind === 'tool_call' && (x.tokensOut ?? 0) > usage.context.window * 0.05)
      .slice(-5)
    const compactions = list.filter(x => x.kind === 'compaction')

    return (
      <Box flexDirection="column">
        <Text bold>Context</Text>
        <Text color={ctxColor(pct)}>
          {meter(pct, 20)} {Math.round(pct)}% of {tokens(usage.context.window)}
          {toCompact === undefined ? '' : ` · ~${toCompact} turns to compaction`}
        </Text>
        <Text> </Text>
        <Text bold>Cost</Text>
        <Text>Session {usd(usage.cost?.usd)}</Text>
        {usage.rateLimits.map(r => (
          <Text color={ctxColor(r.percentUsed)}>
            {r.kind.padEnd(10)} {meter(r.percentUsed)} {Math.round(r.percentUsed)}%{r.resetsAt ? ` · resets ${r.resetsAt}` : ''}
          </Text>
        ))}
        <Text> </Text>
        <Text bold>Agents</Text>
        {agents.length === 0 && byAgent.length === 0 && <Text dimColor>Only the lead so far.</Text>}
        {byAgent.map(r => (
          <Text>
            {r.name.slice(0, 16).padEnd(16)} {String(r.count).padStart(3)} turns {tokens(r.tokens).padStart(7)} tok
          </Text>
        ))}
        {agents.map(a => (
          <Text dimColor>
            {(a.name ?? a.id).slice(0, 16).padEnd(16)} {a.status.padEnd(9)} {a.type}: {a.description}
          </Text>
        ))}
        <Text> </Text>
        <Text bold>Skills</Text>
        {bySkill.length === 0 && <Text dimColor>No skill loaded yet.</Text>}
        {bySkill.map(r => (
          <Text>
            {r.name.slice(0, 28).padEnd(28)} {String(r.count).padStart(3)}× {tokens(r.tokens).padStart(7)} tok
          </Text>
        ))}
        <Text> </Text>
        <Text bold>Diagnostics</Text>
        <Text dimColor>
          {compactions.length} compactions · {heavy.length} tool results over 5% of the window
        </Text>
        {heavy.map(x => (
          <Text color="warning">
            {tokens(x.tokensOut ?? 0).padStart(7)} {x.detail}
          </Text>
        ))}
      </Box>
    )
  })
}
