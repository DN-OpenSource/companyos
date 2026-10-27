import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const ROOT = '/repo'

function world(on: On,have: { email: string; login: string }) {
  mock.store(on, { [`accounts/${ROOT}`]: { login: 'work', email: 'me@work.co' } })
  on('clock.now', () => ({ value: 1_000 }))
  on('session.repo', () => ({ value: { root: ROOT, remote: null, internal: false, name: 'repo' } }))
  on('process.run', (_, e) => {
    const out = e.argv[0] === 'gh' ? have.login : have.email
    return { value: { exitCode: 0, stdout: out + '\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: {} }))
}

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
