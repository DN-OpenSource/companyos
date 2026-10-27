import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, On } from 'claude-code'

import type { Council, CosEvent, MemoryEntry } from '../types'
import { run } from './accounts'
import { readCouncil } from './council'
import { readEvents } from './events'
import { entries } from './memory'
import { isPlain, plain } from './mode'
import { tickets } from './tickets'
import { clip, skillOf } from './util'

export const OFFICE = 'companyos-office'
const W = 72
const H = 22
const DEFAULT = 0x01000000

type Theme = { floor: number; wall: number; desk: number; accent: number; text: number }
const LOFT: Theme = { floor: 0x3b2f2a, wall: 0x8a5a44, desk: 0xc49a6c, accent: 0xf2c14e, text: 0xf5efe6 }

// Themes are JSON files in the mod's themes/ folder ({ floor, wall, desk, accent, text } as #rrggbb): drop one in to add it.
let themeCache: Record<string, Theme> | undefined

async function loadThemes($: EngineInterface): Promise<Record<string, Theme>> {
  if (themeCache) return themeCache
  const found: Record<string, Theme> = { loft: LOFT }
  try {
    for (const f of await $.fs.list(`${$.plugin.root}/themes`)) {
      if (!f.name.endsWith('.json')) continue
      const raw = JSON.parse(await $.fs.read(`${$.plugin.root}/themes/${f.name}`)) as Record<string, string>
      const rgb = (k: string, d: number) => (/^#[0-9a-f]{6}$/i.test(raw[k] ?? '') ? parseInt(raw[k]!.slice(1), 16) : d)
      found[f.name.slice(0, -5)] = { floor: rgb('floor', LOFT.floor), wall: rgb('wall', LOFT.wall), desk: rgb('desk', LOFT.desk), accent: rgb('accent', LOFT.accent), text: rgb('text', LOFT.text) }
    }
  } catch {
    // no themes folder: loft alone
  }
  themeCache = found
  return found
}

const STATUS_COLOR: Record<string, number> = {
  running: 0x4caf50,
  waiting: 0xffc107,
  pending: 0x90a4ae,
  idle: 0x8d6e63,
  failed: 0xf44336,
  killed: 0x616161,
  completed: 0x616161,
}

const theme = atom({ plugin: 'companyos', key: 'theme' } as const, '')
const tick = atom({ plugin: 'companyos', key: 'tick' } as const, 0)
const weather = atom({ plugin: 'companyos', key: 'weather' } as const, 'unknown')

type Cell = [number, number, number]
type Grid = Cell[]
type Achievement = { name: string; isUnlocked: boolean }

function blank(t: Theme): Grid {
  return Array.from({ length: W * H }, () => [32, t.text, t.floor] as Cell)
}
function put(g: Grid, x: number, y: number, ch: string, fg: number, bg?: number) {
  if (x < 0 || y < 0 || x >= W || y >= H) return
  const cell = g[y * W + x]!
  g[y * W + x] = [ch.codePointAt(0) ?? 32, fg, bg ?? cell[2]]
}
function write(g: Grid, x: number, y: number, s: string, fg: number, bg?: number) {
  ;[...s].forEach((ch, i) => put(g, x + i, y, ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) > 0x7e ? '?' : ch, fg, bg))
}
function room(g: Grid, t: Theme, x: number, y: number, w: number, h: number, label: string) {
  for (let i = x; i < x + w; i++) {
    put(g, i, y, '─', t.wall)
    put(g, i, y + h - 1, '─', t.wall)
  }
  for (let j = y; j < y + h; j++) {
    put(g, x, j, '│', t.wall)
    put(g, x + w - 1, j, '│', t.wall)
  }
  put(g, x, y, '┌', t.wall)
  put(g, x + w - 1, y, '┐', t.wall)
  put(g, x, y + h - 1, '└', t.wall)
  put(g, x + w - 1, y + h - 1, '┘', t.wall)
  write(g, x + 2, y, label.slice(0, w - 4), t.accent)
}

const ctxRgb = (pct: number) => (pct >= 90 ? 0xf44336 : pct >= 70 ? 0xffc107 : 0x4caf50)

type World = {
  t: Theme
  agents: AgentInfo[]
  events: CosEvent[]
  pct: number
  council: Council | null
  memories: MemoryEntry[]
  wall: { key: string; status: string; agent?: string }[]
  frame: number
  hour: number
  weather: string
}

function draw(w: World): Grid {
  const { t } = w
  const g = blank(t)
  const night = w.hour < 7 || w.hour >= 19
  // Day–night and CI weather through the windows along the top wall: sun when the last run passed, storm when it failed.
  const sky = w.weather === 'storm' ? 0x546e7a : night ? 0x1a237e : 0x81d4fa
  for (let x = 1; x < W - 1; x += 6) put(g, x, 0, w.weather === 'storm' && (x + w.frame) % 2 ? '/' : '▀', w.weather === 'storm' ? 0xb0bec5 : sky, w.weather === 'storm' ? sky : undefined)
  if (w.weather === 'sun') put(g, W - 3, 0, '*', 0xffeb3b)

  room(g, t, 0, 1, 16, 6, 'corner office')
  put(g, 7, 4, '@', 0x29b6f6) // you
  write(g, 3, 5, 'you', t.text)

  room(g, t, 16, 1, 22, 6, 'meeting room')
  const c = w.council
  const sitting = c !== null && c.status !== 'verdict'
  write(g, 18, 2, clip(c ? c.question : 'whiteboard empty', 18), t.text, 0x37474f)
  const seats = c?.seats ?? []
  seats.forEach((s, i) => {
    const color = s.vote === undefined ? 0x90a4ae : s.vote === 'veto' ? 0xf44336 : 0x4caf50
    put(g, 18 + (i % 9) * 2, 4, s.vote !== undefined && w.frame % 2 ? '^' : 'o', color)
  })
  if (c?.verdict) write(g, 18, 5, clip(`gavel: ${c.verdict.chosen} ${c.verdict.split}`, 18), t.accent)
  else if (sitting) write(g, 18, 5, `voting ${seats.filter(s => s.vote).length}/${c.size}`, t.accent)

  room(g, t, 38, 1, 16, 6, 'server room')
  const racks = 12
  const lit = Math.round((w.pct / 100) * racks * 3)
  for (let i = 0; i < racks; i++) {
    for (let j = 0; j < 3; j++) put(g, 40 + i, 2 + j, i * 3 + j < lit ? '▮' : '▯', i * 3 + j < lit ? ctxRgb(w.pct) : 0x455a64)
  }
  write(g, 40, 5, `${Math.round(w.pct)}% ctx`, t.text)
  if (w.events.slice(-5).some(x => x.kind === 'compaction')) put(g, 52, 5, w.frame % 2 ? '/' : '\\', t.accent) // janitor sweeping

  room(g, t, 54, 1, 18, 6, 'library')
  const skills = [...new Set(w.events.filter(x => x.kind === 'skill_load').map(x => skillOf(x.detail)))]
  const recent = new Set(w.events.slice(-8).filter(x => x.kind === 'skill_load').map(x => skillOf(x.detail)))
  skills.slice(0, 28).forEach((s, i) => put(g, 56 + (i % 14), 2 + Math.floor(i / 14), '▌', recent.has(s) && w.frame % 2 ? 0xffeb3b : t.desk))
  write(g, 56, 5, `${skills.length} books`, t.text)

  // Open-plan desks: the lead's big desk, then a desk per agent.
  room(g, t, 0, 7, 54, 9, 'open plan')
  write(g, 2, 9, '[====]', t.desk)
  const leadBusy = w.events.at(-1)?.kind === 'tool_call' && !w.events.at(-1)?.isDone
  put(g, 4, 10, '@', leadBusy && w.frame % 2 ? 0xffffff : 0x4caf50)
  write(g, 2, 11, 'lead', t.text)
  w.agents.slice(0, 12).forEach((a, i) => {
    const x = 10 + (i % 6) * 7
    const y = 9 + Math.floor(i / 6) * 3
    const isGone = a.status === 'completed' || a.status === 'killed'
    write(g, x, y, '[==]', t.desk)
    if (!isGone) put(g, x + 1, y + 1, a.status === 'running' && w.frame % 2 ? '&' : '@', STATUS_COLOR[a.status] ?? t.text)
    write(g, x, y + 2, (a.name ?? a.type).slice(0, 6), isGone ? 0x757575 : t.text)
  })

  room(g, t, 54, 7, 18, 9, 'ticket wall')
  ;(['In Progress', 'In Review', 'Blocked'] as const).forEach((col, i) => {
    write(g, 56, 8 + i * 2, col.slice(0, 7), t.accent)
    w.wall
      .filter(x => x.status === col)
      .slice(0, 6)
      .forEach((x, j) => put(g, 64 + j, 8 + i * 2, '■', col === 'Blocked' ? 0xf44336 : x.agent ? 0x4caf50 : 0x9e9e9e))
  })

  room(g, t, 0, 16, 14, 6, 'mailroom')
  const prompts = w.events.filter(x => x.kind === 'prompt').length
  const failed = w.events.filter(x => x.kind === 'turn' && x.isError).length
  write(g, 2, 18, `in ${'='.repeat(Math.min(8, prompts))}`, t.text)
  write(g, 2, 19, `bad ${'x'.repeat(Math.min(7, failed))}`, 0xf44336)

  room(g, t, 14, 16, 16, 6, 'filing room')
  const files = new Set(w.events.filter(x => x.kind === 'tool_call' && /^(Read|Edit|Write) /.test(x.detail)).map(x => x.detail))
  const edited = [...files].filter(f => !f.startsWith('Read')).length
  for (let i = 0; i < 12; i++) put(g, 16 + i, 18, '▤', i < files.size ? (i < edited ? t.accent : t.desk) : 0x455a64)
  if (w.events.some(x => x.kind === 'guard' && x.isError)) write(g, 16, 19, 'locked', 0xf44336)

  room(g, t, 30, 16, 12, 6, 'QA desk')
  const tests = w.events.filter(x => x.kind === 'tool_call' && /\btest\b/.test(x.detail)).slice(-1)[0]
  write(g, 32, 18, tests ? (tests.isError ? 'red' : tests.isDone ? 'green' : 'running') : 'idle', tests?.isError ? 0xf44336 : 0x4caf50)

  room(g, t, 42, 16, 14, 6, 'break area')
  const idle = w.agents.filter(a => a.status === 'idle').length
  write(g, 44, 18, `${'c'.repeat(Math.min(8, idle))} coffee`, t.desk)

  room(g, t, 56, 16, 16, 6, 'memory corner')
  write(g, 58, 18, 'E'.repeat(Math.min(6, 1 + Math.floor(w.memories.length / 5))), 0x9e9e9e) // the elephant grows
  write(g, 58, 19, `(${'~'.repeat(Math.round(w.pct / 20))}${' '.repeat(5 - Math.round(w.pct / 20))})`, 0x4fc3f7) // goldfish bowl
  return g
}

function cellsOf(g: Grid): string {
  const words = new Uint32Array(g.length * 3)
  g.forEach(([cp, fg, bg], i) => words.set([cp, fg, bg], i * 3))
  const bytes = new Uint8Array(words.buffer)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

const hex = (n: number) => (n === DEFAULT ? 'none' : '#' + n.toString(16).padStart(6, '0'))
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function svgOf(g: Grid, t: Theme): string {
  const cw = 10
  const ch = 18
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W * cw} ${H * ch}"><rect width="100%" height="100%" fill="${hex(t.floor)}"/>`]
  g.forEach(([cp, fg, bg], i) => {
    const x = (i % W) * cw
    const y = Math.floor(i / W) * ch
    if (bg !== t.floor) parts.push(`<rect x="${x}" y="${y}" width="${cw}" height="${ch}" fill="${hex(bg)}"/>`)
    if (cp !== 32) parts.push(`<text x="${x + 1}" y="${y + 14}" font-family="monospace" font-size="14" fill="${hex(fg)}">${esc(String.fromCodePoint(cp))}</text>`)
  })
  return parts.join('') + '</svg>'
}

function achievements(list: CosEvent[], council: Council | null): Achievement[] {
  const tools = list.filter(x => x.kind === 'tool_call')
  const bash = tools.filter(x => x.detail.startsWith('Bash'))
  return [
    { name: 'First council', isUnlocked: list.some(x => x.kind === 'vote' && x.detail.startsWith('verdict')) },
    { name: 'Hundred tool calls', isUnlocked: tools.length >= 100 },
    { name: 'Clean shell (20+ commands, none failed)', isUnlocked: bash.length >= 20 && bash.every(x => !x.isError) },
    { name: 'Unanimous council of 9', isUnlocked: council?.size === 9 && /^9–0$/.test(council.verdict?.split ?? '') },
    { name: 'Team player (5 delegations)', isUnlocked: list.filter(x => x.kind === 'delegation').length >= 5 },
    { name: 'Librarian (10 skills)', isUnlocked: new Set(list.filter(x => x.kind === 'skill_load').map(x => skillOf(x.detail))).size >= 10 },
  ]
}

// The repo's last CI run, read with gh: sun when it passed, storm when it failed.
async function checkWeather($: EngineInterface) {
  const root = (await $.session.repo())?.root
  const out = root ? await run($, ['gh', 'run', 'list', '-L', '1', '--json', 'conclusion,status'], root) : undefined
  const last = out ? ((JSON.parse(out) as { conclusion?: string; status?: string }[])[0] ?? {}) : {}
  const sky = last.status && last.status !== 'completed' ? 'cloud' : last.conclusion === 'success' ? 'sun' : last.conclusion ? 'storm' : 'unknown'
  await update($, weather, () => sky)
}

export async function officeCommand($: EngineInterface, args: string, isLowPower: boolean): Promise<string> {
  const [verb, name = ''] = args.trim().split(/\s+/)
  if (verb === 'theme') {
    const all = await loadThemes($)
    if (!all[name]) return `Themes: ${Object.keys(all).join(', ')}.`
    await update($, theme, () => name)
    return `Office theme: ${name}.`
  }
  const opened = await $.ui.open({ id: OFFICE, title: 'CompanyOS · office' })
  if (opened.isPlaced) await checkWeather($)
  if (opened.isPlaced && !isLowPower) {
    // Walking and typing tick twice a second, and stop once the pane is closed.
    const timer = $.clock.every(500, () => {
      void $.ui.panes().then(panes =>
        panes.some(p => p.id === OFFICE)
          ? update($, tick, n => (n + 1) % 1000).then(n => (n % 600 === 0 ? checkWeather($) : undefined))
          : timer.cancel(),
      )
    })
  }
  return opened.isPlaced ? 'Office open.' : `Office waits: ${opened.reason}`
}

export function office(on: On, defaultTheme: string, isLowPower: boolean) {
  on('command.run', { command: 'office' }, async ($, e) => ({ text: await officeCommand($, e.args, isLowPower) }))

  on('ui.render', { component: 'Pane', requestId: OFFICE }, async ($, e) => {
    const [picked, frame, sky, agents, events, usage, council, memories, wall, isPlainMode, now] = await Promise.all([
      read($, theme),
      read($, tick),
      read($, weather),
      $.agent.list(),
      readEvents($),
      $.session.usage(),
      readCouncil($),
      entries($),
      tickets($),
      isPlain($),
      $.clock.now(),
    ])
    const themes = await loadThemes($)
    const t = themes[picked || defaultTheme] ?? LOFT
    const grid = draw({ t, agents, events, pct: usage.context.percent ?? 0, council, memories, wall, frame, hour: new Date(now).getHours(), weather: sky })
    const last = new Map<string, CosEvent>()
    for (const x of events) if (x.kind === 'tool_call') last.set(x.agent, x)
    const bubbles = [...last].slice(-6)
    const won = achievements(events, council).filter(a => a.isUnlocked)
    const width = e.props.bodyColumns

    const surface = e.surface
    const picture =
      surface === 'terminal'
        ? (() => {
            const { Raster } = $.ui.resolve(e)
            return <Raster key="office" columns={W} rows={H} cells={cellsOf(grid)} />
          })()
        : (() => {
            const { Svg } = $.ui.resolve(e)
            return <Svg source={svgOf(grid, t)} alt="The office: rooms, agents at desks, context racks, skill library and ticket wall" />
          })()

    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {picture}
        {bubbles.map(([agent, x]) => (
          <Text>
            💬 {clip(isPlainMode ? plain(x) : `${agent}: ${x.detail}`, width - 3)}
          </Text>
        ))}
        <Text dimColor>
          {agents.filter(a => a.status === 'running').length} at work · {agents.filter(a => a.status === 'idle').length} on a break · {memories.length} memories ·{' '}
          {Math.round(usage.context.percent ?? 0)}% context
        </Text>
        <Text color="claude">🏆 {won.length ? won.map(a => a.name).join(' · ') : 'no achievements yet'}</Text>
      </Box>
    )
  })
}
