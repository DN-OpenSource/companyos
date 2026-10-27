import type { EngineInterface, On } from 'claude-code'

import type { Ticket } from '../types'
import { log } from './events'
import { clip } from './util'

export const TICKETS = 'companyos-tickets'
export const TICKET_TOOL = 'ticket_update'
const COLUMNS: Ticket['status'][] = ['To Do', 'In Progress', 'In Review', 'Blocked', 'Done']
const SOURCES = ['jira', 'notion', 'linear', 'github', 'asana', 'clickup', 'monday']
const KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$|^#?\d+$/

async function storeKey($: EngineInterface) {
  return `tickets/${(await $.session.repo())?.root ?? 'global'}`
}

export async function tickets($: EngineInterface): Promise<Ticket[]> {
  return ((await $.store.get(await storeKey($))) as Ticket[] | undefined) ?? []
}

async function upsert($: EngineInterface, patch: Partial<Ticket> & { key: string }) {
  const list = await tickets($)
  const old = list.find(t => t.key === patch.key)
  const now = await $.clock.now()
  const next: Ticket = { title: '', source: 'jira', status: 'To Do', ...old, ...patch, ts: now }
  await $.store.set(await storeKey($), [...list.filter(t => t.key !== patch.key), next])
  await log($, 'ticket_update', patch.agent, `${next.key} ${old?.status ?? 'new'} → ${next.status}${next.title ? `: ${next.title}` : ''}`)
  $.ui.invalidate('ui.render')
  return next
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)

function workPrompt(t: Ticket) {
  return [
    `Work on ${t.source} ticket ${t.key}${t.title ? ` ("${t.title}")` : ''}.`,
    `1. Load it with the connected ${t.source} tools: description, acceptance criteria, comments and linked docs. Say how large it is before reading attachments.`,
    `2. Call mcp__companyos__${TICKET_TOOL} with its key, title, status "In Progress" and any requirement ID it names.`,
    `3. Branch as feat/${t.key}-${slug(t.title || 'work')} under my git conventions; put ${t.key} in commit messages and the PR title.`,
    `4. When done, move it to In Review in ${t.source}, post a short plain-language progress comment there, and call mcp__companyos__${TICKET_TOOL} again with the new status.`,
    `If you get stuck on a question for me, call mcp__companyos__${TICKET_TOOL} with status "Blocked" and the question as note.`,
  ].join('\n')
}

// `/ticket` and `@jira …`: [source] start|move|done|block|add|sync|wall …
export async function ticketCommand($: EngineInterface, args: string): Promise<string> {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const source = SOURCES.includes(words[0]?.toLowerCase() ?? '') ? words.shift()!.toLowerCase() : undefined
  const [verb = 'wall', key = '', ...rest] = words
  const text = rest.join(' ')

  if (verb === 'wall' || verb === 'list') {
    await $.ui.open({ id: TICKETS, title: 'CompanyOS · ticket wall' })
    return `${(await tickets($)).length} tickets on the wall.`
  }
  if (verb === 'sync') {
    await $.prompt.submit({
      text: `List the ${source ?? 'Jira, Notion or Linear'} tickets assigned to me that are not done${key ? ` (filter: ${[key, text].join(' ')})` : ''}, using the connected tools, and call mcp__companyos__${TICKET_TOOL} once per ticket with its key, title, status and source. Change nothing in the tracker.`,
    })
    return 'Asked Claude to sync the wall.'
  }
  if (!KEY.test(key)) return 'Usage: /ticket [jira|notion|linear] start|move|done|block|add <KEY> [status|title|reason] · /ticket sync · /ticket wall'
  const old = (await tickets($)).find(t => t.key === key)
  const from = source ?? old?.source ?? 'jira'

  if (verb === 'add') return `Added ${(await upsert($, { key, source: from, title: text || old?.title || '' })).key}.`
  if (verb === 'start') {
    const t = await upsert($, { key, source: from, status: 'In Progress', title: text || old?.title || '', agent: 'lead' })
    await $.prompt.submit({ text: workPrompt(t) })
    return `Started ${key}.`
  }
  const status: Ticket['status'] | undefined =
    verb === 'done' ? 'Done' : verb === 'block' ? 'Blocked' : verb === 'move' ? COLUMNS.find(c => c.toLowerCase() === text.toLowerCase()) : undefined
  if (status === undefined) return `Statuses: ${COLUMNS.join(', ')}.`
  await upsert($, { key, source: from, status, note: verb === 'block' ? text : undefined })
  await $.prompt.submit({
    text: `Move ${from} ticket ${key} to "${status}" with the connected ${from} tools${verb === 'block' ? ` and comment that it is blocked: ${text}` : ''}. Then call mcp__companyos__${TICKET_TOOL} with the result.`,
  })
  return `${key} → ${status}.`
}

export function ticketing(on: On) {
  on('command.run', { command: 'ticket' }, async ($, e) => ({ text: await ticketCommand($, e.args) }))

  // Claude reports what it read or changed in the tracker; the wall follows.
  on('tool.call', { tool: /^mcp__companyos__ticket_update$/ }, async ($, e) => {
    const a = e as unknown as Partial<Ticket>
    if (typeof a.key !== 'string' || !a.key) return { deny: 'key is required' }
    const status = COLUMNS.find(c => c.toLowerCase() === String(a.status ?? '').toLowerCase())
    const t = await upsert($, {
      key: a.key,
      ...(a.title ? { title: String(a.title) } : {}),
      ...(a.source ? { source: String(a.source).toLowerCase() } : {}),
      ...(status ? { status } : {}),
      ...(a.requirement ? { requirement: String(a.requirement) } : {}),
      ...(a.note ? { note: String(a.note) } : {}),
      ...(e.agentId ? { agent: e.agentId } : {}),
    })
    if (t.status === 'Blocked') $.ui.toast(`CompanyOS: ${t.key} is blocked${t.note ? `: ${t.note}` : ''}`)
    return { result: { ok: true, ticket: t } }
  })

  on('ui.render', { component: 'Pane', requestId: TICKETS }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await tickets($)
    const width = e.props.bodyColumns
    const noReq = list.filter(t => !t.requirement).length

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>No tickets yet. /ticket sync, or @jira start PROJ-12</Text>}
        {COLUMNS.map(col => {
          const here = list.filter(t => t.status === col)
          return here.length === 0 ? null : (
            <Box flexDirection="column">
              <Text bold>
                {col} ({here.length})
              </Text>
              {here.map(t => (
                <Box flexDirection="row">
                  <Text color={col === 'Blocked' ? 'error' : t.agent ? undefined : 'inactive'}>
                    {'  '}
                    {t.key.padEnd(10)} {clip(t.title || '(untitled)', Math.max(10, width - 44))} <Text dimColor>{t.agent ?? 'nobody'}{t.requirement ? ` · ${t.requirement}` : ''}</Text>{' '}
                  </Text>
                  {col !== 'Done' && col !== 'In Progress' && (
                    <Button key={`work-${t.key}`} plain onPress={() => ticketCommand($, `${t.source} start ${t.key}`).then(() => {})}>
                      work on this
                    </Button>
                  )}
                </Box>
              ))}
            </Box>
          )
        })}
        {list.length > 0 && <Text dimColor>{noReq} tickets name no requirement ID</Text>}
      </Box>
    )
  })
}
