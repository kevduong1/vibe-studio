# Local agent control plane

Vibe Studio exposes a local, authenticated automation surface for semantic
agent state and generation-safe actions. It is intentionally narrower than PTY
control: callers can list, observe, focus, start, prompt, and wait for agents,
but cannot read terminal text, process arguments, environment, or transcripts.

## Transport and authentication

`control.rs` creates `agent-control.sock` and `agent-control.token` in the
per-user application data directory. The directory is mode 0700; the Unix
socket and token file are mode 0600. A fresh 256-bit token is generated at app
start. The frontend may display the two paths but never the token value.

The global token is for same-user tools such as the bundled `vibe-agent` CLI.
Repository-scoped automation should receive only a random, short-lived
capability (1–3600 seconds) bound to one exact workspace path. Capabilities can
observe and act only on that project and can cancel only active requests owned
by it. They are session-only and are never injected automatically into PTYs.

The newline-delimited JSON protocol accepts one request per connection and
caps requests at 64 KiB. It is currently a macOS/Unix local API; it does not
listen on TCP or expose remote attachment.

## State, identity, and events

`agentControlPlane.ts` synchronizes the frontend semantic runtime into Rust.
The snapshot contains stable workspace paths, terminal UUIDs, scope, requested
or discovered agent kind, occupancy, occupant PID, monotonic generation,
lifecycle, seen state, transition time, and bounded reason/authority/rule IDs.
Task UUIDs and opaque native-session IDs remain in their owning task records.

Rust assigns a monotonically increasing sequence to upsert and removal events
and retains the latest 1024. Consumers start with `list`, then call `events`
with the snapshot sequence. If the requested history fell out of the ring, the
response sets `resync: true` and includes a replacement filtered snapshot.
Every long poll has an explicit 1–300,000 ms timeout.

## Actions and waiting

`focus`, `prompt`, and `start` are routed only to the main IDE webview; Rust
never writes directly to a PTY or broadcasts prompt text to preview webviews.
Starts create an isolated task/worktree by default.
Shared-checkout starts require an explicit CLI flag.

Prompt requests pin the occupant generation before frontend dispatch. Queue is
the default and waits for an idle/question-owned prompt; steer is explicit and
may write during active work. Both checkpoint an isolated task before the text
reaches the PTY. Prompt-and-wait uses one overall deadline, observes a working
edge followed by idle/blocked, and fails if the occupant generation changes.
Independent waits use the same generation pin. Request IDs allow cancellation;
if a queued prompt is still checkpointing or waiting for safe input, Rust tells
the frontend to remove it before returning. Active-request project ownership
and the terminal's actual synchronized workspace—not a caller-supplied alias—
enforce capability scope.

Prompt text is bounded to 8,192 characters in session memory and is not persisted. Start
prompts become ordinary CLI launch arguments and therefore follow the selected
agent's own process/history behavior. Programmatic prompts strip terminal
control characters and use one bracketed paste plus one final Enter; the
fallback is a flattened single line.

## Bundled client and skill

The app bundle includes `resources/vibe-agent` and
`resources/vibe-agent-skill/SKILL.md`. The CLI commands are:

```sh
vibe-agent list
vibe-agent events --after-seq 42 --timeout-ms 30000
vibe-agent start /absolute/project "implement the approved step" --kind codex
vibe-agent prompt TERMINAL_ID "run checks" --generation 3 --wait
vibe-agent focus TERMINAL_ID
vibe-agent wait TERMINAL_ID idle blocked --generation 3 --request-id wait-1
vibe-agent cancel wait-1
vibe-agent capability /absolute/project --ttl-seconds 900
```

Settings shows the exact bundled CLI and skill paths (and can copy the CLI
path); the bundle does not mutate the user's `PATH`. The CLI locates the normal
app-data socket/token by default and accepts
`--socket`, `--token-file`, or a project capability through `--token` or
`VIBE_STUDIO_CAPABILITY`. It prints structured JSON and returns nonzero on API
errors.

## Failure behavior

- Missing frontend responses, event/state waits, and prompt turns time out.
- Cancellation wakes the owning request immediately.
- A missing terminal or changed generation fails rather than retargeting.
- Frontend reload/removal produces ordered removal events; reconnecting clients
  resnapshot when history is unavailable.
- Socket setup failure does not prevent the IDE from opening. Reopening
  Settings retries setup instead of reporting a false running state.
- Closing the app stops the listener and removes the socket and token file. No
  semantic state, capability, or event history survives restart.
