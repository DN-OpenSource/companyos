export type EventKind =
  | 'prompt'
  | 'tool_call'
  | 'skill_load'
  | 'delegation'
  | 'compaction'
  | 'turn'

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
    companyos: { events: Shaped<CosEvent[]> }
  }
}
