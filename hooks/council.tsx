import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderInput } from 'claude-code'

import type { Council, Seat, Verdict } from '../types'
import { log } from './events'
import { remember } from './memory'
import { clip, COL } from './util'

export const COUNCIL = 'companyos-council'
const LETTERS = 'ABCDEFGH'
const MAX_TOKENS = 600
const VETO_ROLES = ['security', 'ops']

// The design's seats: three, six or nine, each a lens on the question.
const ROLES: Record<number, string[]> = {
  3: ['security', 'ops', 'performance'],
  6: ['security', 'ops', 'performance', 'cost', 'product', 'data'],
  9: ['security', 'ops', 'performance', 'cost', 'product', 'data', 'qa', 'frontend', 'legal'],
}

const PERSONA: Record<string, string> = {
  security: 'You look for secrets, injection, data exposure and least-privilege breaks. You may vote "veto".',
  ops: 'You weigh deploy risk, rollback, running cost of services and observability. You may vote "veto"; an irreversible option needs a rollback plan.',
  performance: 'You weigh latency, throughput and load on hot paths.',
  cost: 'You weigh what each option costs to build and to run.',
  product: 'You weigh user value, scope and deadlines.',
  data: 'You weigh data consistency, reporting and migrations.',
  qa: 'You ask how each option is tested and what could regress.',
  frontend: 'You weigh what the user sees: speed, states and errors.',
  legal: 'You weigh retention, privacy and licensing rules.',
}

const council = atom({ plugin: 'companyos', key: 'council' } as const, null)

export async function readCouncil($: EngineInterface): Promise<Council | null> {
  return read($, council)
}

// "should we X? A) foo B) bar" or "foo or bar?" → options; else yes/no.
export function parseOptions(question: string): { question: string; options: string[] } {
  const lettered = question.split(/\s+[A-H]\)\s+/)
  if (lettered.length > 2) return { question: lettered[0]!.trim(), options: lettered.slice(1).map(s => s.trim()) }
  return { question: question.trim(), options: ['yes', 'no'] }
}

function brief(c: Council, role: string, others?: Seat[]) {
  const opts = c.options.map((o, i) => `${LETTERS[i]}) ${o}`).join('\n')
  const second = others
    ? `\n\nRound two. The other members answered:\n${others.map(s => `- ${s.role}: ${s.vote} (${s.confidence}) ${s.reason ?? ''}${s.change ? ` Change: ${s.change}` : ''}`).join('\n')}\nYou may change your vote or merge suggestions.`
    : ''
  return [
    `You sit on a council of ${c.size} as the ${role}. ${PERSONA[role] ?? ''}`,
    `Question: ${c.question}`,
    `Options:\n${opts}`,
    second,
    `Answer with JSON only: {"vote": "<letter>|abstain${VETO_ROLES.includes(role) ? '|veto' : ''}", "confidence": 0..1, "reason": "<one paragraph>", "change": "<suggested change or empty>"}`,
  ].join('\n\n')
}

function parseSeat(role: string, text: string, size: number): Seat {
  try {
    const j = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as Partial<Seat>
    const vote = String(j.vote ?? 'abstain').trim()
    const isValid = vote === 'abstain' || (vote === 'veto' && VETO_ROLES.includes(role)) || LETTERS.slice(0, size).includes(vote.toUpperCase())
    return {
      role,
      vote: isValid ? (vote.length === 1 ? vote.toUpperCase() : vote) : 'abstain',
      confidence: Math.max(0, Math.min(1, Number(j.confidence ?? 0.5))),
      reason: clip(String(j.reason ?? ''), 400),
      change: j.change ? clip(String(j.change), 200) : undefined,
    }
  } catch {
    return { role, vote: 'abstain', confidence: 0, reason: 'answered no JSON' }
  }
}

async function ask1($: EngineInterface, c: Council, role: string, others?: Seat[]): Promise<{ seat: Seat; tokens: number }> {
  const prompt = brief(c, role, others)
  const r = await $.model.complete({ model: await $.session.model(), prompt, maxTokens: MAX_TOKENS })
  const used = r.usage.input_tokens + r.usage.output_tokens
  return r.isAnswered ? { seat: parseSeat(role, r.text, c.options.length), tokens: used } : { seat: { role, vote: 'abstain', confidence: 0, reason: `no answer (${r.reason})` }, tokens: used }
}

export function tally(c: Council): Verdict {
  const counts = new Map<string, number>()
  for (const s of c.seats) if (s.vote && LETTERS.includes(s.vote)) counts.set(s.vote, (counts.get(s.vote) ?? 0) + 1)
  const ranked = [...counts].sort((a, b) => b[1] - a[1])
  const veto = c.seats.find(s => s.vote === 'veto')
  const [top, second] = ranked
  const isTie = top !== undefined && second !== undefined && top[1] === second[1]
  const letter = isTie ? undefined : top?.[0]
  const option = letter ? c.options[LETTERS.indexOf(letter)] : undefined
  const votes = c.seats.filter(s => s.vote && LETTERS.includes(s.vote)).length
  const forTop = letter ? (counts.get(letter) ?? 0) : 0
  const split = `${forTop}–${votes - forTop}`
  const confidence = c.seats.reduce((n, s) => n + (s.confidence ?? 0), 0) / Math.max(1, c.seats.length)
  const changes = [...new Set(c.seats.map(s => s.change).filter((x): x is string => !!x))]
  const dissent = c.seats.filter(s => s.vote !== letter && s.vote !== 'abstain').map(s => `${s.role}: ${s.reason ?? s.vote}`)
  const needsYou = veto !== undefined || option === undefined || isTie || confidence < 0.6 || (c.size > 3 && forTop - (votes - forTop) <= 1)
  const chosen = veto ? 'blocked' : (option ?? 'escalated')
  const plain = veto
    ? `The ${veto.role} member blocked this: ${veto.reason ?? 'no reason given'}`
    : option
      ? `The team chose "${option}", ${forTop} votes to ${votes - forTop}${changes.length ? `; suggested: ${changes[0]}` : ''}${needsYou ? '. They want you to confirm.' : '.'}`
      : 'The team could not agree; it is your call.'
  return { chosen, split, dissent, changes, vetoedBy: veto?.role, needsYou, plain }
}

// Runs a whole council and resolves its verdict; the pane and band follow along.
export async function convene($: EngineInterface, size: number, text: string): Promise<Verdict> {
  const { question, options } = parseOptions(text)
  const roles = ROLES[size] ?? ROLES[3]!
  const id = (await $.clock.now()).toString(36)
  let c: Council = { id, question, options, size: roles.length, status: 'round 1', seats: roles.map(role => ({ role })), tokens: 0 }
  await update($, council, () => c)
  await log($, 'vote', undefined, `council of ${c.size} convened: ${question}`)

  const one = await Promise.all(roles.map(role => ask1($, c, role)))
  c = { ...c, status: 'round 2', seats: one.map(x => x.seat), tokens: one.reduce((n, x) => n + x.tokens, 0) }
  await update($, council, () => c)

  const two = await Promise.all(roles.map((role, i) => ask1($, c, role, c.seats.filter((_, j) => j !== i))))
  c = { ...c, seats: two.map(x => x.seat), tokens: c.tokens + two.reduce((n, x) => n + x.tokens, 0) }
  const verdict = tally(c)
  c = { ...c, status: 'verdict', verdict }
  await update($, council, () => c)

  await $.store.set(`decisions/${id}`, { question, options, size: c.size, chosen: verdict.chosen, split: verdict.split, seats: c.seats, verdict, ts: await $.clock.now() })
  await remember($, `Council of ${c.size} on "${clip(question, 120)}": ${verdict.chosen} (${verdict.split})`, 'council')
  await log($, 'vote', undefined, `verdict ${verdict.chosen} ${verdict.split}${verdict.vetoedBy ? ` vetoed by ${verdict.vetoedBy}` : ''}`, {
    isDone: true,
    isError: verdict.needsYou,
    tokensIn: c.tokens,
  })
  $.ui.toast(`council verdict in · ${verdict.chosen} ${verdict.split}`)
  if (verdict.needsYou) {
    const number = (await $.store.keys()).filter(k => k.startsWith('decisions/')).length
    const lead = verdict.chosen === 'blocked' ? `blocked by ${verdict.vetoedBy}` : `${LETTERS[options.indexOf(verdict.chosen)] ?? '?'} leads ${verdict.split}`
    $.ui.log(`◇ Council #${number} needs a verdict · ${lead}
  ${clip(question, 80)} · press 5 to open`)
  }
  return verdict
}

export async function councilBody($: EngineInterface, e: RenderInput<'Pane'>) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const c = await read($, council)
  const decided = (await $.store.keys()).filter(k => k.startsWith('decisions/')).length
  if (c === null) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No council yet. /council 3 should we … A) … B) …</Text>
        <Text dimColor>Every verdict goes into the decision log.</Text>
      </Box>
    )
  }
  const v = c.verdict
  const number = decided + (v ? 0 : 1)
  const width = e.props.bodyColumns
  const round = c.status === 'round 1' ? 1 : 2
  const pick = (on: boolean) => (on ? { backgroundColor: COL.fg, color: COL.ink } : { color: COL.fg })
  const winner = v ? LETTERS[c.options.indexOf(v.chosen)] : undefined
  const asArgs = (n: number) => `${n} ${c.question} ${c.options.map((o, i) => `${LETTERS[i]}) ${o}`).join(' ')}`
  const verdictLine = v
    ? v.vetoedBy
      ? `Verdict: blocked · vetoed by ${v.vetoedBy} · ${v.split}`
      : winner
        ? `Verdict: ${winner}) ${v.chosen} · ${v.split} · no veto`
        : `Verdict: no majority · ${v.split} · your call`
    : `Voting · ${c.seats.filter(s => s.vote).length} of ${c.size} in`

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={COL.acc}>Council #{number}</Text> · “{clip(c.question, Math.max(20, width - 20))}”
      </Text>
      <Text dimColor>
        {c.options.map((o, i) => `${LETTERS[i]}) ${o}`).join('  ')} · round {round} of 2 · security and ops can veto
      </Text>
      <Box flexDirection="row">
        {[3, 6, 9].map(n => (
          <Button key={`size-${n}`} plain onPress={() => $.command.run({ command: 'council', args: asArgs(n) }).then(() => {})}>
            <Text {...pick(n === c.size)}> {n} seats </Text>
          </Button>
        ))}
        <Text dimColor> {c.size === 9 ? 'needs your yes' : c.size === 6 ? `est. $${((c.size * 2 * 1400) / 1_000_000 * 15).toFixed(2)} · shown first` : 'runs now'}</Text>
      </Box>
      {c.seats.map(s => (
        <Text>
          {'  '}
          {s.role.padEnd(13)}
          <Text color={s.vote === undefined ? COL.dim : s.vote === 'veto' ? COL.red : s.vote === winner ? COL.sage : COL.acc}>{(s.vote ?? '…').padEnd(8)}</Text>
          <Text dimColor>{clip(s.reason ?? (s.vote === undefined ? 'thinking' : ''), Math.max(10, width - 26))}</Text>
        </Text>
      ))}
      <Text color={v?.vetoedBy ? COL.red : v ? COL.sage : COL.accL}>{verdictLine}</Text>
      {v?.changes.map(ch => (
        <Text dimColor>  • {ch}</Text>
      ))}
      <Box flexDirection="row">
        <Button
          key="accept"
          hotkey="a"
          plain
          onPress={() =>
            $.prompt
              .submit({ text: `The council of ${c.size} decided on "${c.question}": ${v?.chosen ?? 'no verdict yet'} (${v?.split ?? ''}). Proceed with it${v?.changes.length ? `, applying: ${v.changes.join('; ')}` : ''}.` })
              .then(() => $.ui.toast('decision logged'))
          }
        >
          <Text color={COL.fg}>[ a: accept ] </Text>
        </Button>
        <Button key="override" hotkey="o" plain onPress={() => $.prompt.fill({ text: `Override the council on "${c.question}": `, mode: 'replace' }).then(() => {})}>
          <Text color={COL.fg}>[ o: override ] </Text>
        </Button>
        {c.size < 9 && (
          <Button key="rerun" hotkey="b" plain onPress={() => $.command.run({ command: 'council', args: asArgs(c.size === 3 ? 6 : 9) }).then(() => {})}>
            <Text color={COL.fg}>[ b: re-run bigger ]</Text>
          </Button>
        )}
      </Box>
      <Text dimColor>Every verdict goes into the decision log.</Text>
    </Box>
  )
}

export function councils(on: On) {
  on('command.run', { command: 'council' }, async ($, e) => {
    const m = e.args.trim().match(/^(3|6|9)?\s*(.+)$/s)
    if (!m?.[2]) return { text: 'Usage: /council 3|6|9 <question> [A) option B) option …]' }
    const size = Number(m[1] ?? 3)
    const calls = size * 2
    if (size > 3) {
      const isGo =
        (await $.ui.ask(
          `A council of ${size} makes ${calls} model calls (about ${Math.round((calls * (MAX_TOKENS + 800)) / 1000)}k tokens).${size === 9 ? ' Councils of 9 need your approval.' : ''} Start it?`,
          { header: 'Council', options: ['Start', 'Cancel'] },
        )) === 'Start'
      if (!isGo) return { text: 'Council cancelled.' }
    }
    await $.ui.open({ id: COUNCIL, title: `CompanyOS · council of ${size}` })
    // Runs past this command so the prompt stays free; the pane fills as votes land.
    $.clock.after(0, () => void convene($, size, m[2]!).catch(err => $.ui.toast(`CompanyOS: council failed: ${String(err)}`)))
    return { text: `Council of ${size} convened.` }
  })

  on('ui.render', { component: 'Pane', requestId: COUNCIL }, ($, e) => councilBody($, e))
}
