import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { CosEvent } from '../types'
import { skillOf } from './util'

// One event stream, two renderings: technical or plain language.
const mode = atom({ plugin: 'companyos', key: 'mode' } as const, 'technical')

export async function setMode($: EngineInterface, to: 'plain' | 'technical') {
  await update($, mode, () => to)
}

export async function isPlain($: EngineInterface): Promise<boolean> {
  return (await read($, mode)) === 'plain'
}

const who = (agent: string) => (agent === 'lead' ? 'The lead' : agent === 'you' ? 'You' : agent.charAt(0).toUpperCase() + agent.slice(1))
const base = (path: string) => path.split(/[\\/]/).pop() ?? path

function doing(detail: string): string {
  const [tool = '', ...rest] = detail.split(' ')
  const arg = rest.join(' ')
  if (tool === 'Read') return `reading ${base(arg)}`
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') return `updating ${base(arg)}`
  if (tool === 'Bash' || tool === '$') {
    if (/\b(test|pytest|jest|vitest|go test|cargo test)\b/.test(arg)) return 'running the tests'
    if (/\bgit\s+commit\b/.test(arg)) return 'saving a checkpoint of the work'
    if (/\bgit\s+push\b/.test(arg)) return 'sharing the work with the team'
    if (/\b(npm|pnpm|yarn|pip|cargo)\s+(install|add)\b/.test(arg)) return 'installing a dependency'
    return 'running a command'
  }
  if (tool === 'Grep' || tool === 'Glob') return 'searching the code'
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'looking something up online'
  if (tool === 'Agent') return 'asking a teammate for help'
  if (tool.startsWith('mcp__')) return `using ${tool.split('__')[1] ?? 'a connected app'}`
  return `using ${tool || 'a tool'}`
}

// What a person who has never seen a terminal reads for this event.
export function plain(x: CosEvent): string {
  const w = who(x.agent)
  switch (x.kind) {
    case 'prompt':
      return `${x.agent === 'you' ? 'You ran' : 'You asked'}: ${x.detail}`
    case 'tool_call':
      return x.isError ? `Something failed while ${doing(x.detail)}; ${w.toLowerCase()} is looking at it` : `${w} is ${doing(x.detail)}`
    case 'skill_load':
      return `${w} picked up the ${skillOf(x.detail)} playbook`
    case 'delegation':
      return `${w} handed work to a teammate: ${x.detail.split(': ').slice(1).join(': ') || x.detail}`
    case 'compaction':
      return 'The team tidied its notes; older details were summarised'
    case 'turn':
      return x.isError ? `${w} hit a problem and stopped` : `${w} finished a step`
    case 'identity':
    case 'guard':
      return x.isError ? `A safety check stopped something risky: ${x.detail.replace(/^blocked:?\s*/, '')}` : `A safety check passed: ${x.detail}`
    case 'memory':
      return `The team's notebook: ${x.detail}`
    case 'vote':
      return `Team vote: ${x.detail}`
    case 'ticket_update':
      return `Ticket ${x.detail}`
  }
}

export function modes(on: On) {
  on('command.run', { command: 'mode' }, async ($, e) => {
    const asked = e.args.trim()
    const now = await update($, mode, m => (asked === 'plain' || asked === 'technical' ? asked : m === 'plain' ? 'technical' : 'plain'))
    return { text: `CompanyOS now reads in ${now === 'plain' ? 'plain language' : 'technical'} mode.` }
  })
}
