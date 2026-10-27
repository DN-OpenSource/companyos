import type { EngineInterface, On, SessionUsage } from 'claude-code'

import { log } from './events'

// A named way to reach Claude: which provider, and the settings env that selects it.
// Never a key: keys stay in the keychain or the person's own environment.
type Profile = { name: string; provider: 'subscription' | 'api' | 'bedrock' | 'vertex' | 'gateway'; env: Record<string, string> }
type Sample = { ts: number; kind: string; pct: number }

const PROFILES = 'anthropic/profiles'
const ROUTES = 'anthropic/routes'
const SAMPLES = 'anthropic/samples'

// The env each provider needs in settings; the person's values fill the blanks.
function envFor(provider: Profile['provider'], opts: Record<string, string>): Record<string, string> {
  const pick: Record<string, string | undefined> =
    provider === 'bedrock'
      ? { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: opts.region, AWS_PROFILE: opts.profile }
      : provider === 'vertex'
        ? { CLAUDE_CODE_USE_VERTEX: '1', CLOUD_ML_REGION: opts.region, ANTHROPIC_VERTEX_PROJECT_ID: opts.project }
        : provider === 'gateway'
          ? { ANTHROPIC_BASE_URL: opts.url }
          : {}
  const all = { ...pick, ANTHROPIC_MODEL: opts.model }
  return Object.fromEntries(Object.entries(all).filter((kv): kv is [string, string] => kv[1] !== undefined))
}

const ALL_PROVIDER_KEYS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'AWS_REGION', 'AWS_PROFILE', 'CLOUD_ML_REGION', 'ANTHROPIC_VERTEX_PROJECT_ID', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL']

async function profiles($: EngineInterface): Promise<Profile[]> {
  return ((await $.store.get(PROFILES)) as Profile[] | undefined) ?? []
}

// Keeps a short history of each rate-limit window so the pace can be read off it.
export async function sampleLimits($: EngineInterface, usage: SessionUsage) {
  const now = await $.clock.now()
  const old = ((await $.store.get(SAMPLES)) as Sample[] | undefined) ?? []
  const fresh = usage.rateLimits.map(r => ({ ts: now, kind: r.kind, pct: r.percentUsed }))
  if (fresh.length) await $.store.set(SAMPLES, [...old, ...fresh].filter(x => now - x.ts < 6 * 3600_000).slice(-200))
}

// "at this pace you hit the five_hour limit in 40 minutes", per window with a rising reading.
export async function forecast($: EngineInterface): Promise<string[]> {
  const samples = ((await $.store.get(SAMPLES)) as Sample[] | undefined) ?? []
  const out: string[] = []
  for (const kind of new Set(samples.map(s => s.kind))) {
    const mine = samples.filter(s => s.kind === kind)
    // Only the run since the window last reset (a drop in percent).
    let from = 0
    for (let i = 1; i < mine.length; i++) if (mine[i]!.pct < mine[i - 1]!.pct) from = i
    const run = mine.slice(from)
    const first = run[0]
    const last = run.at(-1)
    if (!first || !last || last.ts === first.ts || last.pct <= first.pct) {
      if (last) out.push(`${kind}: ${Math.round(last.pct)}% used, not climbing`)
      continue
    }
    const perMin = (last.pct - first.pct) / ((last.ts - first.ts) / 60_000)
    const mins = Math.round((100 - last.pct) / perMin)
    out.push(`${kind}: ${Math.round(last.pct)}% used; at this pace the limit is hit in ${mins < 120 ? `${mins} minutes` : `${Math.round(mins / 60)} hours`}`)
  }
  return out
}

// The model a subagent type is routed to, if the person routed it.
export async function routeFor($: EngineInterface, subagentType: string): Promise<string | undefined> {
  const routes = ((await $.store.get(ROUTES)) as Record<string, string> | undefined) ?? {}
  return routes[subagentType] ?? routes['*']
}

export async function anthropicSummary($: EngineInterface): Promise<string> {
  const [who, usage, model, list, ahead] = await Promise.all([$.session.identity(), $.session.usage(), $.session.model(), profiles($), forecast($)])
  const routes = ((await $.store.get(ROUTES)) as Record<string, string> | undefined) ?? {}
  const account = who.deny === undefined ? `${who.kind}${who.email ? ` · ${who.email}` : ''}${who.organizationId ? ` · org ${who.organizationId}` : ''}` : 'not known'
  return [
    `Signed in: ${account}`,
    `Model: ${model} · session cost $${(usage.cost?.usd ?? 0).toFixed(2)}`,
    ...(usage.rateLimits.length ? usage.rateLimits.map(r => `Limit ${r.kind}: ${Math.round(r.percentUsed)}%${r.resetsAt ? ` (resets ${r.resetsAt})` : ''}`) : ['No rate-limit window reported (API key or provider billing).']),
    ...ahead,
    `Profiles: ${list.map(p => `${p.name} (${p.provider})`).join(', ') || 'none · /anthropic add <name> subscription|api|bedrock|vertex|gateway [model=…] [region=…] [profile=…] [project=…] [url=…]'}`,
    `Agent routes: ${Object.entries(routes).map(([t, m]) => `${t} → ${m}`).join(', ') || 'none · /anthropic route <agent type|*> <model>'}`,
    'Switching the signed-in claude.ai account is /login; a profile applies to the next session.',
  ].join('\n')
}

// Writes the profile's env into this project's local settings, clearing the other providers' keys.
async function use($: EngineInterface, name: string): Promise<string> {
  const p = (await profiles($)).find(x => x.name === name)
  if (p === undefined) return `No profile ${name}.`
  const root = (await $.session.repo())?.root ?? (await $.session.cwd())
  const path = `${root}/.claude/settings.local.json`
  let settings: { env?: Record<string, string> } & Record<string, unknown> = {}
  try {
    settings = JSON.parse(await $.fs.read(path)) as typeof settings
  } catch {
    // no local settings yet
  }
  const env = Object.fromEntries(Object.entries(settings.env ?? {}).filter(([k]) => !ALL_PROVIDER_KEYS.includes(k)))
  const next = { ...settings, env: { ...env, ...p.env } }
  const answer = await $.ui.ask(`Write profile "${p.name}" (${p.provider}) into ${path}?\n${JSON.stringify(p.env)}\nIt takes effect in the next session started here.`, {
    header: 'Profile',
    options: ['Write it', 'Cancel'],
  })
  if (answer !== 'Write it') return 'Nothing written.'
  await $.fs.write(path, JSON.stringify(next, null, 2) + '\n')
  await log($, 'identity', 'you', `anthropic profile ${p.name} (${p.provider}) set for ${root}`)
  return `Profile ${p.name} is set for ${root}. Start a new session here to use it${p.provider === 'subscription' ? '; run /login to pick the claude.ai account' : ''}.`
}

// `/anthropic`: show | add <name> <provider> [k=v…] | remove <name> | use <name> | route <type|*> <model> | unroute <type|*>
export async function anthropicCommand($: EngineInterface, args: string): Promise<string> {
  const [verb = '', name = '', ...rest] = args.trim().split(/\s+/)
  if (!verb || verb === 'show') return anthropicSummary($)
  const list = await profiles($)
  if (verb === 'add') {
    const provider = rest[0] as Profile['provider'] | undefined
    if (!provider || !['subscription', 'api', 'bedrock', 'vertex', 'gateway'].includes(provider)) return 'Provider is one of subscription, api, bedrock, vertex, gateway.'
    const opts = Object.fromEntries(rest.slice(1).map(kv => kv.split('=') as [string, string]).filter(([k, v]) => k && v))
    const p: Profile = { name, provider, env: envFor(provider, opts) }
    await $.store.set(PROFILES, [...list.filter(x => x.name !== name), p])
    return `Profile ${name}: ${provider} ${JSON.stringify(p.env)}`
  }
  if (verb === 'remove') {
    await $.store.set(PROFILES, list.filter(x => x.name !== name))
    return `Removed ${name}.`
  }
  if (verb === 'use') return use($, name)
  if (verb === 'route' || verb === 'unroute') {
    const routes = ((await $.store.get(ROUTES)) as Record<string, string> | undefined) ?? {}
    if (verb === 'route' && !rest[0]) return 'Usage: /anthropic route <agent type|*> <model>'
    const next = { ...routes }
    if (verb === 'route') next[name] = rest[0]!
    else delete next[name]
    await $.store.set(ROUTES, next)
    return verb === 'route' ? `${name} agents now run on ${rest[0]}.` : `${name} agents choose their own model again.`
  }
  return 'Usage: /anthropic [add <name> <provider> [k=v…] | remove <name> | use <name> | route <type|*> <model> | unroute <type|*>]'
}

export function anthropic(on: On) {
  on('command.run', { command: 'anthropic' }, async ($, e) => ({ text: await anthropicCommand($, e.args) }))
}
