import { expect, mock, test } from 'claude-code/testing'

const HOW = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
const PANE = {
  plugin: 'companyos',
  component: 'Pane',
  requestId: 'companyos-diff',
  surface: 'terminal',
  props: { title: 'changes', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('an edit is recorded with its counts, and revert puts the file back and tells the agent', async ($, on) => {
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  let file = 'a\nb\nc\n'
  on('fs.read', () => ({ value: file }))
  const writes: string[] = []
  on('fs.write', (_, e) => {
    writes.push(e.text)
    file = e.text
    return { value: undefined }
  })
  on('tool.call', { tool: 'Edit' }, () => {
    file = 'a\nB\nB2\nc\n'
    return { result: {} }
  })
  const session = mock.session(on)

  await $.tool.call({ tool: 'Edit', file_path: '/repo/x.ts', old_string: 'b', new_string: 'B\nB2' })

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /\+2 −1 in 1 files/ })).toBeDefined()
  // A change's id is the clock's time in base 36.
  const id = (1_700_000_000_000).toString(36)
  expect(await ui.find({ type: 'Button', key: `revert-${id}` })).toBeDefined()
  await ui.press({ key: `revert-${id}` })
  await ui.unmount()

  expect(writes).toEqual(['a\nb\nc\n'])
  expect(JSON.stringify(session.appended())).toContain('reverted your change to /repo/x.ts')

  const again = await $.command.run({ command: 'diff', args: `revert ${id}`, ...HOW })
  expect(again.text).toBe('Nothing to revert.')
})
