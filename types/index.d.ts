export type EventKind =
  | 'prompt'
  | 'tool_call'
  | 'skill_load'
  | 'delegation'
  | 'compaction'
  | 'turn'
  | 'identity'
  | 'guard'
  | 'memory'
  | 'vote'
  | 'ticket_update'

// The GitHub account a repo is bound to, kept in $.store under accounts/<repo root>.
export type Binding = { login: string; email?: string }

// One long-term memory (the elephant), kept in $.store under memory/entries.
export type MemoryEntry = {
  id: string
  text: string
  source: 'you' | 'agent' | 'council' | 'ticket'
  scope: string // 'global' or a repo root
  ts: number
  lastUsed: number
  isPinned?: boolean
  expires?: number
}

// A ticket on the wall, kept in $.store under tickets/<repo root>.
export type Ticket = {
  key: string
  title: string
  source: string
  status: 'To Do' | 'In Progress' | 'In Review' | 'Blocked' | 'Done'
  agent?: string
  requirement?: string
  note?: string
  ts: number
}

// One file edit an agent made, with what the file held before and after.
export type Change = {
  id: string
  ts: number
  agent: string
  file: string
  before: string | null // null: too large to keep
  after: string
  isNew: boolean
  added: number
  removed: number
  isReverted?: boolean
}

export type Seat = {
  role: string
  vote?: string // an option letter, 'abstain' or 'veto'
  confidence?: number
  reason?: string
  change?: string
}

export type Verdict = {
  chosen: string // the option's text, or 'blocked' / 'escalated'
  split: string // '5–1'
  dissent: string[]
  changes: string[]
  vetoedBy?: string
  needsYou: boolean
  plain: string
}

export type Council = {
  id: string
  question: string
  options: string[]
  size: number
  status: 'round 1' | 'round 2' | 'verdict' | 'failed'
  seats: Seat[]
  verdict?: Verdict
  tokens: number
}

export type CosEvent = {
  id: string
  ts: number
  agent: string
  kind: EventKind
  // ponytail: flat payload, one-line detail; structured per-kind payloads when a panel needs them
  detail: string
  isDone?: boolean
  isError?: boolean
  tokensIn?: number
  tokensOut?: number
  cost?: number
}

declare module 'claude-code' {
  interface PluginState {
    companyos: {
      events: Shaped<CosEvent[]>
      pending: number
      graph: string
      council: Council | null
      mode: string
      theme: string
      tick: number
      weather: string
      changes: Shaped<Change[]>
    }
  }
}
