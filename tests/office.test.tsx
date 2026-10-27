import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'companyos',
  component: 'Pane',
  requestId: 'companyos-office',
  props: { title: 'office', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('the office draws as cells in the terminal and as a picture elsewhere', async ($, on) => {
  mock.store(on)
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  on('session.repo', () => ({ value: null }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, percent: 91 }, rateLimits: [] } }))
  on('agent.list', () => ({ value: [{ id: 'a1', name: 'priya', description: 'tests', type: 'Explore', status: 'running' }] }))
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Edit', file_path: 'src/api/routes.py', old_string: 'a', new_string: 'b' })

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Raster', key: 'office' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /lead: Edit src\/api\/routes\.py/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /1 at work/ })).toBeDefined()
  await term.unmount()

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desk.find({ type: 'Svg' })).toBeDefined()
  await desk.unmount()
})
