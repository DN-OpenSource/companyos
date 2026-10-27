import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, On, RenderInput } from 'claude-code'

import type { CosEvent } from '../types'
import { run } from './accounts'
import { readCouncil } from './council'
import { readEvents } from './events'
import { entries } from './memory'
import { tickets } from './tickets'
import { COL, skillOf, tokens } from './util'

export const OFFICE = 'companyos-office'

// A room's "open" switches the hub to the tab that shows it in full.
async function openTab($: EngineInterface, tab: string) {
  await $.state.set({ plugin: 'companyos', key: 'tab' } as const, tab)
}

// The design's canvas: 128 × 64 pixels, drawn two pixels to a terminal cell.
const PW = 128
const PH = 64
const TICKS = 1_000_000_000
const FRAME_MS = 200

const P = {
  n9: 0x2e2b25, n8: 0x474238, n7: 0x645c50, n6: 0x82796a, n5: 0xa19786, n4: 0xc0b6a5, n3: 0xdcd3c4, n1: 0xf9f4ed,
  a3: 0xffc6a5, a4: 0xf6a06b, a5: 0xd67f48, a7: 0x8c491a, s3: 0xccdbb2, s4: 0xaebf92, s5: 0x8fa073, s7: 0x56633f,
  red: 0xe0705f, sky: 0x1b1a2e, day: 0x9cc4d6, sun: 0xffe27a, green: 0x7bd88f, dkgreen: 0x3a7a48, dkred: 0x7a2e26,
}
const LOFT: [number, number] = [P.a7, 0x7a3f17]
const FLOORS: Record<string, [number, number]> = {
  loft: LOFT,
  tower: [P.n7, P.n6],
  cubicles: [P.s7, 0x4c5838],
  garage: [P.n8, P.n7],
  space: [0x26244a, 0x1f1d3d],
}
export const THEME_NAMES = Object.keys(FLOORS)

// Extra themes are JSON files in the mod's themes/ folder: { "floor": "#rrggbb", "wall": "#rrggbb" }.
let themeCache: Record<string, [number, number]> | undefined

async function loadThemes($: EngineInterface): Promise<Record<string, [number, number]>> {
  if (themeCache) return themeCache
  const found = { ...FLOORS }
  try {
    for (const f of await $.fs.list(`${$.plugin.root}/themes`)) {
      if (!f.name.endsWith('.json')) continue
      const raw = JSON.parse(await $.fs.read(`${$.plugin.root}/themes/${f.name}`)) as Record<string, string>
      const rgb = (k: string, d: number) => (/^#[0-9a-f]{6}$/i.test(raw[k] ?? '') ? parseInt(raw[k]!.slice(1), 16) : d)
      found[f.name.slice(0, -5)] = [rgb('floor', LOFT[0]), rgb('wall', LOFT[1])]
    }
  } catch {
    // no themes folder: the built-in five
  }
  themeCache = found
  return found
}

const theme = atom({ plugin: 'companyos', key: 'theme' } as const, '')
const tick = atom({ plugin: 'companyos', key: 'tick' } as const, 0)
const weather = atom({ plugin: 'companyos', key: 'weather' } as const, 'unknown')
// What the pane shows: the live floor, the org-chart wall, or a replay of a session's events.
const view = atom({ plugin: 'companyos', key: 'view' } as const, { kind: 'floor', speed: 4 })
const ciLabel = atom({ plugin: 'companyos', key: 'ciLabel' } as const, '')
const roomShown = atom({ plugin: 'companyos', key: 'room' } as const, -1)

// The twelve rooms, left to right and top to bottom, and the hub tab each opens.
const ROOMS: [string, string | null][] = [
  ['Corner office', null],
  ['Meeting room', 'council'],
  ['Server room', 'telemetry'],
  ['Library', 'telemetry'],
  ['Open-plan desks', null],
  ['Ticket wall', 'tickets'],
  ['Mailroom', 'events'],
  ['Filing room', 'diff'],
  ['QA desk', 'quality'],
  ['Break area', null],
  ['Memory corner', 'memory'],
  ['Review nook', 'account'],
]

type Scene = {
  floor: [number, number]
  isNight: boolean
  t: number
  sel: number
  agents: { status: string; isSelected: boolean }[]
  votes: (boolean | undefined)[]
  pct: number
  isSkillGlowing: boolean
  isQaFailing: boolean
  isFast: boolean
  banner: string
}

// Walker state: the second agent wanders the floor as the design's explore does.
const walk = { at: [44, 30] as [number, number], step: 0 }
const PATH: [number, number][] = [[100, 22], [44, 26], [12, 28], [72, 40], [112, 40], [100, 22]]

function paint(s: Scene): Uint32Array {
  const px = new Uint32Array(PW * PH)
  const R = (x: number, y: number, w: number, h: number, col: number, alpha = 1) => {
    for (let j = Math.max(0, Math.floor(y)); j < Math.min(PH, Math.floor(y + h)); j++)
      for (let i = Math.max(0, Math.floor(x)); i < Math.min(PW, Math.floor(x + w)); i++) {
        if (alpha >= 1) px[j * PW + i] = col
        else {
          const b = px[j * PW + i]!
          const mix = (sh: number) => Math.round(((b >> sh) & 255) * (1 - alpha) + ((col >> sh) & 255) * alpha) << sh
          px[j * PW + i] = (mix(16) | mix(8) | mix(0)) >>> 0
        }
      }
  }
  const { t, floor } = s
  R(0, 0, 128, 8, s.isNight ? P.sky : P.day)
  if (!s.isNight) {
    R(112, 1, 4, 4, P.sun)
    R(20 + ((t >> 3) % 100), 2, 8, 2, P.n1)
    R(70 + ((t >> 4) % 60), 4, 6, 1, P.n1)
  } else {
    for (let i = 0; i < 14; i++) if ((t + i * 7) % 20 > 3) R((i * 37) % 128, (i * 5) % 7, 1, 1, P.n1)
    R(110, 1, 3, 3, P.n3)
  }
  for (let i = 0; i < 8; i++) R(i * 16 + 7, 0, 2, 8, P.n9)
  R(124, 1, 3, 3, (t >> 2) % 4 ? P.green : P.dkgreen)
  for (let r = 0; r < 12; r++) {
    const x = (r % 4) * 32
    const y = 8 + Math.floor(r / 4) * 16
    for (let yy = 0; yy < 16; yy += 2) for (let xx = 0; xx < 32; xx += 4) R(x + xx + ((yy / 2) % 2) * 2, y + yy, 4, 2, ((xx + yy) / 2) % 2 ? floor[0] : floor[1])
  }
  if (s.sel >= 0) R((s.sel % 4) * 32, 8 + Math.floor(s.sel / 4) * 16, 32, 16, P.a3, 0.22)
  for (let i = 1; i < 4; i++) {
    R(i * 32, 8, 1, 48, P.n9)
    R(i * 32, 13, 1, 4, floor[1])
    R(i * 32, 29, 1, 4, floor[1])
    R(i * 32, 45, 1, 4, floor[1])
  }
  for (let j = 1; j < 3; j++) {
    R(0, 8 + j * 16, 128, 1, P.n9)
    for (let i = 0; i < 4; i++) R(i * 32 + 13, 8 + j * 16, 6, 1, floor[1])
  }
  R(0, 56, 128, 8, P.n9)
  const O = (r: number): [number, number] => [(r % 4) * 32, 8 + Math.floor(r / 4) * 16]
  let [x, y] = O(0)
  R(x + 4, y + 9, 14, 3, P.a5); R(x + 8, y + 6, 5, 3, P.n9); R(x + 9, y + 7, 3, 1, t % 6 < 3 ? P.s3 : P.s4); R(x + 26, y + 4, 3, 6, P.s5); R(x + 25, y + 10, 5, 3, P.n6)
  ;[x, y] = O(1)
  R(x + 8, y + 6, 16, 5, P.a5)
  s.votes.slice(0, 3).forEach((v, i) => {
    const col = v === undefined ? ((t >> 2) % 2 ? P.a3 : P.n7) : v ? P.s4 : P.a4
    R(x + 9 + i * 6, y + 4, 3, 2, col)
    R(x + 9 + i * 6, y + 11, 3, 2, col)
  })
  ;[x, y] = O(2)
  const lit = Math.round((s.pct / 100) * 15)
  for (let k = 0; k < 3; k++) {
    R(x + 4 + k * 9, y + 2, 7, 12, P.n9)
    for (let l = 0; l < 5; l++) {
      const on = k * 5 + l < lit
      R(x + 5 + k * 9, y + 3 + l * 2, 1, 1, on ? ((t + l + k) % 5 ? (s.pct >= 90 ? P.red : s.pct >= 70 ? P.sun : P.green) : P.n7) : P.n7)
      R(x + 7 + k * 9, y + 3 + l * 2, 3, 1, P.n8)
    }
  }
  ;[x, y] = O(3)
  for (let k = 0; k < 2; k++) {
    R(x + 3, y + 2 + k * 6, 26, 5, P.n9)
    ;[P.a4, P.s4, P.a5, P.n4, P.s5, P.a3, P.red, P.s3, P.a4, P.n3, P.s4, P.a5].forEach((col, i) => R(x + 4 + i * 2, y + 3 + k * 6, 1, 4, col))
  }
  if (s.isSkillGlowing && (t >> 2) % 3 === 0) R(x + 4 + ((t >> 2) % 12) * 2, y + 2, 1, 1, P.sun)
  ;[x, y] = O(4)
  for (let k = 0; k < 3; k++) {
    R(x + 3 + k * 10, y + 9, 7, 2, P.a5); R(x + 4 + k * 10, y + 6, 5, 3, P.n9); R(x + 5 + k * 10, y + 7, 3, 1, (t + k * 3) % 8 < 5 ? P.s3 : P.a3)
  }
  ;[x, y] = O(5)
  R(x + 3, y + 2, 26, 11, P.n3)
  ;[P.a3, P.a3, P.s3, P.a4, P.s3, P.a3, P.s4, P.a3].forEach((col, i) => R(x + 5 + (i % 4) * 6, y + 3 + Math.floor(i / 4) * 5, 4, 3, col))
  R(x + 11, y + 3 + ((t >> 3) % 2) * 5, 4, 3, P.a4)
  ;[x, y] = O(6)
  for (let k = 0; k < 4; k++) for (let l = 0; l < 2; l++) {
    R(x + 4 + k * 6, y + 3 + l * 5, 5, 4, P.n7)
    if (k === (t >> 3) % 4 && l === 0) R(x + 5 + k * 6, y + 4, 3, 2, P.n1)
  }
  ;[x, y] = O(7)
  for (let k = 0; k < 4; k++) {
    R(x + 3 + k * 7, y + 3, 6, 10, P.n6); R(x + 5 + k * 7, y + 5, 2, 1, P.n9); R(x + 5 + k * 7, y + 9, 2, 1, P.n9)
  }
  ;[x, y] = O(8)
  R(x + 4, y + 9, 14, 3, P.a5); R(x + 8, y + 5, 6, 4, P.n9); R(x + 9, y + 6, 4, 2, s.isQaFailing ? ((t >> 1) % 2 ? P.red : P.dkred) : P.s4)
  ;[x, y] = O(9)
  R(x + 4, y + 4, 6, 9, P.n6); R(x + 5, y + 6, 4, 2, P.n9)
  for (let k = 0; k < 3; k++) R(x + 6 + (k % 2), y + 3 - ((t + k * 3) % 9) / 3, 1, 1, P.n3)
  R(x + 16, y + 8, 12, 4, P.a3); R(x + 17, y + 12, 2, 2, P.n6); R(x + 25, y + 12, 2, 2, P.n6)
  ;[x, y] = O(10)
  R(x + 10, y + 3, 12, 10, P.s3, 0.25 + ((Math.sin(t / 4) + 1) / 2) * 0.35)
  R(x + 13, y + 5, 6, 6, P.s4); R(x + 14, y + 6, 2, 2, P.n1)
  ;[x, y] = O(11)
  R(x + 4, y + 9, 14, 3, P.a5); R(x + 20, y + 3, 1, 8, P.n5); R(x + 18, y + 2, 5, 2, P.sun)

  // The lead at the corner desk, the first subagent walking the floor, the next two at their desks.
  const wp = PATH[walk.step % PATH.length]!
  const sp = s.isFast ? 2 : 1
  walk.at[0] += Math.sign(wp[0] - walk.at[0]) * sp
  walk.at[1] += Math.sign(wp[1] - walk.at[1]) * sp
  if (Math.abs(wp[0] - walk.at[0]) <= 1 && Math.abs(wp[1] - walk.at[1]) <= 1) walk.step++
  const spots: [number, number][] = [[10, 17], walk.at, [10, 49], [106, 49]]
  const cols = [P.a4, P.s4, P.red, P.a3]
  const hair = [P.n9, P.a7, P.n8, P.n5]
  s.agents.slice(0, 4).forEach((a, i) => {
    const [ax, ay] = [Math.round(spots[i]![0]), Math.round(spots[i]![1])]
    const yy = ay + (a.status === 'running' && (t >> 1) % 2 ? -1 : 0)
    R(ax + 1, yy, 3, 1, hair[i]!); R(ax, yy + 1, 5, 2, P.a3); R(ax, yy + 1, 1, 1, hair[i]!); R(ax + 1, yy + 2, 1, 1, P.n9); R(ax + 3, yy + 2, 1, 1, P.n9)
    R(ax, yy + 3, 5, 2, a.status === 'failed' ? P.red : cols[i]!)
    const stepping = i === 1 && (t >> 1) % 2
    R(ax + (stepping ? 0 : 1), yy + 5, 1, 1, P.n9); R(ax + (stepping ? 4 : 3), yy + 5, 1, 1, P.n9)
    // A red mark over a failed agent, a question mark over one waiting on you.
    if (a.status === 'failed' && (t >> 2) % 2) {
      R(ax + 2, yy - 5, 1, 3, P.red); R(ax + 2, yy - 1, 1, 1, P.red)
    }
    if (a.status === 'waiting') {
      R(ax + 1, yy - 5, 3, 1, P.a3); R(ax + 3, yy - 4, 1, 1, P.a3); R(ax + 2, yy - 3, 1, 1, P.a3)
      if ((t >> 2) % 2) R(ax + 2, yy - 1, 1, 1, P.a3)
    }
    if (a.isSelected) {
      const ar = (t >> 1) % 2
      R(ax + 1, yy - 4 - ar - (i >= 2 ? 4 : 0), 3, 1, P.n1); R(ax + 2, yy - 3 - ar - (i >= 2 ? 4 : 0), 1, 1, P.n1)
    }
  })
  return px
}

const pack = (words: Uint32Array) => {
  const bytes = new Uint8Array(words.buffer)
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(out)
}

// Two pixels a cell: the upper half block in the top pixel's colour over the bottom pixel's; the banner in the floor's dark strip.
function cellsOf(px: Uint32Array, banner: string): string {
  const rows = PH / 2
  const words = new Uint32Array(PW * rows * 3)
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < PW; c++) {
      const k = (r * PW + c) * 3
      words[k] = 0x2580
      words[k + 1] = px[r * 2 * PW + c]!
      words[k + 2] = px[(r * 2 + 1) * PW + c]!
    }
  ;[...banner].slice(0, PW - 4).forEach((ch, i) => {
    const code = ch.codePointAt(0) ?? 32
    if (code > 0xffff) return
    const k = (29 * PW + 3 + i) * 3
    words[k] = code
    words[k + 1] = P.n4
    words[k + 2] = P.n9
  })
  return pack(words)
}

// The same pixels for a surface with no Raster: one rect per run of a colour along each row.
function svgOf(px: Uint32Array, banner: string): string {
  const hex = (n: number) => '#' + n.toString(16).padStart(6, '0')
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PW} ${PH}" shape-rendering="crispEdges">`]
  for (let y = 0; y < PH; y++) {
    let x = 0
    while (x < PW) {
      const col = px[y * PW + x]!
      let end = x + 1
      while (end < PW && px[y * PW + end] === col) end++
      parts.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${hex(col)}"/>`)
      x = end
    }
  }
  const safe = banner.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  parts.push(`<text x="3" y="62" font-family="monospace" font-size="5" fill="${hex(P.n4)}">${safe}</text></svg>`)
  return parts.join('')
}

// Agents as a replay sees them: each delegation walks in, and its first finished turn walks it out.
function replayAgents(events: CosEvent[]): AgentInfo[] {
  const seen = new Map<string, AgentInfo>()
  for (const x of events) {
    const child = x.kind === 'delegation' ? x.detail.match(/→ ([^:]+):/)?.[1] : undefined
    if (child) seen.set(child, { id: child, name: child, type: x.detail.split(' ')[0] ?? 'agent', description: x.detail, status: 'running' })
    const mine = seen.get(x.agent)
    if (mine && x.kind === 'turn') seen.set(x.agent, { ...mine, status: x.isError ? 'failed' : 'completed' })
  }
  return [...seen.values()]
}

// The design's four achievements, unlocked from the event log.
function achievements(list: CosEvent[], councilSize: number | undefined): [string, boolean][] {
  const today = new Date().toDateString()
  return [
    ['First green build', list.some(x => x.kind === 'guard' && x.detail.startsWith('gate: passed'))],
    ['Council of 9', councilSize === 9 || list.some(x => x.kind === 'vote' && x.detail.includes('council of 9'))],
    ['100 tool calls', list.filter(x => x.kind === 'tool_call').length >= 100],
    ['Zero reverts today', list.some(x => x.kind === 'tool_call') && !list.some(x => x.detail.startsWith('reverted') && new Date(x.ts).toDateString() === today)],
  ]
}

// The repo's last CI run, read with gh: sun when it passed, storm when it failed.
async function checkWeather($: EngineInterface) {
  const root = (await $.session.repo())?.root
  const out = root ? await run($, ['gh', 'run', 'list', '-L', '1', '--json', 'conclusion,status,headBranch,number'], root) : undefined
  let last: { conclusion?: string; status?: string; headBranch?: string; number?: number } = {}
  try {
    last = out ? ((JSON.parse(out) as (typeof last)[])[0] ?? {}) : {}
  } catch {
    // gh printed something else
  }
  const sky = last.status && last.status !== 'completed' ? 'cloud' : last.conclusion === 'success' ? 'sun' : last.conclusion ? 'storm' : 'unknown'
  await update($, weather, () => sky)
  const where = last.headBranch ? ` · ${last.headBranch} #${last.number ?? '?'}` : ''
  const label = sky === 'sun' ? `CI ✓ passed${where}` : sky === 'storm' ? `CI ✕ ${last.conclusion}${where}` : sky === 'cloud' ? `CI running${where}` : 'CI · no runs'
  await update($, ciLabel, () => label)
}

// Keeps the office moving while it is shown anywhere: its own pane, or the hub on the office tab.
let ticking: { cancel: () => void } | undefined

export async function startOffice($: EngineInterface, isLowPower: boolean, force = false) {
  if (ticking || (isLowPower && !force)) return
  await checkWeather($)
  const timer = $.clock.every(FRAME_MS, () => {
    void $.ui.panes().then(panes =>
      panes.some(p => p.id === OFFICE || p.id === 'companyos')
        ? update($, tick, n => (n + 1) % TICKS).then(n => (n % 3000 === 0 ? checkWeather($) : undefined))
        : (timer.cancel(), (ticking = undefined)),
    )
  })
  ticking = timer
}

export async function officeCommand($: EngineInterface, args: string, isLowPower: boolean): Promise<string> {
  const [verb, name = ''] = args.trim().split(/\s+/)
  if (verb === 'theme') {
    const all = await loadThemes($)
    if (!all[name]) return `Themes: ${Object.keys(all).join(', ')}.`
    await update($, theme, () => name)
    return `office theme → ${name}`
  }
  const frame = await read($, tick)
  if (verb === 'wall' || verb === 'org' || verb === 'floor' || verb === 'live') {
    await update($, view, v => ({ kind: verb === 'wall' || verb === 'org' ? ('wall' as const) : ('floor' as const), speed: v.speed }))
  }
  if (verb === 'replay') {
    const speed = Number(args.trim().split(/\s+/)[2] ?? 4) || 4
    await update($, view, () => ({ kind: 'replay' as const, ...(name && name !== 'this' ? { session: name } : {}), from: frame, speed }))
  }
  await startOffice($, isLowPower, verb === 'replay')
  return verb === 'replay' ? 'replay · session saved, playing in the office' : verb === 'wall' || verb === 'org' ? 'Org chart wall.' : 'Office open.'
}

export async function officeBody($: EngineInterface, e: RenderInput<'Pane'>, defaultTheme: string, isLowPower: boolean) {
  const [picked, frame, liveAgents, liveEvents, usage, liveCouncil, memories, wall, now, shown, sel, ci, selAgent] = await Promise.all([
    read($, theme),
    read($, tick),
    $.agent.list(),
    readEvents($),
    $.session.usage(),
    readCouncil($),
    entries($),
    tickets($),
    $.clock.now(),
    read($, view),
    read($, roomShown),
    read($, ciLabel),
    $.state.get({ plugin: 'companyos', key: 'eventAgent' } as const),
  ])
  const themes = await loadThemes($)
  const themeName = picked || defaultTheme
  const floor = themes[themeName] ?? LOFT

  // A replay walks a session's events forward `speed` per frame, at twice the walking pace.
  const isReplay = shown.kind === 'replay'
  const source = isReplay && shown.session ? (((await $.store.get(`events/${shown.session}`)) as CosEvent[] | undefined) ?? []) : liveEvents
  const cursor = isReplay ? Math.min(source.length, ((frame - (shown.from ?? frame) + TICKS) % TICKS) * Math.max(1, Math.round(shown.speed / 2))) : source.length
  const events = source.slice(0, cursor)
  const subagents = (isReplay ? replayAgents(events) : liveAgents).filter(a => a.status !== 'completed' && a.status !== 'killed').slice(0, 3)
  const council = isReplay ? null : liveCouncil
  const at = events.at(-1)
  const hour = new Date(isReplay && at ? at.ts : now).getHours()
  const isNight = themeName === 'space' || hour < 7 || hour >= 19
  const pct = Math.round(usage.context.percent ?? 0)
  const chosen = selAgent.value ?? ''
  const lastTest = [...events].reverse().find(x => x.kind === 'tool_call' && /\btest\b/.test(x.detail))
  const won = achievements(events, council?.size)
  const banner = (isReplay ? `▶ REPLAY ${cursor}/${source.length}  ` : '') + '★ ' + (won.filter(w => w[1]).map(w => w[0].toUpperCase())[(frame >> 5) % Math.max(1, won.filter(w => w[1]).length)] ?? 'NO ACHIEVEMENTS YET')

  const scene: Scene = {
    floor,
    isNight,
    t: frame,
    sel,
    agents: [
      { status: liveEvents.at(-1)?.kind === 'tool_call' && !liveEvents.at(-1)?.isDone ? 'running' : 'idle', isSelected: chosen === 'lead' },
      ...subagents.map(a => ({ status: a.status, isSelected: chosen === (a.name ?? a.id) })),
    ],
    votes: council ? council.seats.map(x => (x.vote === undefined ? undefined : x.vote === council.verdict?.chosen.charAt(0) || x.vote === 'B')) : [true, true, undefined],
    pct,
    isSkillGlowing: events.slice(-8).some(x => x.kind === 'skill_load'),
    isQaFailing: lastTest?.isError === true,
    isFast: isReplay && cursor < source.length,
    banner,
  }

  const { Box, Button, Text } = $.ui.resolve(e)
  const go = (args: string) => () => officeCommand($, args, isLowPower).then(() => {})
  const skills = [...new Set(events.filter(x => x.kind === 'skill_load').map(x => skillOf(x.detail)))]
  const files = new Set(events.filter(x => x.kind === 'tool_call' && /^(Read|Edit|Write|MultiEdit) /.test(x.detail)).map(x => x.detail.split(' ').slice(1).join(' ')))
  const edited = new Set(events.filter(x => x.kind === 'tool_call' && /^(Edit|Write|MultiEdit) /.test(x.detail)).map(x => x.detail.split(' ').slice(1).join(' ')))
  const turns = events.filter(x => x.kind === 'turn' && x.agent === 'lead').length
  const perTurn = turns > 1 ? pct / turns : 0
  const left = perTurn > 0 ? Math.max(0, Math.floor((95 - pct) / perTurn)) : undefined
  const inProgress = wall.filter(t => t.status === 'In Progress').map(t => t.key)
  const inReview = wall.filter(t => t.status === 'In Review').map(t => t.key)
  const lastAction = [...events].reverse().find(x => x.kind === 'tool_call' && x.agent === 'lead')
  const failedTest = lastTest?.isError ? `test · failing in ${lastTest.detail.replace(/^Bash /, '')}` : lastTest ? 'test · passing' : 'no test run yet'
  const RINFO: string[] = [
    `lead works here${lastAction ? ` · ◆ ${lastAction.detail}` : ''}`,
    council ? `council · ${council.verdict ? `${council.verdict.chosen} ${council.verdict.split}` : `${council.seats.filter(x => x.vote).length}/${council.size} votes`}` : 'no council sitting',
    `context racks · ${pct}% full${left === undefined ? '' : ` · ~${left} turns left`}`,
    `skills · ${skills.join(', ') || 'none loaded yet'}`,
    'subagents at their desks',
    [inProgress.length ? `${inProgress.join(', ')} in progress` : '', inReview.length ? `${inReview.join(', ')} in review` : ''].filter(Boolean).join(' · ') || 'no tickets yet',
    `${events.filter(x => x.kind === 'delegation' || x.kind === 'prompt').length} messages between agents`,
    `${files.size} files read · ${edited.size} edited`,
    failedTest,
    'idle agents rest here',
    `${memories.length} entries · ${memories.filter(m => m.isPinned).length} pinned`,
    `${liveAgents.filter(a => a.status === 'waiting').length} waiting on your approval`,
  ]
  const room = sel >= 0 ? ROOMS[sel] : undefined
  const tokensOf = (agent: string) => events.filter(x => x.agent === agent && x.kind === 'turn').reduce((n, x) => n + (x.tokensIn ?? 0) + (x.tokensOut ?? 0), 0)
  const org = [['lead', tokensOf('lead')] as const, ...subagents.map(a => [a.name ?? a.id, tokensOf(a.name ?? a.id)] as const)]

  const picture =
    e.surface === 'terminal'
      ? (() => {
          const { Raster } = $.ui.resolve(e)
          return <Raster key="office" columns={PW} rows={PH / 2} cells={cellsOf(paint(scene), banner)} />
        })()
      : (() => {
          const { Svg } = $.ui.resolve(e)
          return <Svg source={svgOf(paint(scene), banner)} alt="The office: twelve rooms, agents at their desks, context racks, the skill library and the ticket wall" />
        })()

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text backgroundColor={isNight ? '#645c50' : '#ccdbb2'} color={isNight ? '#dcd3c4' : '#2e2b25'}>
          {' '}
          {isNight ? '☾ night' : '☀ day'} · {themeName}{' '}
        </Text>
        <Text dimColor> {ci || 'CI · not checked yet'}</Text>
      </Box>
      {shown.kind !== 'wall' && picture}
      {isReplay && (
        <Text color={COL.accL}>
          ▶ replay · {cursor}/{source.length} events{cursor >= source.length ? ' · done' : ''}
        </Text>
      )}
      {shown.kind !== 'wall' && (
        <Box flexDirection="row">
          {room ? (
            <Text>
              <Text color="#ffc6a5">{room[0]}</Text> <Text dimColor>{RINFO[sel]}</Text>{' '}
            </Text>
          ) : (
            <Text dimColor>Click a room or an agent · hover to inspect · agents animate by status </Text>
          )}
          {room?.[1] && (
            <Button key="room-open" onPress={() => openTab($, room[1]!)}>
              open {room[1]} ▸
            </Button>
          )}
        </Box>
      )}
      {shown.kind !== 'wall' && (
        <Box flexDirection="row">
          {ROOMS.map(([name], i) => (
            <Button key={`room-${i}`} plain onPress={() => update($, roomShown, r => (r === i ? -1 : i)).then(() => {})}>
              <Text color={i === sel ? '#ffc6a5' : undefined} dimColor={i !== sel}>
                {name}{'  '}
              </Text>
            </Button>
          ))}
        </Box>
      )}
      {shown.kind === 'wall' && (
        <Box flexDirection="column">
          <Text color="#f6a06b">Org chart wall · boxes sized by tokens</Text>
          {org.map(([name, n]) => (
            <Text>
              {name.padEnd(10)}
              <Text color="#aebf92">{'▇'.repeat(Math.max(1, Math.round(n / 4000)))}</Text> {tokens(n)}
            </Text>
          ))}
        </Box>
      )}
      <Box flexDirection="row">
        <Button key="view-floor" hotkey="f" plain onPress={go('floor')}>
          <Text color={shown.kind === 'floor' ? '#ffc6a5' : undefined}>[ f: floor ] </Text>
        </Button>
        <Button key="view-org" hotkey="o" plain onPress={go('org')}>
          <Text color={shown.kind === 'wall' ? '#ffc6a5' : undefined}>[ o: org chart ] </Text>
        </Button>
        <Button key="view-replay" hotkey="r" plain onPress={go('replay this 4')}>
          <Text color={isReplay ? '#ffc6a5' : undefined}>[ r: replay session ] </Text>
        </Button>
        <Text dimColor> theme </Text>
        {Object.keys(themes).map(name => (
          <Button key={`theme-${name}`} {...(name === themeName ? { variant: 'primary' as const } : { plain: true as const })} onPress={() => update($, theme, () => name).then(() => {})}>
            {name === themeName ? name : ` ${name} `}
          </Button>
        ))}
      </Box>
      <Text>
        🏆{' '}
        {won.map(([name, isWon], i) => (
          <Text color={isWon ? '#f6a06b' : undefined} dimColor={!isWon}>
            {i ? ' · ' : ''}
            {name}
          </Text>
        ))}
      </Text>
    </Box>
  )
}
