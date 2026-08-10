# Repository agent guidance

Read [CLAUDE.md](./CLAUDE.md) before changing the repository. It is the
contributor-facing architecture map and applies to every coding agent, not only
Claude. Feature-specific architecture documents live under `docs/architecture/`.

## Documentation contract

Documentation is part of the implementation. Keep it current in the same
change whenever behavior, architecture, commands, tests, or user-visible UI
changes:

- Update `CLAUDE.md` when responsibilities, invariants, commands, or gotchas
  change.
- Update the relevant `docs/architecture/*.md` document when a subsystem's
  state model, data flow, privacy boundary, or failure behavior changes.
- Update `README.md` when user-visible capabilities or workflows change.
- Update research/roadmap documents when planned work ships or assumptions
  become obsolete; clearly distinguish shipped behavior from proposals.
- Never leave removed types, commands, flags, or test claims in documentation.

For semantic terminal-agent state, read
[docs/architecture/agent-runtime.md](./docs/architecture/agent-runtime.md).
Dedicated Codex tabs intentionally launch with `codex --yolo` in both docks;
do not remove or weaken that default unless the user explicitly changes the
product decision.

## Verification

Run checks proportional to the change. The complete suite is:

```sh
pnpm test
pnpm build
cd src-tauri && cargo test
cd src-tauri && cargo check
```

Preserve unrelated worktree changes. In particular, do not rewrite research or
planning files unless the requested change affects their claims.
