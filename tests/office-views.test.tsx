import { expect, mock, test } from 'claude-code/testing'

const HOW = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
const HUB = {
  plugin: 'companyos',
  component: 'Pane',
  requestId: 'companyos',
  surface: 'terminal',
  props: { title: 'CompanyOS', isFocused: true, bodyColumns: 160, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

test('a replay walks the session forward as the clock ticks', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  on('session.repo', () => ({ value: null }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, percent: 10 }, rateLimits: [] } }))
  on('agent.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'companyos', title: 'CompanyOS', isShown: true, isFocused: false, isPlaced: true }] }))
  on('tool.call', () => ({ result: {} }))
  for (const command of ['ls', 'pwd', 'git status', 'git log', 'npm test', 'echo hi']) await $.tool.call({ tool: 'Bash', command })

  // Speed 2: one event per 200 ms frame.
  expect((await $.command.run({ command: 'office', args: 'replay this 2', ...HOW })).text).toBe('replay · session saved, playing in the office')
  const ui = await $.ui.mount(HUB)
  expect(await ui.find({ type: 'Text', text: /▶ replay · 0\/6 events/ })).toBeDefined()
  await clock.advance(600)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /▶ replay · 3\/6 events/ })).toBeDefined()
  await clock.advance(1_000)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /▶ replay · 6\/6 events · done/ })).toBeDefined()
  await ui.unmount()
})
