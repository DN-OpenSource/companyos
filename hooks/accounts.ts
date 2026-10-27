import type { EngineInterface, On } from 'claude-code'

import type { Binding } from '../types'
import { log } from './events'

const COMMIT = /\bgit\s+(?:-[Cc]\s+\S+\s+)*commit\b/
const PUSH = /\bgit\s+(?:-[Cc]\s+\S+\s+)*push\b|\bgh\s+pr\s+(?:create|merge)\b/
const TTL = 60_000

const keyOf = (root: string) => `accounts/${root}`

async function run($: EngineInterface, argv: string[], cwd?: string) {
  try {
    const r = await $.process.run(argv, { cwd, timeoutMs: 8_000 })
    return r.exitCode === 0 ? r.stdout.trim() : undefined
  } catch {
    return undefined // not installed, timed out
  }
}

// ponytail: gh login cached per module for a minute; a switch clears it
let ghCache: { login: string | undefined; at: number } | undefined

async function ghLogin($: EngineInterface) {
  const now = await $.clock.now()
  if (ghCache === undefined || now - ghCache.at > TTL) {
    ghCache = { login: await run($, ['gh', 'api', 'user', '--jq', '.login']), at: now }
  }
  return ghCache.login
}

async function bound($: EngineInterface) {
  const repo = await $.session.repo()
  if (repo === null) return undefined
  const binding = (await $.store.get(keyOf(repo.root))) as Binding | undefined
  return { root: repo.root, binding }
}

export async function statusLine($: EngineInterface) {
  const b = await bound($)
  return b?.binding ? ` · gh:${b.binding.login}` : ''
}

async function show($: EngineInterface) {
  const b = await bound($)
  if (b === undefined) return 'Not in a git repository.'
  const [email, login, who] = await Promise.all([
    run($, ['git', 'config', 'user.email'], b.root),
    ghLogin($),
    $.session.identity(),
  ])
  const claude = who.deny === undefined ? `${who.kind}${who.email ? ` (${who.email})` : ''}` : 'unknown'
  return [
    `Repo:      ${b.root}`,
    `Bound to:  ${b.binding ? `${b.binding.login} <${b.binding.email ?? 'any email'}>` : 'nothing (/account bind <login> [email])'}`,
    `gh active: ${login ?? 'unknown (gh missing or signed out)'}`,
    `git email: ${email ?? 'unset'}`,
    `Claude:    ${claude}`,
  ].join('\n')
}

export function accounts(on: On) {
  on('command.run', { command: 'account' }, async ($, e) => {
    const [verb, login, email] = e.args.trim().split(/\s+/)
    const b = await bound($)

    if (!verb) return { text: await show($) }
    if (b === undefined) return { text: 'Not in a git repository.' }

    if (verb === 'bind' && login) {
      const binding: Binding = {
        login,
        email: email ?? (await run($, ['git', 'config', 'user.email'], b.root)),
      }
      await $.store.set(keyOf(b.root), binding)
      await log($, 'identity', undefined, `bound ${b.root} to ${login}`)
      return { text: `Bound ${b.root} to ${login} <${binding.email ?? 'any email'}>.` }
    }
    if (verb === 'unbind') {
      await $.store.delete(keyOf(b.root))
      await log($, 'identity', undefined, `unbound ${b.root}`)
      return { text: `Unbound ${b.root}.` }
    }
    if (verb === 'switch' && login) {
      const out = await run($, ['gh', 'auth', 'switch', '--user', login])
      ghCache = undefined
      await log($, 'identity', undefined, `gh switch ${login}: ${out === undefined ? 'failed' : 'ok'}`, {
        isError: out === undefined,
      })
      return { text: out === undefined ? `gh auth switch to ${login} failed.` : `gh now acts as ${login}.` }
    }
    return { text: 'Usage: /account [bind <login> [email] | unbind | switch <login>]' }
  })

  // Mismatch guard: the wrong identity never commits or pushes in a bound repo.
  // ponytail: checks the session's repo, not a `cd elsewhere &&` inside the command
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const isCommit = COMMIT.test(e.command)
    const isPush = PUSH.test(e.command)
    if (!isCommit && !isPush) return next(e)

    const b = await bound($)
    if (!b?.binding) return next(e)
    const { login, email } = b.binding

    let why: string | undefined
    if (isCommit && email) {
      const have = await run($, ['git', 'config', 'user.email'], b.root)
      if (have !== email) why = `git email is ${have ?? 'unset'}, this repo is bound to ${email}. Run: git config user.email ${email}`
    }
    if (why === undefined && isPush) {
      const have = await ghLogin($)
      if (have !== login) why = `gh acts as ${have ?? 'nobody'}, this repo is bound to ${login}. Run: /account switch ${login}`
    }
    if (why === undefined) return next(e)

    await log($, 'identity', e.agentId, `blocked: ${why}`, { isError: true, isDone: true })
    $.ui.toast(`CompanyOS blocked a ${isPush ? 'push' : 'commit'}: wrong account`)
    return { deny: `CompanyOS: ${why}` }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'CompanyOS: the account guard failed; check /account.' },
  )
}
