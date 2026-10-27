import { expect, mock, test } from 'claude-code/testing'

const HOW = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
const run = (args: string) => ({ command: 'anthropic', args, ...HOW })

test('a Skill tool call counts as a skill load when skill.prompt never arrives', async ($, on) => {
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  on('tool.call', () => ({ result: 'loaded', text: 'x'.repeat(400) }))
  await $.tool.call({ tool: 'Skill', skill: 'code-review' })
  const ui = await $.ui.mount({
    plugin: 'companyos',
    component: 'Pane',
    requestId: 'companyos-feed',
    surface: 'terminal',
    props: { title: 'events', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  expect(await ui.find({ type: 'Text', text: /The lead picked up the code-review playbook/ })).toBeDefined()
  await ui.unmount()
})

test('a routed agent type is spawned on the chosen model', async ($, on) => {
  mock.store(on)
  on('clock.now', () => ({ value: 1 }))
  const models: (string | undefined)[] = []
  on('agent.spawn', (_, e) => {
    models.push(e.model)
    return { model: e.model ?? 'inherit', agentId: 'a1' }
  })
  expect((await $.command.run(run('route Explore claude-haiku-5-5'))).text).toContain('Explore agents now run on claude-haiku-5-5')
  const base = { tool_use_id: 't', prompt: 'look', description: 'look around', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false } as const
  await $.agent.spawn({ ...base, subagentType: 'Explore' } as Parameters<typeof $.agent.spawn>[0])
  await $.agent.spawn({ ...base, subagentType: 'Plan' } as Parameters<typeof $.agent.spawn>[0])
  expect(models).toEqual(['claude-haiku-5-5', undefined])
})

test('a bedrock profile is written to local settings after a yes, other providers cleared', async ($, on) => {
  mock.store(on)
  on('clock.now', () => ({ value: 1 }))
  on('session.repo', () => ({ value: { root: '/repo', remote: null, internal: false, name: 'repo' } }))
  on('fs.read', () => ({ value: JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, env: { CLAUDE_CODE_USE_VERTEX: '1', KEEP: 'me' } }) }))
  const written: string[] = []
  on('fs.write', (_, e) => {
    written.push(e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => ({ result: { questions: e.questions, answers: { [e.questions[0]?.question ?? '']: 'Write it' } } }))

  await $.command.run(run('add work bedrock region=us-east-1 profile=work model=claude-sonnet-5-5'))
  const used = await $.command.run(run('use work'))
  expect(used.text).toContain('Start a new session here')
  const settings = JSON.parse(written[0] ?? '{}')
  expect(settings.env).toEqual({ KEEP: 'me', CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1', AWS_PROFILE: 'work', ANTHROPIC_MODEL: 'claude-sonnet-5-5' })
  expect(settings.permissions.allow).toEqual(['Bash(ls)'])
})

test('the rate-limit forecast reads the pace of a climbing window', async ($, on) => {
  mock.store(on, {
    'anthropic/samples': [
      { ts: 0, kind: 'five_hour', pct: 40 },
      { ts: 600_000, kind: 'five_hour', pct: 50 },
    ],
  })
  on('session.identity', () => ({ value: { kind: 'claude.ai', email: 'me@sorigin.co', isVerified: true } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, percent: 10 }, rateLimits: [{ kind: 'five_hour', percentUsed: 50 }], cost: { usd: 1 } } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  const shown = await $.command.run(run(''))
  // 10 points in 10 minutes: 50 left is 50 minutes away.
  expect(shown.text).toContain('five_hour: 50% used; at this pace the limit is hit in 50 minutes')
  expect(shown.text).toContain('Signed in: claude.ai · me@sorigin.co')
})
