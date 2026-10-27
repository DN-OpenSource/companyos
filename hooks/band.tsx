import type { On } from 'claude-code'

import { readCouncil } from './council'
import { diffTotals } from './diff'
import { readEvents } from './events'
import { readGate } from './gate'
import { readPending } from './guard'
import { openHub } from './hub'
import { isPlain, plain } from './mode'
import { tickets } from './tickets'
import { clip, COL, meter, usd } from './util'

// The design's glyph for the lead and the next three agents, and a colour per status.
const GLYPHS = ['◆', '◎', '▲', '✦']
const STATUS: Record<string, string> = {
  running: COL.acc,
  pending: COL.dim,
  waiting: COL.accL,
  idle: COL.sage,
  failed: COL.red,
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
    const pct = Math.round(usage.context.percent ?? 0)
    const since = [...list].reverse().findIndex(x => x.kind === 'prompt')
    const turnTools = (since < 0 ? list : list.slice(list.length - since)).filter(x => x.kind === 'tool_call').length
    const last = [...list].reverse().find(x => x.kind === 'tool_call')
    const leadBusy = last !== undefined && !last.isDone
    const crew = [
      { id: '', name: 'lead', status: e.props.isWorking || leadBusy ? 'running' : 'idle' },
      ...agents
        .filter(a => a.status !== 'completed' && a.status !== 'killed')
        .slice(0, 3)
        .map(a => ({ id: a.id, name: a.name ?? a.type, status: a.status as string })),
    ]
    const action = last ? (isPlainMode ? plain(last) : last.detail) : 'idle'
    const passed = gate.checks.filter(c => c.status === 'pass').length
    const failed = gate.checks.filter(c => c.status === 'fail').length
    const warned = gate.checks.filter(c => c.status === 'warn').length
    const open = wall.filter(t => t.status === 'In Progress' || t.status === 'In Review').length
    const votes = council && council.status !== 'verdict' ? `${council.seats.filter(s => s.vote).length}/${council.size}` : undefined
    const room = Math.max(12, e.props.bodyColumns - 70 - crew.length * 4)

    const ours = (
      <Box flexDirection="row">
        {crew.map((a, i) => (
          <Button key={`agent-${a.id || 'lead'}`} plain hotkey={String(i + 1)} onPress={() => (a.id ? $.ui.view({ agentId: a.id }) : $.ui.view({})).then(() => {})}>
            <Text color={COL.dim}>{i + 1} </Text>
            <Text color={STATUS[a.status] ?? COL.dim}>{GLYPHS[i]} </Text>
            <Text color={COL.fg}>{a.name.slice(0, 8)} </Text>
          </Button>
        ))}
        <Text color={COL.dim}> ctx </Text>
        <Text color={pct >= 90 ? COL.red : pct >= 70 ? COL.accL : COL.sage}>{meter(pct, 6)}</Text>
        <Text color={COL.fg}> {pct}% </Text>
        <Text color={COL.fg}>{usd(usage.cost?.usd)} </Text>
        <Text color={COL.acc}>⏺ </Text>
        <Text color={COL.fg}>{clip(action, room)}</Text>
        {edits.files > 0 && (
          <Text>
            {' '}
            <Text color={COL.sage}>+{edits.added}</Text> <Text color={COL.red}>−{edits.removed}</Text>
          </Text>
        )}
        <Text color={COL.dim}> ·{turnTools} </Text>
        {waiting > 0 && (
          <Text backgroundColor="#d67f48" color={COL.ink}>
            {' '}⚑ {waiting}{' '}
          </Text>
        )}
        {votes && <Text color={COL.accL}> {votes} </Text>}
        {gate.checks.length > 0 && (
          <Button key="gate" plain onPress={() => openHub($, 'quality').then(() => {})}>
            <Text backgroundColor={failed ? COL.red : warned ? COL.accL : COL.sage} color={COL.ink}>
              {' '}gate {passed}/{gate.checks.length}{' '}
            </Text>
          </Button>
        )}
        {open > 0 && (
          <Button key="tickets" plain onPress={() => openHub($, 'tickets').then(() => {})}>
            <Text color={COL.dim}> ▤ {open} tickets</Text>
          </Button>
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
