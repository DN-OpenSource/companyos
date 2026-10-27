import type { EngineInterface, On } from 'claude-code'

import { log } from './events'
import { memoryCommand } from './memory'
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
    if (lower === '@lead') return next({ ...e, text: args })
    if (head.length > 1 && head.startsWith('@')) {
      const said = await toAgents($, head.slice(1), args)
      if (said !== undefined) return { drop: said }
    }
    return next(e)
  })
}
