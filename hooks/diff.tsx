import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { Change } from '../types'
import { log } from './events'
import { clip, time } from './util'

export const DIFF = 'companyos-diff'
const MAX_CHANGES = 50
const MAX_BYTES = 200_000

const changes = atom({ plugin: 'companyos', key: 'changes' } as const, [], { shape: 'changes-1' })

export async function readChanges($: EngineInterface): Promise<Change[]> {
  return read($, changes)
}

async function text($: EngineInterface, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null // not there yet
  }
}

// One hunk around what changed: the common head and tail are context.
export function hunk(path: string, before: string, after: string): { diff: string; added: number; removed: number } {
  const a = before.split('\n')
  const b = after.split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const gone = a.slice(head, a.length - tail)
  const came = b.slice(head, b.length - tail)
  const ctx = 2
  const pre = a.slice(Math.max(0, head - ctx), head)
  const post = a.slice(a.length - tail, a.length - tail + ctx)
  const start = Math.max(0, head - ctx) + 1
  const diff = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${start},${pre.length + gone.length + post.length} +${start},${pre.length + came.length + post.length} @@`,
    ...pre.map(l => ' ' + l),
    ...gone.map(l => '-' + l),
    ...came.map(l => '+' + l),
    ...post.map(l => ' ' + l),
  ].join('\n')
  return { diff, added: came.length, removed: gone.length }
}

// Runs the edit and records what it did to the file, so the panel can show and undo it.
export async function recordEdit($: EngineInterface, path: string, agent: string | undefined, run: () => Promise<boolean>) {
  const before = await text($, path)
  const isDone = await run()
  if (!isDone) return
  const after = await text($, path)
  if (after === null || after === before) return
  const isRevertible = (before?.length ?? 0) < MAX_BYTES && after.length < MAX_BYTES
  const { added, removed } = hunk(path, before ?? '', after)
  const id = (await $.clock.now()).toString(36)
  const change: Change = {
    id,
    ts: await $.clock.now(),
    agent: agent ?? 'lead',
    file: path,
    before: isRevertible ? before : null,
    after: isRevertible ? after : '',
    isNew: before === null,
    added,
    removed,
  }
  await update($, changes, list => [...list, change].slice(-MAX_CHANGES))
}

async function revert($: EngineInterface, id: string): Promise<string> {
  const c = (await read($, changes)).find(x => x.id === id)
  if (c === undefined || c.isReverted) return 'Nothing to revert.'
  if (c.isNew) return `${c.file} was created by this change; delete it yourself if you want it gone.`
  if (c.before === null) return `${c.file} is too large to undo from here; use git.`
  if ((await text($, c.file)) !== c.after) return `${c.file} changed again since; revert the later change first.`
  await $.fs.write(c.file, c.before)
  await update($, changes, list => list.map(x => (x.id === id ? { ...x, isReverted: true } : x)))
  await log($, 'guard', 'you', `reverted ${c.agent}'s change to ${c.file} (+${c.added} −${c.removed})`, { isDone: true })
  // The agent learns why its work is gone, so it does not quietly redo it.
  await $.session.append({
    message: {
      type: 'user',
      content: [{ type: 'text', text: `The person reverted your change to ${c.file} (+${c.added} −${c.removed}) from the CompanyOS diff panel. Do not reapply it without asking them why.` }],
    },
  })
  return `Reverted ${c.file}.`
}

export async function diffTotals($: EngineInterface) {
  const live = (await read($, changes)).filter(c => !c.isReverted)
  return { added: live.reduce((n, c) => n + c.added, 0), removed: live.reduce((n, c) => n + c.removed, 0), files: new Set(live.map(c => c.file)).size }
}

export function diffs(on: On) {
  on('command.run', { command: 'diff' }, async ($, e) => {
    if (e.args.trim().startsWith('revert ')) return { text: await revert($, e.args.trim().slice(7)) }
    const opened = await $.ui.open({ id: DIFF, title: 'CompanyOS · changes' })
    return { text: opened.isPlaced ? 'Diff panel opened.' : `Diff panel waits: ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: DIFF }, async ($, e) => {
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    const list = [...(await read($, changes))].reverse()
    const t = await diffTotals($)

    return (
      <Box flexDirection="column">
        <Text bold>
          +{t.added} −{t.removed} in {t.files} files
        </Text>
        {list.length === 0 && <Text dimColor>No edits yet.</Text>}
        {list.slice(0, 12).map(c => (
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Text dimColor={c.isReverted}>
                {time(c.ts)} {c.agent} {clip(c.file, e.props.bodyColumns - 40)} <Text color="diffAdded">+{c.added}</Text> <Text color="diffRemoved">−{c.removed}</Text>
                {c.isReverted ? ' reverted ' : ' '}
              </Text>
              {!c.isReverted && !c.isNew && c.before !== null && (
                <Button key={`revert-${c.id}`} plain onPress={() => revert($, c.id).then(msg => $.ui.toast(msg))}>
                  revert
                </Button>
              )}
            </Box>
            {!c.isReverted && c.before !== null && <Code format="diff" path={c.file} source={hunk(c.file, c.before, c.after).diff} />}
          </Box>
        ))}
      </Box>
    )
  })
}
