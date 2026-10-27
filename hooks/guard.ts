import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions } from 'claude-code'

import { identityProblem, run } from './accounts'
import { convene } from './council'
import { readChanges } from './diff'
import { checkpoints } from './sessions'
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
export const SECRET =
  /(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|sk-(ant-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AIza[0-9A-Za-z_-]{35})/

// Allow, deny, or hand the call to a council of 3 that votes allow or deny.
// Counts the files under a path, up to a cap, without a shell.
async function countFiles($: EngineInterface, path: string, cap = 5000): Promise<number> {
  let n = 0
  const walk = async (dir: string): Promise<void> => {
    if (n >= cap) return
    let list: { name: string; kind: string }[] = []
    try {
      list = await $.fs.list(dir)
    } catch {
      return
    }
    for (const f of list) {
      if (n >= cap) return
      if (f.kind === 'dir') await walk(`${dir}/${f.name}`)
      else n++
    }
  }
  try {
    const stat = await $.fs.stat(path)
    if (stat.kind !== 'dir') return 1
  } catch {
    return 0
  }
  await walk(path)
  return n
}

// What a risky command would do, in the design's words, and whether a checkpoint covers it.
async function blastRadius($: EngineInterface, command: string, what: string): Promise<string> {
  const cwd = await $.session.cwd()
  let effect = `a ${what}`
  if (what === 'recursive force delete') {
    const targets = command.replace(/^.*?\brm\s+(-\S+\s+)*/, '').split(/\s*(?:&&|;|\|)\s*/)[0]?.split(/\s+/).filter(t => t && !t.startsWith('-')) ?? []
    const counts = await Promise.all(targets.map(t => countFiles($, /^([A-Za-z]:|\/)/.test(t) ? t : `${cwd}/${t}`)))
    const total = counts.reduce((a, b) => a + b, 0)
    effect = `Deletes ${total >= 5000 ? '5000+' : total} files in ${targets.map(t => (t.startsWith('.') || t.startsWith('/') ? t : `./${t}`)).join(', ') || 'the target'}`
  } else if (what === 'force push') effect = 'Rewrites history on the remote branch'
  else if (what === 'hard reset' || what === 'discarding work') effect = 'Discards uncommitted changes'
  else if (what === 'git clean') effect = 'Deletes untracked files'
  else if (what === 'destructive SQL') effect = 'Drops data'
  const root = (await $.session.repo())?.root
  const cps = root ? await checkpoints($, root) : []
  const lastEdit = Math.max(0, ...(await readChanges($)).map(c => c.ts))
  const covering = cps.findLastIndex(c => c.ts >= lastEdit)
  return `${effect} · ${covering >= 0 ? `checkpoint cp-${String(covering + 1).padStart(2, '0')} covers it` : 'not in a checkpoint'}`
}

async function ask($: EngineInterface, question: string): Promise<boolean> {
  await update($, pending, n => n + 1)
  try {
    const answer = await $.ui.ask(question, { header: 'companyos', options: ['Allow once', 'Deny', 'Council of 3 votes'] })
    if (answer !== 'Council of 3 votes') return answer === 'Allow once'
    const verdict = await convene($, 3, `${question}
A) allow it B) deny it`)
    return verdict.chosen === 'allow it' && !verdict.needsYou
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
      const isAllowed = await ask($, `⚠ Destructive command held by companyos\nBash(${e.command})\n${await blastRadius($, e.command, risk[1])}`)
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
