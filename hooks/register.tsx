import type { Register } from 'claude-code'

import { accounts, statusLine } from './accounts'
import { anthropic } from './anthropic'
import { band } from './band'
import { councils } from './council'
import { diffs } from './diff'
import { setWebhook } from './events'
import { feed } from './feed'
import { gates } from './gate'
import { graph } from './graph'
import { guard } from './guard'
import { hub, openHub } from './hub'
import { memory } from './memory'
import { modes } from './mode'
import { QUERY_TOOL, reports } from './reports'
import { sessions } from './sessions'
import { router } from './router'
import { stats } from './stats'
import { TICKET_TOOL, ticketing } from './tickets'

const COMMANDS = [
  {
    name: 'cos',
    description: 'CompanyOS: the hub, a tab per feature; also diff revert, config and focus, whose own names clash with built-ins',
    argumentHint: '[events|telemetry|diff|office|council|memory|tickets|account|checkpoint|config|quality] | diff revert <id> [hunk] | focus',
  },
  { name: 'gate', description: 'CompanyOS: run the done gate now (tests, types, lint, secrets, scope, coverage, leftovers)' },
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
    argumentHint: '[jira|notion|linear] start|move|done|block|add|remove <KEY> … | sync | wall',
  },
  { name: 'ticksync', description: 'CompanyOS: sync the ticket wall from Jira, Notion or Linear', argumentHint: '[jira|notion|linear]' },
  { name: 'mode', description: 'CompanyOS: switch between technical and plain-language rendering', argumentHint: '[plain|technical]' },
  { name: 'daily', description: "CompanyOS: write today's plain-language page and standup to .companyos/" },
  { name: 'report', description: 'CompanyOS: weekly report, or export events as CSV or JSON', argumentHint: '[week|csv|json]' },
  { name: 'office', description: 'CompanyOS: open the pixel office', argumentHint: '[theme loft|tower|cubicles|garage|space]' },
  { name: 'checkpoint', description: "CompanyOS: snapshot the whole workspace (not only Claude's edits, unlike /rewind), list snapshots, or restore one", argumentHint: '[label] | list | restore <id>' },
  { name: 'replay', description: 'CompanyOS: save this session as a replay file in .companyos/' },
  { name: 'handover', description: 'CompanyOS: write a handover note for a colleague to continue this session' },
  {
    name: 'anthropic',
    description: 'CompanyOS: Claude account, rate-limit forecast, provider profiles and per-agent model routes',
    argumentHint: '[add <name> <provider> [k=v…] | use <name> | route <agent type|*> <model> | …]',
  },
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
      name: QUERY_TOOL,
      description:
        "Read CompanyOS's own event log: prompts, tool calls, skill loads, delegations, compactions, turns, guard blocks, memory, council votes and verdicts, ticket moves. Use it to answer the person's questions about what the agents did and why (e.g. why a council rejected an option). Read-only.",
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['prompt', 'tool_call', 'skill_load', 'delegation', 'compaction', 'turn', 'identity', 'guard', 'memory', 'vote', 'ticket_update'] },
          agent: { type: 'string', description: "'lead', 'you', or a subagent id" },
          text: { type: 'string', description: 'Words the event detail or a decision question contains' },
          limit: { type: 'number', description: 'Most recent N matches, 1 to 200 (default 30)' },
          scope: { type: 'string', enum: ['session', 'all'], description: 'This session (default) or every stored session' },
        },
      },
    })
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
          remove: { type: 'boolean', description: 'True takes the ticket off the wall (the tracker keeps it)' },
        },
        required: ['key'],
      },
    })
    // Everything shows from the start: the status line now, and the hub beside the transcript (the engine
    // seats a pane it was not asked for once the terminal is wide enough, and holds it until then).
    if (options.openOnStart !== false && e.isInteractive) void openHub($)
    try {
      const usage = await $.session.usage()
      $.ui.status(`CompanyOS · ctx ${Math.round(usage.context.percent ?? 0)}% · $${(usage.cost?.usd ?? 0).toFixed(2)}${await statusLine($)}`)
    } catch {
      $.ui.status('CompanyOS · ready')
    }
    return next(e)
  })

  feed(on, Number(options.costCapUsd ?? 0))
  accounts(on)
  anthropic(on)
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
  gates(on, options)
  hub(on, options)
}
