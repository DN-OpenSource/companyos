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
    }
  }
}
