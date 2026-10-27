import type { EngineInterface, On } from 'claude-code'

import { log } from './events'
import { memoryBlock, memoryCommand, needsMemory } from './memory'
import { tickets } from './tickets'
import { clip } from './util'

// Prefixes that become a command of the mod: `@council 6 …` runs `/council 6 …`.
const TO_COMMAND: Record<string, string> = {
  '@council': 'council',
  '@jira': 'ticket',
  '@notion': 'ticket',
  '@linear': 'ticket',
  '@ticket': 'ticket',
  '@gh': 'account',
  '@office': 'office',
}

async function shell($: EngineInterface, line: string) {
  const cwd = await $.session.cwd()
  // ponytail: sh first, cmd.exe where there is no sh (plain Windows)
  for (const argv of [['sh', '-c', line], ['cmd', '/c', line]]) {
    try {
      const r = await $.process.run(argv, { cwd, timeoutMs: 30_000 })
      const out = [r.stdout, r.stderr].filter(Boolean).join('\n').trimEnd()
      $.ui.log(`$ ${line}  (exit ${r.exitCode})\n${clip(out, 8_000)}`)
      await log($, 'tool_call', 'you', `$ ${line}`, { isDone: true, isError: r.exitCode !== 0 })
      return
    } catch {
      // not installed: try the next shell
    }
  }
  $.ui.log(`$ ${line}: no shell to run it in`)
}

async function toAgents($: EngineInterface, who: string, text: string): Promise<string | undefined> {
  const live = (await $.agent.list()).filter(a => a.status === 'running' || a.status === 'waiting' || a.status === 'idle' || a.status === 'pending')
  const targets = who === 'all' ? live : live.filter(a => a.name === who || a.id === who || a.teammateId === who)
  if (targets.length === 0) return undefined
  const sent = await Promise.all(targets.map(a => $.session.send({ to: a.teammateId ?? a.name ?? a.id, text })))
  return `Sent to ${sent.filter(r => r.isDelivered).length} of ${targets.length} agents.`
}

export function router(on: On) {
  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta || e.command) return next(e)
    const text = e.text.trim()
    await log($, 'prompt', undefined, text.replace(/\s+/g, ' '))

    if (text.startsWith('$ ')) {
      await shell($, text.slice(2))
      return { drop: 'Ran in the shell; output above.' }
    }

    const [head = '', ...rest] = text.split(/\s+/)
    const args = rest.join(' ')
    const lower = head.toLowerCase()

    if (lower === '@mem') {
      $.ui.log(await memoryCommand($, args))
      return { drop: 'Memory updated.' }
    }
    const command = TO_COMMAND[lower]
    if (command !== undefined) {
      // `@jira start X` keeps its tracker: `/ticket jira start X`.
      const ran = await $.command.run({ command, args: command === 'ticket' && lower !== '@ticket' ? `${lower.slice(1)} ${args}` : args })
      if (ran.text) $.ui.log(ran.text)
      return { drop: `Ran /${command}.` }
    }
    if (head.length > 1 && head.startsWith('@') && lower !== '@lead') {
      const said = await toAgents($, head.slice(1), args)
      if (said !== undefined) return { drop: said }
    }
    const memo = needsMemory() ? await memoryBlock($) : undefined
    return next({
      ...e,
      ...(lower === '@lead' ? { text: args } : {}),
      ...(memo ? { context: [...(e.context ?? []), memo] } : {}),
    })
  })

  // Suggest agents and prefixes after @, and ticket keys after a ticket verb.
  on('prompt.autocomplete', async ($, e, next) => {
    const theirs = await next(e)
    const token = e.token
    const before = e.text.slice(0, e.start).trim().split(/\s+/)
    let mine: { text: string; description?: string }[] = []
    if (token.startsWith('@')) {
      const agents = (await $.agent.list()).filter(a => a.status !== 'completed' && a.status !== 'killed')
      mine = [
        ...['@lead', '@all', '@council', '@jira', '@notion', '@linear', '@gh', '@mem', '@office'].map(p => ({ text: p, description: 'CompanyOS' })),
        ...agents.map(a => ({ text: `@${a.name ?? a.id}`, description: `${a.type}: ${a.description}` })),
      ].filter(x => x.text.toLowerCase().startsWith(token.toLowerCase()))
    } else if (['start', 'move', 'done', 'block'].includes(before.at(-1) ?? '')) {
      mine = (await tickets($))
        .filter(t => t.key.toLowerCase().startsWith(token.toLowerCase()))
        .map(t => ({ text: t.key, description: `${t.status} · ${t.title}` }))
    }
    return mine.length ? { suggestions: [...mine.slice(0, 10), ...theirs.suggestions] } : theirs
  })
}
