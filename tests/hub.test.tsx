import { expect, mock, test } from 'claude-code/testing'

const HOW = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
const HUB = {
  plugin: 'companyos',
  component: 'Pane',
  requestId: 'companyos',
  surface: 'terminal',
  props: { title: 'CompanyOS', isFocused: true, bodyColumns: 140, placement: 'dock', scroll: { offset: 0, bodyRows: 50 }, view: {} },
} as const

test('the hub opens on a tab, and its tab buttons switch the body', async ($, on) => {
  mock.store(on)
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.repo', () => ({ value: null }))

  expect((await $.command.run({ command: 'cos', args: 'config', ...HOW })).text).toBe('companyos · opened config')
  const ui = await $.ui.mount(HUB)
  expect(await ui.find({ type: 'Text', text: /\/cos config/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /protectedPaths/ })).toBeDefined()
  for (const key of ['tab-events', 'tab-telemetry', 'tab-diff', 'tab-office', 'tab-council', 'tab-memory', 'tab-tickets', 'tab-account', 'tab-checkpoint', 'tab-quality']) {
    expect(await ui.find({ type: 'Button', key })).toBeDefined()
  }
  await ui.press({ key: 'tab-quality' })
  expect(await ui.find({ type: 'Text', text: /Done gate · runs before Claude ends a turn/ })).toBeDefined()
  await ui.press({ key: 'tab-checkpoint' })
  expect(await ui.find({ type: 'Text', text: /Checkpoints need a git repository/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Snapshots don't touch your files/ })).toBeDefined()
  await ui.unmount()
})

test('the hint line suggests how to finish @ and / words', async ($, on) => {
  // The word being typed, as prompt.change stores it (a test cannot type into the prompt).
  let draft = '@ex'
  on('state.get', { key: 'draftToken' }, () => ({ value: { value: draft, version: 1 } }))
  on('agent.list', () => ({ value: [{ id: 'a1', name: 'explore', description: 'find code', type: 'Explore', status: 'running' }] }))
  on('ui.render', { component: 'PromptHint' }, (_, e) => {
    const { Text } = _.ui.resolve(e)
    return <Text>{e.props.hint}</Text>
  })
  const hint = { plugin: 'companyos', component: 'PromptHint', requestId: 'hint', surface: 'terminal', props: { isDraft: true, isWorking: false, hint: '? for shortcuts' } } as const

  let ui = await $.ui.mount(hint)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('@explore')
  await ui.unmount()

  draft = '/co'
  ui = await $.ui.mount(hint)
  expect((await ui.find({ type: 'Text' }))?.text).toContain('/cos')
  expect((await ui.find({ type: 'Text' }))?.text).toContain('/council')
  await ui.unmount()

  draft = ''
  ui = await $.ui.mount(hint)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('? for shortcuts')
  await ui.unmount()

  // With nothing typed, the design's own hint.
  ui = await $.ui.mount({ ...hint, props: { ...hint.props, isDraft: false } })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('? for shortcuts · @ agents · / commands · $ shell')
  await ui.unmount()
})

test('focus starts on and folds routine reads; /cos focus turns it off', async ($, on) => {
  on('ui.render', { component: 'ToolUse' }, (_, e) => {
    const { Text } = _.ui.resolve(e)
    return <Text>engine row {e.props.tool}</Text>
  })
  const row = (tool: string, input: object) =>
    ({ plugin: 'companyos', component: 'ToolUse', requestId: tool, surface: 'terminal', props: { tool_use_id: tool, tool, input, isRunning: false, isErrored: false, isInterrupted: false } }) as const

  let ui = await $.ui.mount(row('Read', { file_path: 'src/a.ts' }) as never)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('▸ Read src/a.ts')
  await ui.unmount()
  ui = await $.ui.mount(row('Edit', { file_path: 'src/a.ts' }) as never)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine row Edit')
  await ui.unmount()

  expect((await $.command.run({ command: 'cos', args: 'focus', ...HOW })).text).toBe('focus off')
  ui = await $.ui.mount(row('Read', { file_path: 'src/a.ts' }) as never)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine row Read')
  await ui.unmount()
})
