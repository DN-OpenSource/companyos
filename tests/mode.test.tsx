import { expect, mock, test } from 'claude-code/testing'

const HOW = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
const FEED = {
  plugin: 'companyos',
  component: 'Pane',
  requestId: 'companyos-feed',
  surface: 'terminal',
  props: { title: 'events', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('plain mode tells the same events in plain words', async ($, on) => {
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Bash', command: 'pnpm test' })

  const switched = await $.command.run({ command: 'mode', args: 'plain', ...HOW })
  expect(switched.text).toContain('plain language')

  const ui = await $.ui.mount(FEED)
  expect(await ui.find({ type: 'Text', text: /The lead is running the tests/ })).toBeDefined()
  await ui.unmount()
})

test('/daily writes a stakeholder page with a standup', async ($, on) => {
  mock.store(on)
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.repo', () => ({ value: { root: '/repo', remote: null, internal: false, name: 'oms' } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, percent: 46 }, rateLimits: [], cost: { usd: 4.31 } } }))
  const written: Record<string, string> = {}
  on('fs.write', (_, e) => {
    written[e.path] = e.text
    return { value: undefined }
  })

  const ran = await $.command.run({ command: 'daily', args: '', ...HOW })
  const [path = ''] = Object.keys(written)
  // The engine hands fs.write the path in the platform's own spelling.
  expect(path.replace(/\\/g, '/')).toMatch(/\/repo\/\.companyos\/daily-2023-11-14\.md$/)
  expect(ran.text).toContain('daily-2023-11-14.md')
  expect(written[path]).toContain('$4.31 spent')
  expect(written[path]).toContain('## Standup')
})
