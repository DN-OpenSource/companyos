import type { Register } from 'claude-code'

import { accounts } from './accounts'
import { band } from './band'
import { councils } from './council'
import { feed } from './feed'
import { graph } from './graph'
import { guard } from './guard'
import { memory } from './memory'
import { router } from './router'
import { stats } from './stats'

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
    name: 'account',
    description: 'CompanyOS: show, bind or switch the GitHub account for this repo',
    argumentHint: '[bind <login> [email] | unbind | switch <login>]',
  },
]

export const register: Register = (on, options) => {
  // One session.start for the whole mod: the engine takes one unmatched hook per event.
  on('session.start', async ($, e, next) => {
    for (const c of COMMANDS) await $.command.register(c)
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
}
