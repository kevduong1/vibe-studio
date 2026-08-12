---
name: vibe-agent-control
description: Control live Vibe Studio agent tasks through its authenticated local CLI.
---

# Vibe Studio agent control

Use the bundled `vibe-agent` CLI. Its exact executable path is shown in Vibe
Studio Settings and it is the sibling `../vibe-agent` of this skill directory;
the examples below assume that path is on `PATH`. It talks only to the running
user's mode-0600 Unix socket. Never read, print, copy, or inject
`agent-control.token` into a repository process. For repository-scoped
automation, ask the user/app for a short-lived capability and pass it with
`--token` or `VIBE_STUDIO_CAPABILITY`.

Core commands:

```sh
vibe-agent list
vibe-agent events --after-seq 42 --timeout-ms 30000
vibe-agent start /absolute/project "implement the approved step" --kind codex --name step-name
vibe-agent prompt TERMINAL_ID "run the focused checks" --mode queue --wait --timeout-ms 120000
vibe-agent focus TERMINAL_ID
vibe-agent wait TERMINAL_ID idle blocked --generation 3 --request-id my-wait
vibe-agent cancel my-wait
vibe-agent capability /absolute/project --ttl-seconds 900
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
