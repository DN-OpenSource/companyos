import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { CosEvent, EventKind } from '../types'
import { clip } from './util'

const MAX = 500
// Change the tag when CosEvent's fields change.
// Read and written only in this file: the engine lists state uses per file.
const events = atom({ plugin: 'companyos', key: 'events' } as const, [], {
  shape: 'events-1',
})


// Where every event is also POSTed as JSON; empty for none (userConfig webhookUrl).
let webhook = ''

export function setWebhook(url: string) {
  webhook = /^https?:\/\//.test(url) ? url : ''
}

export async function log(
  $: EngineInterface,
  kind: EventKind,
  agent: string | undefined,
  detail: string,
  extra: Partial<CosEvent> = {},
): Promise<string> {
  const ts = await $.clock.now()
  const id = `evt_${ts.toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const evt: CosEvent = { id, ts, agent: agent ?? 'lead', kind, detail: clip(detail), ...extra }
  await update($, events, list => [...list, evt].slice(-MAX))
  if (webhook) {
    // Fire and forget: a slow or dead endpoint never holds up the session.
    void $.http
      .fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'companyos', ...evt }) })
      .then(
        () => {},
        () => {},
      )
  }
  return id
}

// Helpers taking $ across files are function declarations: the engine follows $ only into those.
export async function mark($: EngineInterface, id: string, patch: Partial<CosEvent>) {
  await update($, events, list => list.map(x => (x.id === id ? { ...x, ...patch } : x)))
}

export async function readEvents($: EngineInterface): Promise<CosEvent[]> {
  return read($, events)
}

const KEEP_SESSIONS = 20

// One key per session, the oldest sessions rolled off so the shared 4 MiB store never fills.
export async function flush($: EngineInterface) {
  await $.store.set(`events/${await $.session.id()}`, await read($, events))
  const keys = (await $.store.keys()).filter(k => k.startsWith('events/'))
  if (keys.length <= KEEP_SESSIONS) return
  const last = await Promise.all(keys.map(async k => ({ k, ts: ((await $.store.get(k)) as CosEvent[] | undefined)?.at(-1)?.ts ?? 0 })))
  for (const { k } of last.sort((a, b) => a.ts - b.ts).slice(0, keys.length - KEEP_SESSIONS)) await $.store.delete(k)
}
