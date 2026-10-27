import { expect, mock, test } from 'claude-code/testing'

const HOW = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
const PANE = {
  plugin: 'companyos',
  component: 'Pane',
  requestId: 'companyos-diff',
  surface: 'terminal',
  props: { title: 'changes', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const BEFORE = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n')
// Two hunks far apart: b → B and B2, i removed.
const AFTER = ['a', 'B', 'B2', 'c', 'd', 'e', 'f', 'g', 'h', 'j'].join('\n')

test('an edit splits into hunks; one hunk reverts alone, then the rest, and the agent is told', async ($, on) => {
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  let file = BEFORE
  on('fs.read', () => ({ value: file }))
  const writes: string[] = []
  on('fs.write', (_, e) => {
    writes.push(e.text)
    file = e.text
    return { value: undefined }
  })
  on('tool.call', { tool: 'Edit' }, () => {
    file = AFTER
    return { result: {} }
  })
  const session = mock.session(on)
  // A change's id is the clock's time in base 36.
  const id = (1_700_000_000_000).toString(36)

  await $.tool.call({ tool: 'Edit', file_path: '/repo/x.ts', old_string: 'b', new_string: 'B\nB2' })

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /\+2 −2 in 1 files/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: / 2 hunks / })).toBeDefined()
  await ui.press({ key: `revert-${id}-2` })
  await ui.unmount()

  // Only the second hunk came back: i is restored, B and B2 stay.
  expect(writes).toEqual([['a', 'B', 'B2', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n')])
  expect(JSON.stringify(session.appended())).toContain('hunk 2 of 2')

  const rest = await $.command.run({ command: 'diff', args: `revert ${id}`, ...HOW })
  expect(rest.text).toContain('Reverted change')
  expect(file).toBe(BEFORE)
  expect((await $.command.run({ command: 'diff', args: `revert ${id}`, ...HOW })).text).toBe('Nothing to revert.')
})

test('a file changed again since is left alone', async ($, on) => {
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  let file = BEFORE
  on('fs.read', () => ({ value: file }))
  on('fs.write', () => ({ value: undefined }))
  on('tool.call', { tool: 'Edit' }, () => {
    file = AFTER
    return { result: {} }
  })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/x.ts', old_string: 'b', new_string: 'B' })
  file = AFTER + '\nlater'
  const ran = await $.command.run({ command: 'diff', args: `revert ${(1_700_000_000_000).toString(36)}`, ...HOW })
  expect(ran.text).toContain('changed again since')
})
