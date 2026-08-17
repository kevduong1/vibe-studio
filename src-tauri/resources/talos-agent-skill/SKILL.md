---
name: talos-agent-control
description: Control live Talos agent tasks through its authenticated local CLI.
---

# Talos agent control

Use the bundled `talos-agent` CLI. Its exact executable path is shown in Talos
Settings and it is the sibling `../talos-agent` of this skill directory;
the examples below assume that path is on `PATH`. It talks only to the running
user's mode-0600 Unix socket. Never read, print, copy, or inject
`agent-control.token` into a repository process. For repository-scoped
automation, ask the user/app for a short-lived capability and pass it with
`--token` or `TALOS_CAPABILITY`.

Core commands:

```sh
talos-agent list
talos-agent events --after-seq 42 --timeout-ms 30000
talos-agent start /absolute/project "implement the approved step" --kind codex --name step-name
talos-agent prompt TERMINAL_ID "run the focused checks" --mode queue --wait --timeout-ms 120000
talos-agent focus TERMINAL_ID
talos-agent wait TERMINAL_ID idle blocked --generation 3 --request-id my-wait
talos-agent cancel my-wait
talos-agent capability /absolute/project --ttl-seconds 900
```

`start` creates an isolated worktree by default; pass `--shared` only when the
caller explicitly wants the existing checkout. Prompt and wait operations pin
the terminal occupant generation. A project capability that successfully
starts an isolated task is explicitly delegated access to that returned
checkout, so the same token can list, wait for, focus, and prompt its agent;
unrelated sibling worktrees remain inaccessible. Prefer `queue`; use `steer`
only when the user explicitly wants input sent during active work.

Event consumers must begin with `list`, then request `events` after the
snapshot sequence. When an events response says `resync: true`, discard local
state and use its replacement snapshot. Always set a finite timeout. Prompt
text is bounded in memory and not persisted by the control plane.

Cancellation is authoritative only before the frontend action commit. A cancel
response with `cancelled: false, committed: true` means the launch, focus, or
prompt already crossed that boundary; wait for the original request's result
instead of retrying it.
