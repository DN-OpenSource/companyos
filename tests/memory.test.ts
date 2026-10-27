import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'companyos',
  component: 'Pane',
  requestId: 'companyos-memory',
  surface: 'terminal',
  props: { title: 'memory', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('@mem remember is kept and shown in the memory pane', async ($, on) => {
  mock.store(on)
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  on('session.repo', () => ({ value: { root: '/repo', remote: null, internal: false, name: 'repo' } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, percent: 10 }, rateLimits: [] } }))
  on('prompt.submit', (_, e) => ({ text: e.text }))

  const sent = await $.prompt.submit({ text: '@mem remember we use pnpm, not npm', wait: false, origin: { kind: 'composer' } })
  expect(sent.drop).toBe('Memory updated.')

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /pnpm, not npm/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\/mem/ })).toBeDefined()
  await ui.unmount()
})

test('a plain prompt passes through untouched', async ($, on) => {
  on('clock.now', () => ({ value: 1 }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  const sent = await $.prompt.submit({ text: 'fix the failing login test', wait: false, origin: { kind: 'composer' } })
  expect(sent.text).toBe('fix the failing login test')
})
