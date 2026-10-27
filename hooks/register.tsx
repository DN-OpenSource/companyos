import type { Register } from 'claude-code'

import { accounts } from './accounts'
import { band } from './band'
import { councils } from './council'
import { diffs } from './diff'
import { setWebhook } from './events'
import { feed } from './feed'
import { graph } from './graph'
import { guard } from './guard'
import { memory } from './memory'
import { modes } from './mode'
import { office } from './office'
import { reports } from './reports'
import { sessions } from './sessions'
import { router } from './router'
import { stats } from './stats'
import { TICKET_TOOL, ticketing } from './tickets'

const COMMANDS = [
  { name: 'events', description: 'CompanyOS: show the live event feed' },
  { name: 'telemetry', description: 'CompanyOS: context, cost, agents and skills' },
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
  { name: 'office', description: 'CompanyOS: open the pixel office', argumentHint: '[theme loft|tower|cubicles|garage|space]' },
  { name: 'diff', description: 'CompanyOS: every edit this session, by agent, with revert', argumentHint: '[revert <id>]' },
  { name: 'checkpoint', description: 'CompanyOS: snapshot the workspace, list snapshots, or restore one', argumentHint: '[label] | list | restore <id>' },
  { name: 'replay', description: 'CompanyOS: save this session as a replay file in .companyos/' },
  { name: 'handover', description: 'CompanyOS: write a handover note for a colleague to continue this session' },
  {
    name: 'account',
    description: 'CompanyOS: show, bind or switch the GitHub account for this repo',
    argumentHint: '[bind <login> [email] | unbind | switch <login>]',
  },
]

export const register: Register = (on, options) => {
  setWebhook(String(options.webhookUrl ?? ''))

  // One session.start for the whole mod: the engine takes one unmatched hook per event.
  on('session.start', async ($, e, next) => {
    // One refused name (a built-in, another plugin's) must not cost the rest their registration.
    for (const c of COMMANDS) {
      try {
        await $.command.register(c)
      } catch (err) {
        $.ui.toast(`CompanyOS: /${c.name} not registered: ${String(err).slice(0, 120)}`)
      }
    }
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
  diffs(on)
  sessions(on)
  office(on, String(options.theme ?? 'loft'), options.lowPower === true)
}
