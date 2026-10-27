import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'companyos',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: false, maxRows: 2, bodyColumns: 100, scroll: { offset: 0, bodyRows: 2 }, view: {} },
} as const

test('the band shows context, cost and live agents', async ($, on) => {
  mock.store(on)
  on('session.repo', () => ({ value: null }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, percent: 72 }, rateLimits: [], cost: { usd: 4.31 } } }))
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'tests', type: 'Explore', status: 'running' }] }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /ctx 72%/ }))?.text).toContain('72')
    expect(await ui.find({ type: 'Text', text: /\$4\.31/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'agent-a1' })).toBeDefined()
    await ui.unmount()
  }
})
