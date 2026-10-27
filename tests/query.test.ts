import { expect, test } from 'claude-code/testing'

test('the event query tool answers from the log, filtered', async ($, on) => {
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })

  const query = (input: Record<string, unknown>) =>
    $.tool.call({ tool: 'mcp__companyos__events_query', ...input } as unknown as Parameters<typeof $.tool.call>[0])
  const hit = await query({ kind: 'tool_call', text: 'npm' })
  expect(hit.result).toContain('1 matching events')
  expect(hit.result).toContain('lead tool_call Bash npm test')
  expect((await query({ kind: 'vote' })).result).toContain('0 matching events')
})
