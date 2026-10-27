import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const HOW = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
const HUB = {
  plugin: 'companyos',
  component: 'Pane',
  requestId: 'companyos',
  props: { title: 'CompanyOS', isFocused: true, bodyColumns: 160, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

function world(on: On) {
  mock.store(on)
  mock.clock(on, { now: 1_700_000_000_000 })
  on('session.repo', () => ({ value: null }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, percent: 91 }, rateLimits: [] } }))
  on('agent.list', () => ({ value: [{ id: 'a1', name: 'priya', description: 'tests', type: 'Explore', status: 'running' }] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))
}

test('the office tab draws the pixel floor as cells in the terminal and as a picture elsewhere', async ($, on) => {
  world(on)
  await $.tool.call({ tool: 'Edit', file_path: 'src/api/routes.py', old_string: 'a', new_string: 'b' })
  expect((await $.command.run({ command: 'office', args: '', ...HOW })).text).toBe('Office open.')

  const term = await $.ui.mount({ ...HUB, surface: 'terminal' })
  expect(await term.find({ type: 'Raster', key: 'office' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /(☀ day|☾ night) · loft/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /Click a room or an agent · hover to inspect · agents animate by status/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /\[ o: org chart \]/ })).toBeDefined()
  // A room's button tells what is in it and opens the tab that shows it.
  await term.press({ key: 'room-2' })
  expect(await term.find({ type: 'Text', text: /context racks · 91% full/ })).toBeDefined()
  await term.press({ key: 'room-open' })
  expect(await term.find({ type: 'Text', text: /^Context$/ })).toBeDefined()
  await term.unmount()

  await $.command.run({ command: 'cos', args: 'office', ...HOW })
  const desk = await $.ui.mount({ ...HUB, surface: 'desktop' })
  expect(await desk.find({ type: 'Svg' })).toBeDefined()
  await desk.unmount()
})

test('the org chart wall lists the lead and the agents at work', async ($, on) => {
  world(on)
  expect((await $.command.run({ command: 'office', args: 'org', ...HOW })).text).toBe('Org chart wall.')
  const ui = await $.ui.mount({ ...HUB, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Org chart wall · boxes sized by tokens/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^lead {6}/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^priya {5}/ })).toBeDefined()
  await ui.press({ key: 'view-floor' })
  expect(await ui.find({ type: 'Raster', key: 'office' })).toBeDefined()
  await ui.unmount()
})
