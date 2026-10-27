import type { Register } from 'claude-code'

import { accounts } from './accounts'
import { band } from './band'
import { councils } from './council'
import { feed } from './feed'
import { graph } from './graph'
import { guard } from './guard'
import { memory } from './memory'
import { modes } from './mode'
import { reports } from './reports'
import { router } from './router'
import { stats } from './stats'
import { TICKET_TOOL, ticketing } from './tickets'

const COMMANDS = [
  { name: 'events', description: 'CompanyOS: show the live event feed' },
  { name: 'stats', description: 'CompanyOS: context, cost, agents and skills' },
  {
    name: 'mem',
    description: 'CompanyOS: long-term memory',
    argumentHint: '[remember [--global] <text> | forget <id> | pin <id> | prune | export]',
  },
  {
    name: 'graph',
    description: 'CompanyOS: agents, skills, files, memory, decisions or cost as a graph',
    argumentHint: '[agents|skills|files|memory|decisions|cost]',
  },
  {
    name: 'council',
    description: 'CompanyOS: a council of 3, 6 or 9 agents votes on a question',
    argumentHint: '3|6|9 <question> [A) option B) option …]',
  },
  {
    name: 'ticket',
    description: 'CompanyOS: work tickets from Jira, Notion or Linear and keep the wall in sync',
    argumentHint: '[jira|notion|linear] start|move|done|block|add <KEY> … | sync | wall',
  },
  { name: 'mode', description: 'CompanyOS: switch between technical and plain-language rendering', argumentHint: '[plain|technical]' },
  { name: 'daily', description: "CompanyOS: write today's plain-language page and standup to .companyos/" },
  { name: 'report', description: 'CompanyOS: weekly report, or export events as CSV or JSON', argumentHint: '[week|csv|json]' },
  {
    name: 'account',
    description: 'CompanyOS: show, bind or switch the GitHub account for this repo',
    argumentHint: '[bind <login> [email] | unbind | switch <login>]',
  },
]

export const register: Register = (on, options) => {
  // One session.start for the whole mod: the engine takes one unmatched hook per event.
  on('session.start', async ($, e, next) => {
    for (const c of COMMANDS) await $.command.register(c)
    await $.tool.register({
      name: TICKET_TOOL,
      description:
        'Report a ticket to the CompanyOS wall after reading or changing it in Jira, Notion, Linear or another tracker. Call once per ticket.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Ticket key, e.g. PROJ-12' },
          title: { type: 'string' },
          source: { type: 'string', description: 'jira, notion, linear, github, …' },
          status: { type: 'string', enum: ['To Do', 'In Progress', 'In Review', 'Blocked', 'Done'] },
          requirement: { type: 'string', description: 'Requirement ID from a BRD, when the ticket names one' },
          note: { type: 'string', description: 'Why it is blocked, or a one-line progress note' },
        },
        required: ['key'],
      },
    })
    return next(e)
  })

  feed(on, Number(options.costCapUsd ?? 0))
  accounts(on)
  guard(on, options)
  stats(on)
  band(on)
  memory(on)
  graph(on)
  router(on)
  councils(on)
  ticketing(on)
  modes(on)
  reports(on)
}
