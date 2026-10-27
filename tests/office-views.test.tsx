import { expect, mock, test } from 'claude-code/testing'

const HOW = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
const PANE = {
  plugin: 'companyos',
  component: 'Pane',
  requestId: 'companyos-office',
  surface: 'terminal',
  props: { title: 'office', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('the org chart wall lists the agents the lead delegated to', async ($, on) => {
  mock.store(on)
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  on('session.repo', () => ({ value: null }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, percent: 10 }, rateLimits: [] } }))
  on('agent.list', () => ({ value: [{ id: 'a1', name: 'priya', description: 'tests', type: 'Explore', status: 'running' }] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))

  expect((await $.command.run({ command: 'office', args: 'wall', ...HOW })).text).toBe('Org chart wall.')
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /Org chart: lead → priya \(running\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Raster', key: 'office' })).toBeDefined()
  await ui.unmount()
})

test('a replay walks the session forward as the clock ticks', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  on('session.repo', () => ({ value: null }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, percent: 10 }, rateLimits: [] } }))
  on('agent.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'companyos-office', title: 'office', isShown: true, isFocused: false, isPlaced: true }] }))
  on('tool.call', () => ({ result: {} }))
  for (const command of ['ls', 'pwd', 'git status', 'git log', 'npm test', 'echo hi']) await $.tool.call({ tool: 'Bash', command })

  // Speed 2: two events per half-second tick.
  await $.command.run({ command: 'office', args: 'replay this 2', ...HOW })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /Replaying 0\/6 events/ })).toBeDefined()
  await clock.advance(1_000)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /Replaying 4\/6 events/ })).toBeDefined()
  await clock.advance(1_000)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /Replaying 6\/6 events, done/ })).toBeDefined()
  await ui.unmount()
})
