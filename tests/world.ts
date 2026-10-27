import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'

// The machine beneath the guards: a bound repo, git and gh answering as `have` says.
const ROOT = '/repo'

export function world(on: On, have: { email: string; login: string; diff?: string }) {
  mock.store(on, { [`accounts/${ROOT}`]: { login: 'work', email: 'me@work.co' } })
  on('clock.now', () => ({ value: 1_000 }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.repo', () => ({ value: { root: ROOT, remote: null, internal: false, name: 'repo' } }))
  on('process.run', (_, e) => {
    const out = e.argv[0] === 'gh' ? have.login : e.argv[1] === 'diff' ? (have.diff ?? '') : have.email
    return { value: { exitCode: 0, stdout: out + '\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: {} }))
}
