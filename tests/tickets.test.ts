import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'companyos',
  component: 'Pane',
  requestId: 'companyos-tickets',
  surface: 'terminal',
  props: { title: 'tickets', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('a ticket Claude reports lands on the wall, blocked ones flagged', async ($, on) => {
  // The mod's own tool joins the typed tool table only after the engine reloads it.
  const report = (input: Record<string, string>) =>
    $.tool.call({ tool: 'mcp__companyos__ticket_update', ...input } as unknown as Parameters<typeof $.tool.call>[0])
  mock.store(on)
  on('clock.now', () => ({ value: 1 }))
  on('session.repo', () => ({ value: { root: '/repo', remote: null, internal: false, name: 'repo' } }))

  const ok = await report({ key: 'PROJ-12', title: 'Login fails', status: 'In Progress', source: 'jira' })
  expect(ok.deny).toBeUndefined()
  await report({ key: 'PROJ-13', title: 'Export CSV', status: 'blocked', note: 'which columns?' })
  expect((await report({ title: 'no key' })).deny).toBe('key is required')

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /PROJ-12\s+Login fails/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Blocked \(1\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'work-PROJ-13' })).toBeDefined()
  await ui.unmount()
})
