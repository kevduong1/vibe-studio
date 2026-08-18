import { useEffect, useMemo, useRef, useState } from "react";
import { lspResolve } from "../lib/ipc";
import { openGlobalTerminal } from "../lib/agentSessions";
import { openWorkspaceTerminal } from "../lib/workspaceSessions";
import { useProjectDisplayNames } from "../lib/projectNames";
import {
  agentDefinitionDetectionConflict,
  allLaunchProfiles,
  definitionForProfile,
  invalidEnvironmentLines,
  launchCommand,
  parseEnvironmentLines,
  useAgentDefinitionsStore,
  type AgentLaunchProfile,
} from "../stores/agentDefinitions";
import { useWorkspacesStore } from "../stores/workspaces";
import { useNativeOverlay } from "../lib/nativeOverlays";
import type { AgentKind } from "../lib/agentState";
import type { AgentLaunchRequest } from "../lib/agentLaunchRequest";
import { IcChevronRight, IcClaude, IcCodex, IcFolder } from "./icons";
import "./AgentLaunchDialog.css";

const copyProfile = (profile: AgentLaunchProfile): AgentLaunchProfile => ({
  ...profile,
  environment: { ...profile.environment },
  extraArguments: [...profile.extraArguments],
});

const environmentString = (profile: AgentLaunchProfile): string =>
  Object.entries(profile.environment)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

export default function AgentLaunchDialog({
  request,
  onClose,
}: {
  request: AgentLaunchRequest;
  onClose: () => void;
}) {
  useNativeOverlay();
  const customProfiles = useAgentDefinitionsStore((state) => state.customProfiles);
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const projectDisplayName = useProjectDisplayNames();
  const profiles = useMemo(() => allLaunchProfiles(), [customProfiles]);
  const initial =
    profiles.find(
      (profile) => definitionForProfile(profile)?.detectionProfile === request.kind,
    ) ?? profiles[0];
  const [profileId, setProfileId] = useState(initial?.id ?? "");
  const [workspacePath, setWorkspacePath] = useState(() =>
    workspaces.some((workspace) => workspace.path === request.workspacePath)
      ? request.workspacePath
      : workspaces[0]?.path ?? request.workspacePath,
  );
  const selected = profiles.find((profile) => profile.id === profileId) ?? initial;
  const [draft, setDraft] = useState<AgentLaunchProfile | undefined>(() =>
    selected ? copyProfile(selected) : undefined,
  );
  const [health, setHealth] = useState<"checking" | "available" | "missing">("checking");
  const [rememberName, setRememberName] = useState("");
  const [environmentText, setEnvironmentText] = useState(() =>
    selected ? environmentString(selected) : "",
  );
  const launched = useRef(false);
  const definition = draft ? definitionForProfile(draft) : null;
  const selectedKind = definition?.detectionProfile ?? request.kind;
  const detectionConflict = definition
    ? agentDefinitionDetectionConflict(definition)
    : null;
  const built = definition && draft ? launchCommand(definition, draft) : null;
  const invalidEnvironment = invalidEnvironmentLines(environmentText);
  const selectedWorkspace = workspaces.find((workspace) => workspace.path === workspacePath);
  const worktreeUnavailable =
    draft?.folderChoice === "new-worktree" && !selectedWorkspace?.isGitRepository;
  const profilesForKind = profiles.filter(
    (profile) => definitionForProfile(profile)?.detectionProfile === selectedKind,
  );
  const unavailableProfiles = profiles.filter((profile) => !definitionForProfile(profile));

  useEffect(() => {
    if (!selected) return;
    setDraft(copyProfile(selected));
    setEnvironmentText(environmentString(selected));
    setRememberName("");
  }, [selected]);

  useEffect(() => {
    if (!definition) {
      setHealth("missing");
      return;
    }
    if (detectionConflict) {
      setHealth("missing");
      return;
    }
    let cancelled = false;
    setHealth("checking");
    void lspResolve(definition.executable, [], false).then(
      (result) => !cancelled && setHealth(result.path ? "available" : "missing"),
      () => !cancelled && setHealth("missing"),
    );
    return () => { cancelled = true; };
  }, [definition?.id, definition?.executable, detectionConflict]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!draft) return null;

  const patch = (value: Partial<AgentLaunchProfile>) =>
    setDraft((current) => current ? { ...current, ...value } : current);

  const selectAgent = (kind: AgentKind) => {
    const next = profiles.find(
      (profile) => definitionForProfile(profile)?.detectionProfile === kind,
    );
    if (next) setProfileId(next.id);
  };

  const launch = () => {
    if (
      launched.current ||
      !selectedWorkspace ||
      !definition ||
      !built ||
      detectionConflict ||
      health !== "available" ||
      worktreeUnavailable ||
      invalidEnvironment.length > 0
    ) return;
    launched.current = true;
    if (rememberName.trim()) {
      useAgentDefinitionsStore.getState().upsertProfile({
        ...draft,
        id: crypto.randomUUID(),
        name: rememberName.trim(),
        builtin: false,
      });
    }
    if (draft.folderChoice === "new-worktree") {
      window.dispatchEvent(new CustomEvent("talos:new-worktree-agent", {
        detail: { workspacePath: selectedWorkspace.path, profile: draft },
      }));
      onClose();
      return;
    }
    if (request.scope === "global") {
      openGlobalTerminal(
        selectedWorkspace.path,
        definition.detectionProfile,
        built.environmentPrelude ?? undefined,
        built.command,
      );
    } else {
      openWorkspaceTerminal(
        selectedWorkspace,
        definition.detectionProfile,
        built.command,
        built.environmentPrelude ?? undefined,
      );
      useWorkspacesStore.getState().setActive(selectedWorkspace.path);
    }
    onClose();
  };

  const healthLabel = detectionConflict
    ? "Configuration conflict"
    : health === "checking"
      ? "Checking availability…"
      : health === "available"
        ? "Available"
        : "Not found";
  const launchDisabled =
    !selectedWorkspace ||
    !definition ||
    Boolean(detectionConflict) ||
    health !== "available" ||
    worktreeUnavailable ||
    invalidEnvironment.length > 0;

  return (
    <div className="agent-launch-backdrop" onMouseDown={onClose}>
      <div
        className="agent-launch-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-launch-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="agent-launch-heading">
          <h2 id="agent-launch-title">Launch Agent</h2>
          <p>Choose an agent and the project it should work in.</p>
        </header>

        <section className="agent-launch-section" aria-labelledby="agent-launch-agent-label">
          <div className="agent-launch-section-label" id="agent-launch-agent-label">Agent</div>
          <div className="agent-launch-agent-options" role="group" aria-label="Agent">
            <button
              type="button"
              className={`agent-launch-agent-card ${selectedKind === "claude" ? "selected" : ""}`}
              aria-pressed={selectedKind === "claude"}
              onClick={() => selectAgent("claude")}
            >
              <span className="agent-launch-agent-icon"><IcClaude /></span>
              <span className="agent-launch-agent-copy">
                <strong>Claude</strong>
                <small>Claude Code CLI</small>
              </span>
              <span className="agent-launch-agent-check" aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`agent-launch-agent-card ${selectedKind === "codex" ? "selected" : ""}`}
              aria-pressed={selectedKind === "codex"}
              onClick={() => selectAgent("codex")}
            >
              <span className="agent-launch-agent-icon"><IcCodex /></span>
              <span className="agent-launch-agent-copy">
                <strong>Codex</strong>
                <small>Codex CLI</small>
              </span>
              <span className="agent-launch-agent-check" aria-hidden="true" />
            </button>
          </div>
          {definition ? (
            <div className={`agent-launch-health ${health}`} aria-live="polite">
              <span className="agent-launch-health-dot" aria-hidden="true" />
              <span>{definition.name} · {healthLabel}</span>
            </div>
          ) : (
            <div className="agent-launch-error">
              This profile’s agent definition is missing. Select or repair the profile; it will not be changed to another agent.
            </div>
          )}
        </section>

        <section className="agent-launch-section" aria-labelledby="agent-launch-project-label">
          <label className="agent-launch-field" htmlFor="agent-launch-project">
            <span id="agent-launch-project-label">Project</span>
            <span className="agent-launch-project-select">
              <IcFolder aria-hidden="true" />
              <select
                id="agent-launch-project"
                value={workspacePath}
                onChange={(event) => setWorkspacePath(event.target.value)}
              >
                {workspaces.map((workspace) => (
                  <option key={workspace.path} value={workspace.path}>
                    {projectDisplayName(workspace.path)} — {workspace.path}
                  </option>
                ))}
              </select>
            </span>
          </label>
          {selectedWorkspace && (
            <div className="agent-launch-project-path" title={selectedWorkspace.path}>
              {selectedWorkspace.path}
            </div>
          )}
        </section>

        <details className="agent-launch-advanced">
          <summary>
            <span className="agent-launch-advanced-title">
              <IcChevronRight aria-hidden="true" />
              Advanced
            </span>
            <span>Profile and launch options</span>
          </summary>
          <div className="agent-launch-advanced-content">
            <label className="agent-launch-field">Profile
              <select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
                {profilesForKind.map((profile) => (
                  <option key={profile.id} value={profile.id}>{profile.name}</option>
                ))}
                {unavailableProfiles.length > 0 && (
                  <optgroup label="Unavailable profiles">
                    {unavailableProfiles.map((profile) => (
                      <option key={profile.id} value={profile.id} disabled>{profile.name} — missing definition</option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
            <div className="agent-launch-grid">
              <label className="agent-launch-field">Launch in
                <select
                  value={draft.folderChoice}
                  onChange={(event) => patch({ folderChoice: event.target.value as AgentLaunchProfile["folderChoice"] })}
                >
                  <option value="current">Project root</option>
                  <option value="new-worktree" disabled={!selectedWorkspace?.isGitRepository}>
                    New isolated worktree…
                  </option>
                </select>
              </label>
              {definition?.capabilities.models && (
                <label className="agent-launch-field">Model
                  <input value={draft.model ?? ""} placeholder="Agent default" onChange={(event) => patch({ model: event.target.value || null })} />
                </label>
              )}
              {definition?.capabilities.reasoning && (
                <label className="agent-launch-field">Reasoning
                  <input value={draft.reasoning ?? ""} placeholder="Agent default" onChange={(event) => patch({ reasoning: event.target.value || null })} />
                </label>
              )}
              {definition?.capabilities.permissions && (
                <label className="agent-launch-field">Permission mode
                  <input value={draft.permissionMode ?? ""} placeholder="Agent default" onChange={(event) => patch({ permissionMode: event.target.value || null })} />
                </label>
              )}
              {definition?.capabilities.sandbox && (
                <label className="agent-launch-field">Sandbox
                  <input value={draft.sandbox ?? ""} placeholder="Agent default" onChange={(event) => patch({ sandbox: event.target.value || null })} />
                </label>
              )}
            </div>
            <label className="agent-launch-field">
              <span>Extra arguments <small>(one argument per line)</small></span>
              <textarea
                value={draft.extraArguments.join("\n")}
                placeholder={"--flag\nvalue with spaces"}
                onChange={(event) => patch({ extraArguments: event.target.value.split("\n").filter((value) => value.length > 0) })}
              />
            </label>
            <label className="agent-launch-field">
              <span>Environment <small>(KEY=value per line)</small></span>
              <textarea
                value={environmentText}
                onChange={(event) => {
                  setEnvironmentText(event.target.value);
                  patch({ environment: parseEnvironmentLines(event.target.value) });
                }}
              />
            </label>
            <div className="agent-launch-command" title="Command preview"><code>{built?.command}</code></div>
            <label className="agent-launch-field">Save edited profile as
              <input value={rememberName} placeholder="Optional profile name" onChange={(event) => setRememberName(event.target.value)} />
            </label>
          </div>
        </details>

        {detectionConflict && <div className="agent-launch-error">{detectionConflict}</div>}
        {invalidEnvironment.length > 0 && <div className="agent-launch-error">
          Invalid environment assignment on {invalidEnvironment.length === 1 ? "line" : "lines"} {invalidEnvironment.join(", ")}.
        </div>}
        {worktreeUnavailable && <div className="agent-launch-error">
          Choose a Git project, or launch in the project root.
        </div>}
        {!selectedWorkspace && <div className="agent-launch-error">
          The selected project is no longer open.
        </div>}

        <div className="agent-launch-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" disabled={launchDisabled} onClick={launch}>Launch Agent</button>
        </div>
      </div>
    </div>
  );
}
