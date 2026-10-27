import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderInput } from 'claude-code'

import type { Change, Segment } from '../types'
import { log } from './events'
import { clip, COL } from './util'

export const DIFF = 'companyos-diff'
const MAX_CHANGES = 30
const MAX_BYTES = 200_000
// JSX compiles to h(): never name a variable h in this file.
// The line diff is quadratic; past this many lines on both sides an edit is one hunk.
const MAX_LCS = 1_500 * 1_500
const CONTEXT = 2

const changes = atom({ plugin: 'companyos', key: 'changes' } as const, [], { shape: 'changes-2' })

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

// Equal runs and changed runs, from a longest-common-subsequence line diff.
export function segments(before: string, after: string): Segment[] {
  const a = before.split('\n')
  const b = after.split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const x = a.slice(head, a.length - tail)
  const y = b.slice(head, b.length - tail)

  const mid: Segment[] = []
  const push = (kind: 'eq' | 'del' | 'add', line: string) => {
    const last = mid.at(-1)
    if (kind === 'eq') {
      if (last && 'eq' in last) last.eq.push(line)
      else mid.push({ eq: [line] })
    } else if (last && 'del' in last) {
      last[kind].push(line)
    } else {
      mid.push(kind === 'del' ? { del: [line], add: [] } : { del: [], add: [line] })
    }
  }
  if (x.length * y.length > MAX_LCS) {
    if (x.length || y.length) mid.push({ del: x, add: y })
  } else {
    const n = x.length
    const m = y.length
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = x[i] === y[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!)
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && x[i] === y[j]) {
        push('eq', x[i]!)
        i++
        j++
      } else if (j < m && (i === n || L[i]![j + 1]! >= L[i + 1]![j]!)) push('add', y[j++]!)
      else push('del', x[i++]!)
    }
  }
  return [...(head ? [{ eq: a.slice(0, head) }] : []), ...mid, ...(tail ? [{ eq: a.slice(a.length - tail) }] : [])]
}

// The file as it reads with the given hunks reverted (hunks counted in order of the changed runs).
export function compose(segs: Segment[], reverted: readonly number[]): string {
  let k = -1
  return segs
    .flatMap(s => {
      if ('eq' in s) return s.eq
      k++
      return reverted.includes(k) ? s.del : s.add
    })
    .join('\n')
}

// Each changed run as a unified-diff hunk with a little context, numbered as compose counts them.
export function hunks(path: string, segs: Segment[]): { diff: string; added: number; removed: number }[] {
  const out: { diff: string; added: number; removed: number }[] = []
  let line = 1
  segs.forEach((s, i) => {
    if ('eq' in s) {
      line += s.eq.length
      return
    }
    const prev = segs[i - 1]
    const next = segs[i + 1]
    const pre = prev && 'eq' in prev ? prev.eq.slice(-CONTEXT) : []
    const post = next && 'eq' in next ? next.eq.slice(0, CONTEXT) : []
    const start = line - pre.length
    out.push({
      diff: [
        `--- a/${path}`,
        `+++ b/${path}`,
        `@@ -${start},${pre.length + s.del.length + post.length} +${start},${pre.length + s.add.length + post.length} @@`,
        ...pre.map(l => ' ' + l),
        ...s.del.map(l => '-' + l),
        ...s.add.map(l => '+' + l),
        ...post.map(l => ' ' + l),
      ].join('\n'),
      added: s.add.length,
      removed: s.del.length,
    })
    line += s.del.length
  })
  return out
}

const changedRuns = (c: Change) => c.segments.filter(s => !('eq' in s)).length
const isAllReverted = (c: Change) => c.reverted.length >= changedRuns(c)

// Runs the edit and records what it did to the file, so the panel can show and undo it.
export async function recordEdit($: EngineInterface, path: string, agent: string | undefined, run: () => Promise<boolean>) {
  const before = await text($, path)
  const isDone = await run()
  if (!isDone) return
  const after = await text($, path)
  if (after === null || after === before) return
  const isRevertible = before !== null && before.length < MAX_BYTES && after.length < MAX_BYTES
  const segs = isRevertible ? segments(before, after) : []
  const now = await $.clock.now()
  const all = hunks(path, segs)
  const change: Change = {
    id: now.toString(36),
    ts: now,
    agent: agent ?? 'lead',
    file: path,
    segments: segs,
    isNew: before === null,
    isRevertible,
    added: isRevertible ? all.reduce((n, x) => n + x.added, 0) : after.split('\n').length,
    removed: isRevertible ? all.reduce((n, x) => n + x.removed, 0) : 0,
    reverted: [],
  }
  await update($, changes, list => [...list, change].slice(-MAX_CHANGES))
}

// Reverts the listed hunks of a change (all of them when none is named).
export async function revert($: EngineInterface, id: string, only?: number): Promise<string> {
  const c = (await read($, changes)).find(x => x.id === id)
  if (c === undefined || isAllReverted(c)) return 'Nothing to revert.'
  if (c.isNew) return `${c.file} was created by this change; delete it yourself if you want it gone.`
  if (!c.isRevertible) return `${c.file} is too large to undo from here; use git or /checkpoint.`
  const runs = changedRuns(c)
  const wanted = only === undefined ? Array.from({ length: runs }, (_, k) => k) : [only]
  if (wanted.some(k => k < 0 || k >= runs)) return `No hunk ${only} in that change.`
  if ((await text($, c.file)) !== compose(c.segments, c.reverted)) return `${c.file} changed again since; revert the later change first.`
  const reverted = [...new Set([...c.reverted, ...wanted])]
  await $.fs.write(c.file, compose(c.segments, reverted))
  await update($, changes, list => list.map(x => (x.id === id ? { ...x, reverted } : x)))
  const what = only === undefined ? 'change' : `hunk ${only + 1} of ${runs} of the change`
  await log($, 'guard', 'you', `reverted ${what} ${c.agent} made to ${c.file}`, { isDone: true })
  // The agent learns why its work is gone, so it does not quietly redo it.
  await $.session.append({
    message: {
      type: 'user',
      content: [{ type: 'text', text: `The person reverted ${what} you made to ${c.file} from the CompanyOS diff panel. Re-read the file, and do not reapply it without asking them why.` }],
    },
  })
  return `Reverted ${what} to ${c.file}.`
}

export async function diffTotals($: EngineInterface) {
  const live = (await read($, changes)).filter(c => !isAllReverted(c))
  let added = 0
  let removed = 0
  for (const c of live) {
    if (!c.isRevertible) {
      added += c.added
      continue
    }
    hunks(c.file, c.segments).forEach((x, k) => {
      if (c.reverted.includes(k)) return
      added += x.added
      removed += x.removed
    })
  }
  return { added, removed, files: new Set(live.map(c => c.file)).size }
}

export async function diffBody($: EngineInterface, e: RenderInput<'Pane'>) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const list = await read($, changes)
  const width = e.props.bodyColumns
  // Every hunk of every change, numbered in order, newest change last as the design lists them.
  type Card = { c: Change; k: number; seg: ReturnType<typeof hunkCards>[number]['seg'] | undefined; isReverted: boolean }
  const cards = list.flatMap((c): Card[] =>
    c.isRevertible ? hunkCards(c).map(({ k, seg }) => ({ c, k, seg, isReverted: c.reverted.includes(k) })) : [{ c, k: -1, seg: undefined, isReverted: false }],
  )
  const shown = cards.slice(-12)

  return (
    <Box flexDirection="column">
      {cards.length === 0 && <Text dimColor>No edits yet.</Text>}
      {shown.map((card, n) => (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Text dimColor={card.isReverted}>
              <Text color={COL.acc}>{card.c.agent.padEnd(8)}</Text>
              {clip(card.c.file, Math.max(12, width - 40)).padEnd(Math.min(36, Math.max(12, width - 40)))}
              <Text dimColor> hunk {cards.length - shown.length + n + 1} </Text>
            </Text>
            {card.k >= 0 && !card.isReverted && !card.c.isNew && (
              <Button key={`revert-${card.c.id}-${card.k + 1}`} plain onPress={() => revert($, card.c.id, card.k).then(msg => $.ui.toast(msg))}>
                <Text color={COL.fg}>[ r: revert ]</Text>
              </Button>
            )}
            {card.isReverted && <Text dimColor>[ reverted ]</Text>}
            {card.k < 0 && <Text dimColor>[ too large to show · use git ]</Text>}
          </Box>
          {card.seg &&
            [...card.seg.pre.map(l => [' ', l] as const), ...card.seg.del.map(l => ['-', l] as const), ...card.seg.add.map(l => ['+', l] as const), ...card.seg.post.map(l => [' ', l] as const)].map(([sign, l]) => (
              <Text
                dimColor={card.isReverted}
                {...(sign === '+' ? { backgroundColor: COL.plusBg } : sign === '-' ? { backgroundColor: COL.minusBg } : {})}
              >
                {clip(`${sign} ${l}`, width - 2).padEnd(Math.max(10, width - 2))}
              </Text>
            ))}
        </Box>
      ))}
    </Box>
  )
}

// Each changed run of a change with two lines of context either side, numbered as compose counts them.
function hunkCards(c: Change): { k: number; seg: { pre: string[]; del: string[]; add: string[]; post: string[] } }[] {
  const out: { k: number; seg: { pre: string[]; del: string[]; add: string[]; post: string[] } }[] = []
  let k = 0
  c.segments.forEach((s, i) => {
    if ('eq' in s) return
    const prev = c.segments[i - 1]
    const next = c.segments[i + 1]
    out.push({ k: k++, seg: { pre: prev && 'eq' in prev ? prev.eq.slice(-CONTEXT) : [], del: s.del, add: s.add, post: next && 'eq' in next ? next.eq.slice(0, CONTEXT) : [] } })
  })
  return out
}

export function diffs(on: On) {
  on('ui.render', { component: 'Pane', requestId: DIFF }, ($, e) => diffBody($, e))
}
