import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

function world(on: On, opened: string[], status: (string | undefined)[]) {
  mock.store(on)
  on('session.repo', () => ({ value: null }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__companyos__${e.name}` } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.status', (_, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, percent: 46 }, rateLimits: [], cost: { usd: 1.23 } } }))
}

test('a new session shows the hub and the status line at once', async ($, on) => {
  const opened: string[] = []
  const status: (string | undefined)[] = []
  world(on, opened, status)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(opened).toEqual(['companyos'])
  expect(status[0]).toBe('CompanyOS · ctx 46% · $1.23')
})

test('openOnStart off leaves the hub to /cos', { options: { openOnStart: false } }, async ($, on) => {
  const opened: string[] = []
  world(on, opened, [])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(opened).toEqual([])
})
