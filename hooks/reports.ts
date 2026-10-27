import type { EngineInterface, On } from 'claude-code'

import type { CosEvent, Ticket } from '../types'
import { readEvents } from './events'
import { plain } from './mode'
import { tickets } from './tickets'
import { day, skillOf, tokens, usd } from './util'

const DAY = 24 * 3600_000

type Decision = { question: string; chosen: string; split: string; ts: number; verdict?: { plain?: string } }

// Every session's events the store still holds, this one's live copy included.
async function allEvents($: EngineInterface): Promise<CosEvent[]> {
  const [keys, live, id] = await Promise.all([$.store.keys(), readEvents($), $.session.id()])
  const stored = await Promise.all(keys.filter(k => k.startsWith('events/') && k !== `events/${id}`).map(k => $.store.get(k)))
  return [...(stored.flat() as CosEvent[]), ...live]
}

async function decisions($: EngineInterface, since: number): Promise<Decision[]> {
  const keys = (await $.store.keys()).filter(k => k.startsWith('decisions/'))
  return ((await Promise.all(keys.map(k => $.store.get(k)))) as Decision[]).filter(d => d.ts >= since)
}

function summary(list: CosEvent[]) {
  const tools = list.filter(x => x.kind === 'tool_call')
  const edits = new Set(tools.filter(x => /^(Edit|Write|MultiEdit) /.test(x.detail)).map(x => x.detail.split(' ').slice(1).join(' ')))
  const turns = list.filter(x => x.kind === 'turn')
  return {
    prompts: list.filter(x => x.kind === 'prompt').length,
    tools: tools.length,
    failed: tools.filter(x => x.isError).length,
    edits: [...edits],
    tokens: turns.reduce((n, x) => n + (x.tokensIn ?? 0) + (x.tokensOut ?? 0), 0),
    skills: [...new Set(list.filter(x => x.kind === 'skill_load').map(x => skillOf(x.detail)))],
    blocked: list.filter(x => (x.kind === 'guard' || x.kind === 'identity') && x.isError),
  }
}

async function dailyPage($: EngineInterface): Promise<string> {
  const now = await $.clock.now()
  const today = day(now)
  const list = (await allEvents($)).filter(x => day(x.ts) === today)
  const yesterday = (await allEvents($)).filter(x => day(x.ts) === day(now - DAY))
  const s = summary(list)
  const usage = await $.session.usage()
  const wall: Ticket[] = await tickets($)
  const votes = await decisions($, now - DAY)
  const repo = (await $.session.repo())?.name ?? 'this project'

  return [
    `# What happened today · ${repo} · ${today}`,
    '',
    '## In plain words',
    `- You asked the team ${s.prompts} things; they took ${s.tools} actions and changed ${s.edits.length} files.`,
    `- ${usd(usage.cost?.usd)} spent in this session.`,
    s.failed ? `- ${s.failed} actions failed along the way and were looked at.` : '- Nothing failed.',
    s.blocked.length ? `- Safety checks stopped ${s.blocked.length} risky actions.` : '- No risky action needed stopping.',
    ...votes.map(d => `- Team vote on "${d.question}": ${d.verdict?.plain ?? `${d.chosen} (${d.split})`}`),
    '',
    '## Standup',
    `**Yesterday:** ${summary(yesterday).edits.slice(0, 8).join(', ') || 'no recorded work'}`,
    `**Today:** ${s.edits.slice(0, 8).join(', ') || 'no files changed yet'}; tickets in progress: ${wall.filter(t => t.status === 'In Progress').map(t => t.key).join(', ') || 'none'}`,
    `**Blockers:** ${wall.filter(t => t.status === 'Blocked').map(t => `${t.key}${t.note ? ` (${t.note})` : ''}`).join(', ') || 'none'}`,
    '',
    '## Timeline',
    ...list.filter(x => x.kind !== 'turn').slice(-60).map(x => `- ${new Date(x.ts).toISOString().slice(11, 16)} ${plain(x)}`),
    '',
    '## Technical',
    `- ${tokens(s.tokens)} tokens over ${list.filter(x => x.kind === 'turn').length} turns; context ${Math.round(usage.context.percent ?? 0)}% full`,
    `- Skills used: ${s.skills.join(', ') || 'none'}`,
    `- Files changed: ${s.edits.join(', ') || 'none'}`,
  ].join('\n')
}

async function weekReport($: EngineInterface): Promise<string> {
  const now = await $.clock.now()
  const list = (await allEvents($)).filter(x => x.ts >= now - 7 * DAY)
  const s = summary(list)
  const votes = await decisions($, now - 7 * DAY)
  const done = (await tickets($)).filter(t => t.status === 'Done' && t.ts >= now - 7 * DAY)
  return [
    `# Weekly company report · to ${day(now)}`,
    '',
    `| Measure | Value |`,
    `| --- | --- |`,
    `| Prompts | ${s.prompts} |`,
    `| Tool calls (failed) | ${s.tools} (${s.failed}) |`,
    `| Files changed | ${s.edits.length} |`,
    `| Tokens | ${tokens(s.tokens)} |`,
    `| Councils held | ${votes.length} |`,
    `| Tickets closed | ${done.length} |`,
    `| Skills used | ${s.skills.join(', ') || 'none'} |`,
    '',
    '## Decision digest',
    ...(votes.length ? votes.map(d => `- ${day(d.ts)} "${d.question}": ${d.verdict?.plain ?? d.chosen}`) : ['- No councils this week.']),
  ].join('\n')
}

const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`

async function csv($: EngineInterface): Promise<string> {
  const rows = (await allEvents($)).map(x =>
    [new Date(x.ts).toISOString(), x.agent, x.kind, x.detail, x.isError ? 1 : 0, x.tokensIn ?? '', x.tokensOut ?? '', x.cost ?? ''].map(csvCell).join(','),
  )
  return ['ts,agent,kind,detail,error,tokens_in,tokens_out,session_cost_usd', ...rows].join('\n')
}

async function write($: EngineInterface, name: string, text: string) {
  const dir = `${await $.session.cwd()}/.companyos`
  const path = `${dir}/${name}`
  await $.fs.write(path, text)
  return path
}

export const QUERY_TOOL = 'events_query'

// What Claude reads when asked about the company's own history: matching events, newest last.
export async function queryEvents($: EngineInterface, q: { kind?: string; agent?: string; text?: string; limit?: number; scope?: string }) {
  const list = q.scope === 'all' ? await allEvents($) : await readEvents($)
  const text = (q.text ?? '').toLowerCase()
  const hits = list.filter(
    x => (!q.kind || x.kind === q.kind) && (!q.agent || x.agent === q.agent) && (!text || x.detail.toLowerCase().includes(text)),
  )
  const limit = Math.max(1, Math.min(200, q.limit ?? 30))
  const rows = hits.slice(-limit).map(x => `${new Date(x.ts).toISOString()} ${x.agent} ${x.kind}${x.isError ? ' ERROR' : ''} ${x.detail}${x.tokensIn ? ` in=${x.tokensIn}` : ''}${x.tokensOut ? ` out=${x.tokensOut}` : ''}`)
  const decided = q.kind === 'vote' || text ? (await decisions($, 0)).filter(d => !text || d.question.toLowerCase().includes(text)) : []
  return [
    `${hits.length} matching events${hits.length > limit ? `, last ${limit} shown` : ''}:`,
    ...rows,
    ...decided.map(d => `decision ${new Date(d.ts).toISOString()} "${d.question}": ${d.verdict?.plain ?? `${d.chosen} (${d.split})`}`),
  ].join('\n')
}

export function reports(on: On) {
  on('tool.call', { tool: /^mcp__companyos__events_query$/ }, async ($, e) => {
    const a = e as unknown as { kind?: string; agent?: string; text?: string; limit?: number; scope?: string }
    return { result: await queryEvents($, a) }
  })

  on('command.run', { command: 'daily' }, async $ => {
    const path = await write($, `daily-${day(await $.clock.now())}.md`, await dailyPage($))
    return { text: `Wrote today's page for stakeholders: ${path}` }
  })

  on('command.run', { command: 'report' }, async ($, e) => {
    const kind = e.args.trim() || 'week'
    const now = day(await $.clock.now())
    if (kind === 'csv') return { text: `Wrote ${await write($, `events-${now}.csv`, await csv($))}` }
    if (kind === 'json') return { text: `Wrote ${await write($, `events-${now}.json`, JSON.stringify(await allEvents($), null, 1))}` }
    const page = await weekReport($)
    return { text: `${page}\n\nSaved to ${await write($, `week-${now}.md`, page)}` }
  })
}
