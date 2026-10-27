import type { On } from 'claude-code'

import { readCouncil } from './council'
import { readEvents } from './events'
import { isPlain, plain } from './mode'
import { readPending } from './guard'
import { STATS } from './stats'
import { TICKETS, tickets } from './tickets'
import { clip, ctxColor, usd } from './util'

const GLYPH: Record<string, string> = {
  pending: '·',
  running: '●',
  waiting: '◐',
  idle: '○',
  completed: '✓',
  failed: '✗',
  killed: '✗',
}

export function band(on: On) {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.maxRows < 1) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const [list, usage, agents, waiting, council, wall, isPlainMode] = await Promise.all([
      readEvents($),
      $.session.usage(),
      $.agent.list(),
      readPending($),
      readCouncil($),
      tickets($),
      isPlain($),
    ])
    const votes = council?.seats.filter(s => s.vote !== undefined).length ?? 0
    const sitting = council !== null && council.status !== 'verdict' && council.status !== 'failed'
    const mine = wall.filter(t => t.status === 'In Progress').length
    const pct = Math.round(usage.context.percent ?? 0)
    const last = [...list].reverse().find(x => x.kind === 'tool_call' || x.kind === 'prompt')
    const live = agents.filter(a => a.status !== 'completed' && a.status !== 'killed').slice(0, 8)
    const action = last ? (isPlainMode ? plain(last) : `${last.agent}: ${last.detail}`) : 'idle'
    const room = Math.max(10, e.props.bodyColumns - 40 - live.length * 2)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color="claude">◆ </Text>
          {live.map(a => (
            <Button key={`agent-${a.id}`} plain onPress={() => $.ui.view({ agentId: a.id }).then(() => {})}>
              {GLYPH[a.status] ?? '?'}
            </Button>
          ))}
          <Text color={ctxColor(pct)}> {isPlainMode ? 'memory' : 'ctx'} {pct}%</Text>
          <Text dimColor> · {usd(usage.cost?.usd)} · </Text>
          <Text>{clip(action, room)}</Text>
          {waiting > 0 && <Text color="permission"> · ⚠ {waiting} waiting on you</Text>}
          {sitting && (
            <Text color="suggestion">
              {' '}· council {council.size} in session · {votes}/{council.size} votes
            </Text>
          )}
          {council?.verdict?.needsYou && council.status === 'verdict' && <Text color="warning"> · council needs you (/council)</Text>}
        </Box>
        {e.props.isWorking && e.props.maxRows > 1 && (
          <Box flexDirection="row">
            <Button key="stats" plain onPress={() => $.ui.open({ id: STATS, title: 'CompanyOS · context, cost, skills' }).then(() => {})}>
              stats
            </Button>
            <Text dimColor> · {list.filter(x => x.kind === 'tool_call' && !x.isDone).length} tools running · </Text>
            <Button key="tickets" plain onPress={() => $.ui.open({ id: TICKETS, title: 'CompanyOS · ticket wall' }).then(() => {})}>
              {mine} tickets in progress
            </Button>
          </Box>
        )}
      </Box>
    )
  })
}
