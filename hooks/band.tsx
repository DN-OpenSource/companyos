import type { On } from 'claude-code'

import { readCouncil } from './council'
import { diffTotals } from './diff'
import { readEvents } from './events'
import { isPlain, plain } from './mode'
import { readGate } from './gate'
import { readPending } from './guard'
import { openHub } from './hub'
import { tickets } from './tickets'
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
    // The band is shared: other mods' part is drawn beneath ours.
    const theirs = await next(e)
    if (e.props.hasSurvey || e.props.maxRows < 1) return theirs

    const { Box, Button, Text } = $.ui.resolve(e)
    const [list, usage, agents, waiting, council, wall, isPlainMode, edits, gate] = await Promise.all([
      readEvents($),
      $.session.usage(),
      $.agent.list(),
      readPending($),
      readCouncil($),
      tickets($),
      isPlain($),
      diffTotals($),
      readGate($),
    ])
    const votes = council?.seats.filter(s => s.vote !== undefined).length ?? 0
    const sitting = council !== null && council.status !== 'verdict' && council.status !== 'failed'
    const needsVerdict = council?.verdict?.needsYou === true && council.status === 'verdict'
    const mine = wall.filter(t => t.status === 'In Progress').length
    const pct = Math.round(usage.context.percent ?? 0)
    const last = [...list].reverse().find(x => x.kind === 'tool_call' || x.kind === 'prompt')
    const live = agents.filter(a => a.status !== 'completed' && a.status !== 'killed').slice(0, 4)
    const action = last ? (isPlainMode ? plain(last) : `${last.agent}: ${last.detail}`) : 'idle'
    const room = Math.max(10, e.props.bodyColumns - 60 - live.length * 4)
    const passed = gate.checks.filter(c => c.status === 'pass').length
    const failed = gate.checks.filter(c => c.status === 'fail').length
    const ran = gate.checks.filter(c => c.status !== 'off').length

    const ours = (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color="claude">◆ </Text>
          {live.map((a, i) => (
            <Button key={`agent-${a.id}`} plain hotkey={String(i + 1)} onPress={() => $.ui.view({ agentId: a.id }).then(() => {})}>
              {GLYPH[a.status] ?? '?'} {(a.name ?? a.type).slice(0, 8)}
            </Button>
          ))}
          <Text color={ctxColor(pct)}> {isPlainMode ? 'memory' : 'ctx'} {pct}%</Text>
          <Text dimColor> · {usd(usage.cost?.usd)} · </Text>
          <Text>{clip(action, room)}</Text>
          {edits.files > 0 && (
            <Text dimColor>
              {' '}· <Text color="diffAdded">+{edits.added}</Text> <Text color="diffRemoved">−{edits.removed}</Text>
            </Text>
          )}
          {waiting > 0 && <Text color="permission"> · ⚑ {waiting}</Text>}
          {ran > 0 && (
            <Button key="gate" plain onPress={() => openHub($, 'quality').then(() => {})}>
              <Text color={failed ? 'error' : 'success'}> gate {passed}/{ran}</Text>
            </Button>
          )}
          {mine > 0 && (
            <Button key="tickets" plain onPress={() => openHub($, 'tickets').then(() => {})}>
              <Text dimColor> ▤ {mine}</Text>
            </Button>
          )}
        </Box>
        {(sitting || needsVerdict) && e.props.maxRows > 1 && (
          <Box flexDirection="row">
            <Button key="council" plain hotkey="5" onPress={() => openHub($, 'council').then(() => {})}>
              <Text color={needsVerdict ? 'warning' : 'suggestion'}>
                ◇ Council {council.size}: {clip(council.question, 50)} · {sitting ? `${votes}/${council.size} votes` : `${council.verdict?.chosen} leads ${council.verdict?.split}, needs you`} · press 5
              </Text>
            </Button>
          </Box>
        )}
      </Box>
    )
    return theirs ? (
      <Box flexDirection="column">
        {ours}
        {theirs}
      </Box>
    ) : (
      ours
    )
  })

  // Spinner suffix: "· 3 tools · 46% context" while Claude works.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const [list, usage] = await Promise.all([readEvents($), $.session.usage()])
    const since = [...list].reverse().findIndex(x => x.kind === 'prompt')
    const tools = (since < 0 ? list : list.slice(list.length - since)).filter(x => x.kind === 'tool_call').length
    const pct = Math.round(usage.context.percent ?? 0)
    return next({ ...e, props: { ...e.props, suffix: `${e.props.suffix} · ${tools} tools · ${pct}% context` } })
  })
}
