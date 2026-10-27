import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const DIFF = ['+++ b/src/invoice.ts', '@@ -40,0 +41,2 @@', '+  const total = round(sum)', '+  console.log(total)'].join('\n')

// A repo where an edit lands and tests pass or fail as `testsPass` says; every hook is set before the first $ call.
function world(on: On, testsPass: boolean, sent: string[] = []) {
  mock.store(on)
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  on('session.repo', () => ({ value: { root: '/repo', remote: null, internal: false, name: 'repo' } }))
  let file = 'a'
  on('fs.read', (_, e) => (e.path.endsWith('package.json') ? { value: JSON.stringify({ scripts: { test: 'vitest run' } }) } : { value: file }))
  on('fs.write', () => ({ value: undefined }))
  on('tool.call', { tool: 'Write' }, () => {
    file = 'b'
    return { result: {} }
  })
  on('process.run', (_, e) => {
    const line = e.argv.join(' ')
    if (line.includes('git diff HEAD -U0')) return ok(DIFF)
    if (line.includes('git diff HEAD --name-only')) return ok('src/invoice.ts\npackage.json\n')
    if (line.includes('npm run -s test')) return ok(testsPass ? 'all passed' : '2 failing in invoice.spec.ts', testsPass ? 0 : 1)
    return ok('')
  })
  on('prompt.submit', (_, e) => {
    if (e.origin.kind === 'plugin') sent.push(e.text)
    return { text: e.text }
  })
  on('ui.log', () => ({ value: undefined }))
  // No settings Stop hook beneath: the turn may end.
  on('classic.Stop', () => ({}))
}

const stop = { stop_hook_active: false } as const
const ask = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as const

test('a failing test holds the turn with the reason; warnings ride along', async ($, on) => {
  world(on, false)
  await $.prompt.submit(ask('fix the invoice'))
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/invoice.ts', content: 'b' })

  const held = await $.classic.Stop(stop)
  expect(held.block).toContain('Tests: npm run -s test · exit 1')
  expect(held.block).toContain('(warning only) Leftovers: 1 left: src/invoice.ts:42')
  expect(held.block).toContain('(warning only) Scope: dependency files changed: package.json')
})

test('passing checks let the turn end; so does a turn that changed no file', async ($, on) => {
  world(on, true)
  await $.prompt.submit(ask('what does round() do?'))
  expect((await $.classic.Stop(stop)).block).toBeUndefined()
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/invoice.ts', content: 'b' })
  expect((await $.classic.Stop(stop)).block).toBeUndefined()
})

test('a gate that cannot pass lets go after three holds', async ($, on) => {
  world(on, false)
  await $.prompt.submit(ask('fix the invoice'))
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/invoice.ts', content: 'b' })
  for (let i = 0; i < 3; i++) expect((await $.classic.Stop(stop)).block).toBeDefined()
  expect((await $.classic.Stop(stop)).block).toBeUndefined()
})

test('where classic.Stop never arrives, the turn end sends Claude back with the reason, three times at most', async ($, on) => {
  const sent: string[] = []
  world(on, false, sent)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, percent: 10 }, rateLimits: [] } }))
  on('session.id', () => ({ value: 's1' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.prompt.submit(ask('fix the invoice'))
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/invoice.ts', content: 'b' })

  const end = { answer: 'done', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' } as const
  for (let i = 0; i < 4; i++) await $.turn.complete(end)
  expect(sent.length).toBe(3)
  expect(sent[0]).toContain('The CompanyOS done gate held this turn')
})
