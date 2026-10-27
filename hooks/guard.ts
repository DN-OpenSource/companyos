import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions } from 'claude-code'

import { identityProblem, run } from './accounts'
import { log } from './events'

// How many guard questions wait on the person now; the band shows it.
const pending = atom({ plugin: 'companyos', key: 'pending' } as const, 0)

export async function readPending($: EngineInterface): Promise<number> {
  return read($, pending)
}

const RISKY: [RegExp, string][] = [
  [/\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r/, 'recursive force delete'],
  [/\bgit\s+push\b.*(--force\b|-f\b|--force-with-lease)/, 'force push'],
  [/\bgit\s+reset\s+--hard\b/, 'hard reset'],
  [/\bgit\s+clean\s+-[a-zA-Z]*f/, 'git clean'],
  [/\bgit\s+(branch\s+-D|checkout\s+--\s|restore\s+\.)/, 'discarding work'],
  [/\b(drop\s+(table|database)|truncate\s+table)\b/i, 'destructive SQL'],
]

// ponytail: well-known key shapes only; a real scanner (gitleaks) when one is installed
const SECRET =
  /(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|sk-(ant-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AIza[0-9A-Za-z_-]{35})/

async function ask($: EngineInterface, question: string): Promise<boolean> {
  await update($, pending, n => n + 1)
  try {
    const answer = await $.ui.ask(question, { header: 'CompanyOS', options: ['Allow once', 'Deny'] })
    return answer === 'Allow once'
  } finally {
    await update($, pending, n => Math.max(0, n - 1))
  }
}

async function editGuard($: EngineInterface, protectedPaths: string[], path: string, agentId: string | undefined) {
  const p = path.replace(/\\/g, '/')
  const hit = protectedPaths.find(x => p.includes(x))
  if (hit === undefined) return undefined
  const isAllowed = await ask($, `${agentId ?? 'Lead'} wants to edit protected path ${path}`)
  await log($, 'guard', agentId, `protected ${path} ${isAllowed ? 'allowed' : 'denied'}`, {
    isError: !isAllowed,
    isDone: true,
  })
  return isAllowed ? undefined : `CompanyOS: ${path} is protected (${hit}); the person denied the edit.`
}

export function guard(on: On, options: PluginOptions) {
  const protectedPaths = String(options.protectedPaths ?? '')
    .split(',')
    .map(s => s.trim().replace(/\\/g, '/'))
    .filter(Boolean)

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const who = await identityProblem($, e.command)
    if (who !== undefined) {
      await log($, 'identity', e.agentId, `blocked: ${who}`, { isError: true, isDone: true })
      $.ui.toast('CompanyOS blocked a commit or push: wrong account')
      return { deny: `CompanyOS: ${who}` }
    }

    if (/\bgit\s+(?:-[Cc]\s+\S+\s+)*commit\b/.test(e.command)) {
      const diff = (await run($, ['git', 'diff', '--cached', '-U0'], await $.session.cwd())) ?? ''
      const hit = diff.split('\n').find(l => l.startsWith('+') && SECRET.test(l))
      if (hit !== undefined) {
        await log($, 'guard', e.agentId, 'blocked commit: staged diff holds a key', { isError: true, isDone: true })
        return { deny: 'CompanyOS: the staged diff holds what looks like a secret key. Unstage it before committing.' }
      }
    }

    const risk = RISKY.find(([re]) => re.test(e.command))
    if (risk !== undefined) {
      const isAllowed = await ask($, `${e.agentId ?? 'Lead'} wants to run a ${risk[1]}:\n${e.command}`)
      await log($, 'guard', e.agentId, `${risk[1]} ${isAllowed ? 'allowed' : 'denied'}: ${e.command}`, {
        isError: !isAllowed,
        isDone: true,
      })
      if (!isAllowed) return { deny: `CompanyOS: the person denied this ${risk[1]}.` }
    }

    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'CompanyOS: its Bash guard failed.' }))

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const deny = await editGuard($, protectedPaths, e.file_path, e.agentId)
    return deny === undefined ? next(e) : { deny }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'CompanyOS: its edit guard failed.' }))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const deny = await editGuard($, protectedPaths, e.file_path, e.agentId)
    return deny === undefined ? next(e) : { deny }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'CompanyOS: its write guard failed.' }))
}
