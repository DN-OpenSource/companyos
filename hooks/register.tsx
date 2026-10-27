import type { Register } from 'claude-code'

import { accounts } from './accounts'
import { band } from './band'
import { feed } from './feed'
import { guard } from './guard'
import { stats } from './stats'

const COMMANDS = [
  { name: 'events', description: 'CompanyOS: show the live event feed' },
  { name: 'stats', description: 'CompanyOS: context, cost, agents and skills' },
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
}
