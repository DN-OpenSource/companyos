import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { world } from './world'

const ok = { email: 'me@work.co', login: 'work' }

// $.ui.ask is an AskUserQuestion call; answer it before the world's catch-all.
function person(on: On, answer: string, asked: string[] = []) {
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const q = e.questions[0]?.question ?? ''
    asked.push(q)
    return { result: { questions: e.questions, answers: { [q]: answer } } }
  })
}

test('a staged secret blocks the commit', async ($, on) => {
  world(on, { ...ok, diff: '+const key = "AKIAABCDEFGHIJKLMNOP"' })
  const ran = await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  expect(ran.deny).toContain('secret')
})

test('a force push waits on the person, and a no stops it', async ($, on) => {
  const asked: string[] = []
  person(on, 'Deny', asked)
  world(on, ok)
  const ran = await $.tool.call({ tool: 'Bash', command: 'git push --force origin x' })
  expect(ran.deny).toContain('force push')
  expect(asked.length).toBe(1)
})

test('a yes lets the risky command run', async ($, on) => {
  person(on, 'Allow once')
  world(on, ok)
  expect((await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })).deny).toBeUndefined()
})
