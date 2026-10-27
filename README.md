# CompanyOS

A Claude Code mod that makes every agent action visible. It records each prompt, tool call, skill load,
subagent delegation, compaction and turn (with tokens and cost) into one event log, shows it live in a
pane, and keeps context percent and session cost on the status line.

## Use

- `/events` opens the live event feed pane.
- The status line shows `CompanyOS · ctx 46% · $1.23` after each turn.
- Events persist per session in the mod's store (`events/<session id>`, last 500).

## Develop

```
claude --plugin-dir ./companyos
claude plugin validate ./companyos
claude plugin test ./companyos
```

Requires Claude Code 2.1.287 or later.

## Status

Build order step 1 of the feature document (event capture, store, technical feed). The band above the
prompt, accounts, councils, memory, tickets, non-technical mode and the pixel office follow in order.
