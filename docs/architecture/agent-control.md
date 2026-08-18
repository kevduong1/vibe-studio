# Local agent control plane

Talos exposes a local, authenticated automation surface for semantic
agent state and generation-safe actions. It is intentionally narrower than PTY
control: callers can list, observe, focus, start, prompt, and wait for agents,
but cannot read terminal text, process arguments, environment, or transcripts.

## Transport and authentication

`control.rs` creates `agent-control.sock` and `agent-control.token` in the
per-user application data directory. The directory is mode 0700; the Unix
socket and token file are mode 0600. A fresh 256-bit token is generated at app
start. The frontend may display the two paths but never the token value.

The global token is for same-user tools such as the bundled `talos-agent` CLI.
Repository-scoped automation should receive only a random, short-lived
capability (1–3600 seconds) bound initially to one exact workspace path. When
that capability successfully starts an isolated task, the exact returned
checkout path is delegated to the same token so it can observe and control the
agent it created. This is an explicit path grant, never a prefix rule: unrelated
sibling worktrees remain inaccessible. Capabilities can cancel only active
requests owned by one of their granted paths. They are session-only and are
never injected automatically into PTYs.

The newline-delimited JSON protocol accepts one request per connection and
caps requests at 64 KiB. It is currently a macOS/Unix local API; it does not
listen on TCP or expose remote attachment.

## State, identity, and events

`agentControlPlane.ts` synchronizes the frontend semantic runtime into Rust.
The snapshot contains stable workspace paths, terminal UUIDs, scope, requested
tab kind (nullable for plain shells), detected/effective agent kind, occupancy,
occupant PID, monotonic generation,
lifecycle, seen state, transition time, and bounded reason/authority/rule IDs.
It also carries the live background-work count and CLI-authored noun summary;
this is read-only semantic context containing no command text.
The existing `kind` field remains the detected kind while an occupant is live;
the additive `requestedKind` field explains dedicated-tab defaults and
cross-kind occupants without breaking existing clients.
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
may write during active work. Both reserve a terminal input-queue slot before
checkpointing, so earlier keyboard input completes first and later input cannot
overtake the delivery. An input-owned turn remains gated until semantic output
leaves its accepting prompt state; a fast PTY write cannot make the next queued
request mistake the prior turn for its own. Immediately before dispatch, the
frontend asks Rust to commit the exact request/delivery pair. Under the same
lock, Rust rejects cancellation or an elapsed deadline, revalidates the pinned
terminal generation, makes the action non-cancellable, and—for prompts—captures
the current event sequence and working state as the turn boundary. Focus and
start use the same commit immediately before their first irreversible UI/launch
action. Prompt-and-wait uses one overall
deadline and the ordered event ring after that boundary to observe a working
edge followed by idle/blocked. Thus it
neither mistakes the preceding turn of a queued prompt for completion nor loses
a fast completed turn behind the frontend response. It fails if the occupant
generation changes.
Independent waits use the same generation pin. Request IDs allow cancellation;
if a request is still preparing, Rust tells the frontend to remove or stop it
before returning. Once the backend commit wins, a later cancel reports
`cancelled: false, committed: true` and the original request returns its actual
result; it never claims that an already-launched agent or delivered prompt was
cancelled. A post-commit frontend response timeout is reported explicitly as an
uncertain completed outcome and does not emit cancellation. Active-request project ownership
and the terminal's actual synchronized workspace—not a caller-supplied alias—
enforce capability scope.

Caller-owned request IDs may be reused after a request finishes even while its
old frontend handler is still unwinding. Rust therefore assigns every frontend
dispatch a fresh delivery ID. Prompt boundaries and responses must echo both
identities, cancellation events carry both, and the frontend prompt queue uses
the delivery ID internally. A late callback or cancellation for an expired
delivery cannot answer, cancel, or remove its replacement.

Every frontend-routed request carries the backend's absolute deadline. The
frontend checks cancellation and that deadline again after asynchronous
side-effect boundaries, while the final backend commit is authoritative. A
cancelled shared start may resolve the repository or open its workspace but
never launches a terminal afterward. If an isolated
start is cancelled after Git created its checkout, the checkout and task record
remain recoverable/listable, but workspace opening and agent launch stop at the
next safe boundary.

Prompt text is bounded to 8,192 characters in session memory and is not persisted. Start
prompts become ordinary CLI launch arguments and therefore follow the selected
agent's own process/history behavior. Programmatic prompts strip terminal
control characters and use one bracketed paste plus one final Enter; the
fallback is a flattened single line.

## Bundled client and skill

The app bundle includes `resources/talos-agent` and
`resources/talos-agent-skill/SKILL.md`. The CLI commands are:

```sh
talos-agent list
talos-agent events --after-seq 42 --timeout-ms 30000
talos-agent start /absolute/project "implement the approved step" --kind codex
talos-agent prompt TERMINAL_ID "run checks" --generation 3 --wait
talos-agent focus TERMINAL_ID
talos-agent wait TERMINAL_ID idle blocked --generation 3 --request-id wait-1
talos-agent cancel wait-1
talos-agent capability /absolute/project --ttl-seconds 900
```

Settings shows the exact bundled CLI and skill paths (and can copy the CLI
path); the bundle does not mutate the user's `PATH`. The CLI locates the normal
app-data socket/token by default and accepts
`--socket`, `--token-file`, or a project capability through `--token` or
`TALOS_CAPABILITY`. Packaged copies discover app data through their
nearest `Info.plist`; the unbundled `tauri dev` copy reads the nearest Tauri
development config so it cannot accidentally connect to the release socket.
It prints structured JSON and returns nonzero on API errors.

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
