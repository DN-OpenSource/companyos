import { expect, mock, test } from 'claude-code/testing'

const HOW = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

test('a checkpoint snapshots with git stash create and restores after a yes', async ($, on) => {
  mock.store(on)
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  on('session.turns', () => ({ value: 4 }))
  on('session.repo', () => ({ value: { root: '/repo', remote: null, internal: false, name: 'repo' } }))
  const argvs: string[][] = []
  on('process.run', (_, e) => {
    argvs.push([...e.argv])
    return ok(e.argv[1] === 'stash' ? 'abc123def4567890\n' : '')
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => ({ result: { questions: e.questions, answers: { [e.questions[0]?.question ?? '']: 'Restore' } } }))
  mock.session(on)

  const made = await $.command.run({ command: 'checkpoint', args: 'before refactor', ...HOW })
  expect(made.text).toContain('abc123de')
  expect(made.text).toContain('before refactor')

  const id = (1_700_000_000_000).toString(36).slice(-5)
  const back = await $.command.run({ command: 'checkpoint', args: `restore ${id}`, ...HOW })
  expect(back.text).toContain(`Restored #${id}`)
  expect(argvs.some(a => a.join(' ') === 'git checkout abc123def4567890 -- .')).toBe(true)
})
