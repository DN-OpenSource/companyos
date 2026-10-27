import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderInput } from 'claude-code'

import type { CosEvent } from '../types'
import { readEvents } from './events'
import { entries } from './memory'
import { skillOf } from './util'

export const GRAPH = 'companyos-graph'
const KINDS = ['agents', 'skills', 'files', 'memory', 'decisions', 'cost'] as const
type Kind = (typeof KINDS)[number]

const shown = atom({ plugin: 'companyos', key: 'graph' } as const, 'agents')

const node = (s: string) => '"' + s.replace(/"/g, "'").slice(0, 60) + '"'
const FENCE = '```'

// Repeated edges collapse into one, labelled with their count.
function edges(pairs: [string, string, string][]) {
  const seen = new Map<string, number>()
  for (const [a, rel, b] of pairs) {
    const edge = `${node(a)} -->|${rel}| ${node(b)}`
    seen.set(edge, (seen.get(edge) ?? 0) + 1)
  }
  return [...seen].map(([edge, n]) => (n > 1 ? edge.replace(/\|([^|]+)\|/, `|$1 ×${n}|`) : edge))
}

const FILE_TOOL = /^(Read|Edit|Write|MultiEdit|NotebookEdit) (.+)$/

async function mermaid($: EngineInterface, kind: Kind): Promise<string> {
  const list: CosEvent[] = await readEvents($)
  let lines: string[] = []
  if (kind === 'agents') {
    lines = edges(
      list
        .filter(x => x.kind === 'delegation')
        .map(x => [x.agent, 'delegated', x.detail.match(/→ ([^:]+):/)?.[1] ?? x.detail]),
    )
  } else if (kind === 'skills') {
    lines = edges(
      list
        .filter(x => x.kind === 'skill_load')
        .map(x => [x.agent, x.detail.includes('inherited') ? 'inherited' : 'loaded', skillOf(x.detail)]),
    )
  } else if (kind === 'files') {
    const pairs: [string, string, string][] = []
    for (const x of list) {
      const m = x.kind === 'tool_call' ? x.detail.match(FILE_TOOL) : null
      if (m) pairs.push([x.agent, m[1] === 'Read' ? 'read' : 'edited', m[2] ?? ''])
    }
    lines = edges(pairs)
  } else if (kind === 'memory') {
    lines = edges((await entries($)).map(m => [m.source, m.isPinned ? 'pinned' : 'remembers', m.text]))
  } else if (kind === 'decisions') {
    const keys = (await $.store.keys()).filter(k => k.startsWith('decisions/')).slice(-20)
    const verdicts = (await Promise.all(keys.map(k => $.store.get(k)))) as { question: string; chosen: string; split: string }[]
    lines = edges(verdicts.map(v => [v.question, `chose ${v.split}`, v.chosen]))
  } else {
    const spent = new Map<string, number>()
    for (const x of list) {
      if (x.kind === 'turn') spent.set(x.agent, (spent.get(x.agent) ?? 0) + (x.tokensIn ?? 0) + (x.tokensOut ?? 0))
    }
    lines = [...spent].map(([agent, t]) => `${node('session')} -->|${t} tok| ${node(agent)}`)
  }
  return ['graph LR', ...(lines.length ? lines : [node('nothing yet')]).map(l => '  ' + l)].join('\n')
}

export async function graphBody($: EngineInterface, e: RenderInput<'Pane'>) {
  const { Box, Button, Markdown, Text } = $.ui.resolve(e)
  const kind = (await read($, shown)) as Kind
  const text = await mermaid($, kind)
  const block = `${FENCE}mermaid\n${text}\n${FENCE}`

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {KINDS.map(k => (
          <Button
            key={`kind-${k}`}
            variant={k === kind ? 'primary' : undefined}
            onPress={() => update($, shown, () => k).then(() => {})}
          >
            {k}
          </Button>
        ))}
        <Button key="copy" onPress={press => $.ui.copy({ text: block, surface: press.surface }).then(() => {})}>
          copy mermaid
        </Button>
      </Box>
      <Markdown text={block} />
      <Text dimColor>{text.split('\n').length - 1} edges</Text>
    </Box>
  )
}

export function graph(on: On) {
  on('command.run', { command: 'graph' }, async ($, e) => {
    const asked = e.args.trim()
    const kind = (KINDS as readonly string[]).includes(asked) ? asked : 'agents'
    await update($, shown, () => kind)
    await $.ui.open({ id: GRAPH, title: 'CompanyOS · graphs' })
    return { text: `${kind} graph opened. Kinds: ${KINDS.join(', ')}.` }
  })

  on('ui.render', { component: 'Pane', requestId: GRAPH }, ($, e) => graphBody($, e))
}
