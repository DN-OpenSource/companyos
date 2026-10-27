import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'companyos',
  component: 'Pane',
  requestId: 'companyos-feed',
  props: {
    title: 'CompanyOS · events',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('tool calls land in the feed, in plain words and in technical ones', async ($, on) => {
  on('clock.now', () => ({ value: 1_000 }))
  on('tool.call', (_, e) =>
    String(e.tool) === 'Bash' && 'command' in e && e.command === 'false'
      ? { result: {}, isError: true, text: 'exit 1' }
      : { result: {} },
  )

  await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  await $.tool.call({ tool: 'Bash', command: 'false' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /The lead is running a command/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Something failed while running a command/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^tool {5}$/ })).toBeDefined()
    await ui.press({ key: 'events-tech' })
    expect(await ui.find({ type: 'Text', text: /^tool Bash ls -la$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^tool Bash false exit=1$/ })).toBeDefined()
    await ui.press({ key: 'events-plain' })
    await ui.unmount()
  }
})

test('an empty feed says so', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^\/events $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'No events yet.' })).toBeDefined()
  await ui.unmount()
})
