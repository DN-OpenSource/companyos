import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'companyos',
  component: 'Pane',
  requestId: 'companyos-council',
  surface: 'terminal',
  props: { title: 'council', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const HOW = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

const usage = { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

// Every seat answers `vote`, except the roles in `others`.
function seats(on: On, vote: string, others: Record<string, string> = {}) {
  const answer = (prompt: string) => {
    const role = prompt.match(/as the ([^.]+)\./)?.[1] ?? ''
    const v = others[role] ?? vote
    return { value: { isAnswered: true as const, text: JSON.stringify({ vote: v, confidence: 0.9, reason: `${role} says ${v}`, change: v === 'B' ? 'add a rollback plan' : '' }), usage } }
  }
  on('model.complete', (_, e) => answer(e.prompt))
  on('model.fork', (_, e) => answer(e.prompt))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
}

test('a council of 3 votes, and its verdict is drawn and stored', async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  mock.store(on)
  on('session.repo', () => ({ value: null }))
  seats(on, 'B', { reviewer: 'A' })

  const ran = await $.command.run({ command: 'council', args: '3 which store? A) sqlite B) drizzle', ...HOW })
  expect(ran.text).toContain('convened')
  await clock.advance(1)
  await clock.settle()

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /drizzle · 2–1/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'accept' })).toBeDefined()
  await ui.unmount()
})

test('a security veto blocks whatever the count', async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  mock.store(on)
  on('session.repo', () => ({ value: null }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => ({ result: { questions: e.questions, answers: { [e.questions[0]?.question ?? '']: 'Start' } } }))
  seats(on, 'A', { security: 'veto' })

  await $.command.run({ command: 'council', args: '6 drop the users table? A) yes B) no', ...HOW })
  await clock.advance(1)
  await clock.settle()

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /blocked.*vetoed by security/ })).toBeDefined()
  await ui.unmount()
})
