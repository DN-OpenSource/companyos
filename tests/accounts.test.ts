import { expect, test } from 'claude-code/testing'

import { world } from './world'

test('a commit under the wrong email is blocked', async ($, on) => {
  world(on, { email: 'me@home.co', login: 'work' })
  const ran = await $.tool.call({ tool: 'Bash', command: 'git commit -m "x"' })
  expect(ran.deny).toContain('me@work.co')
})

test('a push under the wrong gh login is blocked', async ($, on) => {
  world(on, { email: 'me@work.co', login: 'personal' })
  const ran = await $.tool.call({ tool: 'Bash', command: 'git -C . push origin feat/x' })
  expect(ran.deny).toContain('/account switch work')
})

test('the bound identity commits and pushes', async ($, on) => {
  world(on, { email: 'me@work.co', login: 'work' })
  expect((await $.tool.call({ tool: 'Bash', command: 'git commit -m "x" && git push' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
})
