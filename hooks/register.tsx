import type { Register } from 'claude-code'

import { accounts } from './accounts'
import { feed } from './feed'

export const register: Register = on => {
  // One session.start for the whole mod: the engine takes one unmatched hook per event.
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'events', description: 'CompanyOS: show the live event feed' })
    await $.command.register({
      name: 'account',
      description: 'CompanyOS: show, bind or switch the GitHub account for this repo',
      argumentHint: '[bind <login> [email] | unbind | switch <login>]',
    })
    return next(e)
  })

  feed(on)
  accounts(on)
}
