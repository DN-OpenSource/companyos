// Pure helpers shared by the panes; none takes $.

export const clip = (s: string, n = 160) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s)

// Local wall-clock time, as the person reads it.
export const time = (ts: number) => new Date(ts).toTimeString().slice(0, 8)

export const day = (ts: number) => new Date(ts).toISOString().slice(0, 10)

export const ctxColor = (pct: number) => (pct >= 90 ? 'error' : pct >= 70 ? 'warning' : 'success')

export const meter = (pct: number, width = 10) => {
  const full = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width)
  return '█'.repeat(full) + '░'.repeat(width - full)
}

export const usd = (n: number | undefined) => `$${(n ?? 0).toFixed(2)}`

export const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

// The one argument worth a glance, whatever the tool.
export function argOf(e: object): string {
  const a = e as Record<string, unknown>
  for (const k of ['command', 'file_path', 'skill', 'pattern', 'url', 'description', 'prompt', 'query']) {
    if (typeof a[k] === 'string') return a[k] as string
  }
  return ''
}

// A skill_load event's detail starts with the skill's name.
export const skillOf = (detail: string) => detail.split(' ')[0] ?? detail
