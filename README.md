# CompanyOS

A Claude Code mod that shows your session as a company. Every prompt, tool call, skill load, subagent,
compaction, vote and ticket becomes an event in one log, and every pane, the band above the prompt and the
pixel office draw from that log. Technical and plain-language modes read the same events.

Requires Claude Code 2.1.287 or later (the mods API). Built and tested on 2.1.311.

## The hub

`/cos` opens one pane with a tab per feature: **1** Events, **2** Telemetry, **3** Diff, **4** Office, **5** Council,
**6** Memory, **7** Tickets, **8** Account, **9** Checkpoints, **0** Config, **q** Quality (the done gate). `/cos <tab>`
opens it on that tab; the digits press the tabs while the pane holds the keys. **◉ focus** folds routine reads and
searches in the transcript to one dim line each (`/cos focus` toggles it).

## Commands

| Command | Prefix | What it does |
| --- | --- | --- |
| `/events` | | Live event feed: time, agent, kind, detail; failures in red |
| `/telemetry` | | Context meter and compaction forecast, cost and rate limits, per-agent turns, per-skill loads and tokens, inherited skills, bloated tool results |
| `/office [floor \| wall \| replay [this\|<session id>] [speed] \| theme <name>]` | `@office` | Pixel office: rooms, agents at desks, server-room racks for context, skill library, ticket wall, memory corner, achievements; the 3D org-chart wall; an animated replay of this or a stored session |
| `/council 3\|6\|9 <question> [A) … B) …]` | `@council` | A council votes in two rounds; vetoes, tie-breaks, verdict card with accept / override / re-run |
| `/mem [remember [--global] <text> \| forget <id> \| pin <id> \| prune \| export]` | `@mem` | Long-term memory, injected into each conversation's first message |
| `/graph [agents\|skills\|files\|memory\|decisions\|cost]` | | The relation as a Mermaid graph, copyable |
| `/ticket [jira\|notion\|linear] start\|move\|done\|block\|add\|remove <KEY> …`, `/ticket sync`, `/ticket wall` | `@jira`, `@notion`, `@linear` | Work tickets through your connected tracker; the wall stays in sync |
| `/anthropic [add <name> <provider> [k=v…] \| use <name> \| route <agent type\|*> <model> \| unroute …]` | | Signed-in Claude account, rate-limit forecast, provider profiles (subscription, API, Bedrock, Vertex, gateway) applied to the next session, and per-agent model routes |
| `/account [bind <login> [email] \| unbind \| switch <login>]` | `@gh` | GitHub identity bound per repo |
| `/cos diff`, `/cos diff revert <id> [hunk]` | | Every edit this session by agent, hunk by hunk, each with its own revert that tells the agent why |
| `/checkpoint [label] \| list \| restore <id>` | | Snapshot the whole workspace with `git stash create` (unlike `/rewind`, not only Claude's edits; nothing in the tree moves); restore after a yes |
| `/replay` | | Save the session (messages and events) as `.companyos/replay-<session>.json` |
| `/handover` | | Write a handover note for a colleague, technical and plain |
| `/gate` | | Run the done gate now; the Quality tab shows each check with a fix button |
| `/cos config` | | The mod's settings as they stand (`/config` is Claude Code's own) |
| `/mode [plain\|technical]` | | Switch how every pane and the band read |
| `/daily` | | Writes `.companyos/daily-<date>.md`: plain summary, standup, timeline |
| `/report [week\|csv\|json]` | | Weekly report and decision digest, or every stored event as CSV or JSON |
| | `$ <command>` | Runs a shell line; output lands in the transcript. Claude Code's own `!` does the same |
| | `@<agent> <text>`, `@all <text>` | Messages a running subagent or teammate |

## Always on

- **Band above the prompt:** a glyph per live agent (press to view it), context %, session cost, the last
  action, guard questions waiting on you, a sitting council's vote count, tickets in progress.
- **Status line:** `CompanyOS · ctx 46% · $1.23 · gh:work` after each turn.
- **Spinner:** `· 3 tools · 46% context` while Claude works.
- **Edits:** `+42 −7 in 3 files` on the band while this session has unreverted edits.
- **Suggestions:** Claude Code's prompt has no completion site, so the hint line under the prompt suggests how to finish an `@` word (agents, prefixes), a `/` command or a ticket key.
- **Office weather:** sun when the repo's last CI run passed, storm when it failed (read with `gh run list`).

## Done gate

Before Claude ends a turn that changed files, the gate runs seven checks and holds the turn when one set to **block**
fails, sending Claude the reason; **warn** checks only show. It lets go after three holds in a row, so a check that
cannot pass never loops. Where an organization plugin keeps the turn-end hook (`classic.Stop`) from the mod, the gate
runs as the turn completes instead and sends Claude the reason as a new prompt.

| Check | What it runs | Default |
| --- | --- | --- |
| Tests | `gateTests`, or the package.json `test` script | block |
| Types | `gateTypes`, or a `typecheck` script | block |
| Lint | `gateLint`, or a `lint` script | warn |
| Secrets | key-shaped strings in the added lines | block |
| Scope | dependency files changed (package.json, lockfiles, …) | warn |
| Coverage | `gateCoverage`, compared with `gateCoverageTarget` | warn (off with no command) |
| Leftovers | `console.log`, `debugger`, `print(`, TODO, FIXME added | warn |

The Quality tab adds **Before you review**: the file with the most added lines, changed files with no test changed
beside them, and dependency changes. `gateModes` overrides any check, e.g. `lint:block,coverage:off`.

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
| `gateModes` | empty | `check:block\|warn\|off` pairs over the defaults above |
| `gateTests`, `gateTypes`, `gateLint` | empty | Commands for the gate; empty uses package.json scripts |
| `gateCoverage`, `gateCoverageTarget` | empty, `80` | A command that prints a percentage, and the target |

Themes are JSON files in `themes/` (`{ "floor", "wall", "desk", "accent", "text" }` as `#rrggbb`); drop one in
and `@office theme <file name>` picks it.

## Where data lives

All local. The mod's store (`$.store`, shared by this machine's sessions) holds `events/<session>` (last 500 per session, last 20 sessions),
`memory/entries`, `decisions/<id>`, `tickets/<repo>`, `accounts/<repo>` and `checkpoints/<repo>`; checkpoints are also git refs
under `refs/companyos/`. `/daily`, `/report`, `/replay` and `/handover` write to
`.companyos/` in the working directory; add it to `.gitignore` if you don't want it committed.

## Asking about history

The mod registers `mcp__companyos__events_query`, a read-only view of its event log and decisions, so you can ask
Claude things like "why did the council reject option A yesterday?" or "which skills did the Explore agent load?".

## How tickets sync

The mod registers `mcp__companyos__ticket_update`. `/ticket start PROJ-12` asks Claude to load the ticket with
your connected Jira, Notion or Linear tools, branch and commit with the key, and report status back through that
tool, so the wall, the band and blocked toasts follow the tracker. The mod itself calls no tracker directly,
because tool names differ per connection.

## For admins: what the mod hooks and calls

The mod runs with the user's permissions. `claude plugin validate` reads its source and reports this:

```
./register.tsx hooks: session.start, command.run{command=events}, tool.call, skill.prompt, agent.spawn, session.compact, turn.complete, session.end, ui.render{component=Pane, requestId=companyos-feed}, command.run{command=account}, command.run{command=anthropic}, tool.call{tool=Bash}, tool.call{tool=Edit}, tool.call{tool=Write}, command.run{command=telemetry}, ui.render{component=Pane, requestId=companyos-stats}, ui.render{component=AbovePrompt}, ui.render{component=Spinner}, command.run{command=mem}, prompt.context, ui.render{component=Pane, requestId=companyos-memory}, command.run{command=graph}, ui.render{component=Pane, requestId=companyos-graph}, prompt.submit, prompt.autocomplete, command.run{command=council}, ui.render{component=Pane, requestId=companyos-council}, command.run{command=ticket}, tool.call{tool=/"^mcp__companyos__ticket_update$"/}, ui.render{component=Pane, requestId=companyos-tickets}, command.run{command=mode}, tool.call{tool=/"^mcp__companyos__events_query$"/}, c… [+477 chars]
./register.tsx calls: $.agent.list, $.clock.after, $.clock.every (via officeCommand), $.clock.now, $.command.register, $.command.run, $.fs.list (via loadThemes), $.fs.read (via guess, loadThemes, text, use), $.fs.write (via revert, use, write), $.http.fetch (via log), $.model.complete (via ask1, handover), $.model.fork (via ask1), $.process.run (via line, run, shell), $.prompt.fill (via councilBody), $.prompt.submit (via councilBody, qualityBody, ticketCommand), $.session.append (via restore, revert), $.session.cwd, $.session.id (via allEvents, flush, replay), $.session.identity (via accountSummary, anthropicSummary), $.session.messages (via handover, replay), $.session.model (via anthropicSummary, ask1, handover), $.session.repo (via bound, checkWeather, checkpointBody, dailyPage, rootOf, runGate, scopeOf, storeKey, use), $.session.send (via toAgents), $.session.turns (via checkpoint), $.session.usage, $.state.get, $.state.set, $.store.delete, $.store.get (via allEvents, anthropicComm… [+438 chars]
```

## Develop

```
claude --plugin-dir ./companyos
claude plugin validate ./companyos
claude plugin test ./companyos
tsc -p ./companyos
```

One file per feature under `hooks/`, wired in `hooks/register.tsx`; the `$.state` contract is `types/index.d.ts`.

## Limits

- **Switching the signed-in account mid-session.** No mods API swaps a running session's credentials. `/anthropic use`
  writes a profile into `.claude/settings.local.json` for the next session here, `/login` changes the claude.ai
  account, and `/anthropic route` moves chosen subagents to another model now.
- **Skill detail under organization plugins.** Where a plugin above the mod (for example `cc-plugin-sec-default`)
  passes `skill.prompt` on past it, skill loads are counted from `Skill` tool calls instead: name, agent and
  token cost are kept, the skill's source and frontmatter are not.
- **Tracker calls.** Tickets go through Claude's own connected tools, not `$.mcp` (see How tickets sync).
