import type { EngineInterface, On } from 'claude-code'

import { run } from './accounts'
import { log, readEvents } from './events'
import { plain } from './mode'
import { clip, day } from './util'

export type Checkpoint = { id: string; sha: string; label: string; ts: number }

async function rootOf($: EngineInterface) {
  return (await $.session.repo())?.root
}

export async function checkpoints($: EngineInterface, root: string): Promise<Checkpoint[]> {
  return ((await $.store.get(`checkpoints/${root}`)) as Checkpoint[] | undefined) ?? []
}

// `git stash create` snapshots the working tree as a commit without touching it; a clean tree is HEAD.
async function checkpoint($: EngineInterface, label: string): Promise<string> {
  const root = await rootOf($)
  if (root === undefined) return 'Checkpoints need a git repository.'
  const sha = (await run($, ['git', 'stash', 'create', label || 'companyos checkpoint'], root)) || (await run($, ['git', 'rev-parse', 'HEAD'], root))
  if (!sha) return 'git could not snapshot the workspace.'
  // Keep the snapshot reachable so git gc leaves it alone.
  await run($, ['git', 'update-ref', `refs/companyos/${sha.slice(0, 12)}`, sha], root)
  const now = await $.clock.now()
  const cp: Checkpoint = { id: now.toString(36).slice(-5), sha, label: label || `turn ${await $.session.turns()}`, ts: now }
  await $.store.set(`checkpoints/${root}`, [...(await checkpoints($, root)), cp].slice(-30))
  await log($, 'guard', 'you', `checkpoint #${cp.id}: ${cp.label}`, { isDone: true })
  return `Checkpoint #${cp.id} (${sha.slice(0, 8)}): ${cp.label}`
}

export async function restore($: EngineInterface, id: string): Promise<string> {
  const root = await rootOf($)
  if (root === undefined) return 'Checkpoints need a git repository.'
  const cp = (await checkpoints($, root)).find(c => c.id === id)
  if (cp === undefined) return `No checkpoint #${id}.`
  const answer = await $.ui.ask(
    `Restore checkpoint #${cp.id} (${cp.label})? Tracked files go back to that moment; files created since stay. A new checkpoint of now is taken first.`,
    { header: 'Restore', options: ['Restore', 'Cancel'] },
  )
  if (answer !== 'Restore') return 'Restore cancelled.'
  const safety = await checkpoint($, `before restoring #${cp.id}`)
  const out = await run($, ['git', 'checkout', cp.sha, '--', '.'], root)
  if (out === undefined) return `git could not restore #${cp.id}. ${safety}`
  await log($, 'guard', 'you', `restored checkpoint #${cp.id}`, { isDone: true })
  await $.session.append({
    message: { type: 'user', content: [{ type: 'text', text: `The person restored the workspace to checkpoint "${cp.label}". Files may differ from what you last read; re-read before editing.` }] },
  })
  return `Restored #${cp.id}. ${safety}`
}

async function write($: EngineInterface, name: string, text: string) {
  const path = `${await $.session.cwd()}/.companyos/${name}`
  await $.fs.write(path, text)
  return path
}

// A session as a file another person or a later session can replay.
async function replay($: EngineInterface): Promise<string> {
  const [id, messages, events] = await Promise.all([$.session.id(), $.session.messages(), readEvents($)])
  return write($, `replay-${id}.json`, JSON.stringify({ session: id, messages, events }, null, 1))
}

async function handover($: EngineInterface): Promise<string> {
  const events = await readEvents($)
  const messages = (await $.session.messages()).slice(-30)
  const story = events.filter(x => x.kind !== 'turn').slice(-120).map(plain).join('\n')
  const said = messages.map(m => `${m.role}: ${clip(m.text, 400)}`).join('\n')
  const r = await $.model.complete({
    model: await $.session.model(),
    maxTokens: 1500,
    system: 'You write a handover note so a colleague can continue a coding session. Be concrete and short.',
    prompt: `Events:\n${story}\n\nLast messages:\n${said}\n\nWrite Markdown with: ## Goal, ## Done, ## In progress, ## Next steps, ## Open questions, then ## In plain words (three sentences for a non-technical reader).`,
  })
  const body = r.isAnswered ? r.text : `(The model did not answer: ${r.reason}.)\n\n## Events\n${story}`
  return write($, `handover-${day(await $.clock.now())}.md`, `# Session handover\n\n${body}\n`)
}

export function sessions(on: On) {
  on('command.run', { command: 'checkpoint' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    if (verb === 'restore') return { text: await restore($, rest[0] ?? '') }
    if (verb === 'list') {
      const root = await rootOf($)
      const list = root ? await checkpoints($, root) : []
      return { text: list.map(c => `#${c.id} ${new Date(c.ts).toLocaleString()} ${c.sha.slice(0, 8)} ${c.label}`).join('\n') || 'No checkpoints yet.' }
    }
    return { text: await checkpoint($, e.args.trim()) }
  })

  on('command.run', { command: 'replay' }, async $ => ({ text: `Wrote ${await replay($)}` }))
  on('command.run', { command: 'handover' }, async $ => ({ text: `Wrote ${await handover($)}` }))
}
