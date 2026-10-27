# CompanyOS

A Claude Code mod that shows your session as a company. Every prompt, tool call, skill load, subagent,
compaction, vote and ticket becomes an event in one log, and every pane, the band above the prompt and the
pixel office draw from that log. Technical and plain-language modes read the same events.

Requires Claude Code 2.1.287 or later (the mods API). Built and tested on 2.1.311.

## Commands

| Command | Prefix | What it does |
| --- | --- | --- |
| `/events` | | Live event feed: time, agent, kind, detail; failures in red |
| `/telemetry` | | Context meter and compaction forecast, cost and rate limits, per-agent turns, per-skill loads and tokens, inherited skills, bloated tool results |
| `/office [floor \| wall \| replay [this\|<session id>] [speed] \| theme <name>]` | `@office` | Pixel office: rooms, agents at desks, server-room racks for context, skill library, ticket wall, memory corner, achievements; the 3D org-chart wall; an animated replay of this or a stored session |
| `/council 3\|6\|9 <question> [A) … B) …]` | `@council` | A council votes in two rounds; vetoes, tie-breaks, verdict card with accept / override / re-run |
| `/mem [remember [--global] <text> \| forget <id> \| pin <id> \| prune \| export]` | `@mem` | Long-term memory, injected into each conversation's first message |
| `/graph [agents\|skills\|files\|memory\|decisions\|cost]` | | The relation as a Mermaid graph, copyable |
| `/ticket [jira\|notion\|linear] start\|move\|done\|block\|add <KEY> …`, `/ticket sync`, `/ticket wall` | `@jira`, `@notion`, `@linear` | Work tickets through your connected tracker; the wall stays in sync |
| `/account [bind <login> [email] \| unbind \| switch <login>]` | `@gh` | GitHub identity bound per repo |
| `/diff [revert <id> [hunk]]` | | Every edit this session by agent, hunk by hunk, each with its own revert that tells the agent why |
| `/checkpoint [label] \| list \| restore <id>` | | Snapshot the workspace with `git stash create` (nothing in the tree moves); restore after a yes |
| `/replay` | | Save the session (messages and events) as `.companyos/replay-<session>.json` |
| `/handover` | | Write a handover note for a colleague, technical and plain |
| `/mode [plain\|technical]` | | Switch how every pane and the band read |
| `/daily` | | Writes `.companyos/daily-<date>.md`: plain summary, standup, timeline |
| `/report [week\|csv\|json]` | | Weekly report and decision digest, or every stored event as CSV or JSON |
| | `$ <command>` | Runs a shell line; output lands in the transcript |
| | `@<agent> <text>`, `@all <text>` | Messages a running subagent or teammate |

## Always on

- **Band above the prompt:** a glyph per live agent (press to view it), context %, session cost, the last
  action, guard questions waiting on you, a sitting council's vote count, tickets in progress.
- **Status line:** `CompanyOS · ctx 46% · $1.23 · gh:work` after each turn.
- **Spinner:** `· 3 tools · 46% context` while Claude works.
- **Edits:** `+42 −7 in 3 files` on the band while this session has unreverted edits.
- **Autocomplete:** `@` suggests agents and the prefixes; after `start`, `move`, `done` or `block` it suggests ticket keys.
- **Office weather:** sun when the repo's last CI run passed, storm when it failed (read with `gh run list`).

## Guards

- **Wrong identity:** in a repo bound with `/account bind`, a `git commit` under another email, or a
  `git push` / `gh pr create|merge` while gh acts as another login, is denied with the fix.
- **Secrets:** a commit whose staged diff holds an AWS, GitHub, Anthropic/OpenAI, Slack, Google or
  private key is denied.
- **Risky commands** (`rm -rf`, force push, `reset --hard`, `git clean -f`, discarding work, destructive SQL)
  and **edits to protected paths** ask you first: allow once, deny, or hand it to a council of 3.

If a guard itself breaks, it denies rather than lets things through: a bug there blocks Bash until the mod
reloads. Turn the mod off in `/plugin` to get out.

## Settings (`/config`, or `pluginConfigs.companyos` in settings)

| Field | Default | |
| --- | --- | --- |
| `protectedPaths` | `.env` | Comma-separated path fragments no agent edits without your yes; matched anywhere in the path, so `.env` also catches `.env.example` and `.envrc` |
| `costCapUsd` | `0` | Toast once a session costs more; 0 is off |
| `theme` | `loft` | `loft`, `tower`, `cubicles`, `garage`, `space` |
| `lowPower` | `false` | No office animation |
| `webhookUrl` | empty | POST every event as JSON to this address |

Themes are JSON files in `themes/` (`{ "floor", "wall", "desk", "accent", "text" }` as `#rrggbb`); drop one in
and `@office theme <file name>` picks it.

## Where data lives

All local. The mod's store (`$.store`, shared by this machine's sessions) holds `events/<session>` (last 500 per session, last 20 sessions),
`memory/entries`, `decisions/<id>`, `tickets/<repo>`, `accounts/<repo>` and `checkpoints/<repo>`; checkpoints are also git refs
under `refs/companyos/`. `/daily`, `/report`, `/replay` and `/handover` write to
`.companyos/` in the working directory; add it to `.gitignore` if you don't want it committed.

## How tickets sync

The mod registers `mcp__companyos__ticket_update`. `/ticket start PROJ-12` asks Claude to load the ticket with
your connected Jira, Notion or Linear tools, branch and commit with the key, and report status back through that
tool, so the wall, the band and blocked toasts follow the tracker. The mod itself calls no tracker directly,
because tool names differ per connection.

## Develop

```
claude --plugin-dir ./companyos
claude plugin validate ./companyos
claude plugin test ./companyos
tsc -p ./companyos
```

One file per feature under `hooks/`, wired in `hooks/register.tsx`; the `$.state` contract is `types/index.d.ts`.

## Not in the mod

- Skill tracking needs `skill.prompt` to reach the mod. Where an organization plugin above it (for example
  `cc-plugin-sec-default`) passes that event on past the person's mods, the library, per-skill stats, skill graph
  and inherited-skill tracing stay empty.

These can't be done from inside a mod:

- Switching Anthropic accounts. No mods API does it; `/account` shows which account is signed in.
- Tracker calls through `$.mcp`. Tickets go through Claude's own connected tools instead (see How tickets sync).
