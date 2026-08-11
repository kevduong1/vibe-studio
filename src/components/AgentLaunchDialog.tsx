import { useEffect, useMemo, useRef, useState } from "react";
import { lspResolve } from "../lib/ipc";
import { openGlobalTerminal } from "../lib/agentSessions";
import { openWorkspaceTerminal } from "../lib/workspaceSessions";
import {
  allLaunchProfiles,
  definitionForProfile,
  launchCommand,
  parseEnvironmentLines,
  useAgentDefinitionsStore,
  type AgentLaunchProfile,
} from "../stores/agentDefinitions";
import { useWorkspacesStore } from "../stores/workspaces";
import type { AgentKind } from "../lib/agentState";
import { useNativeOverlay } from "../lib/nativeOverlays";
import "./AgentLaunchDialog.css";

export interface AgentLaunchRequest {
  workspacePath: string;
  scope: "global" | "workspace";
  kind: AgentKind;
}

export const requestAgentLaunch = (request: AgentLaunchRequest): void => {
  window.dispatchEvent(new CustomEvent("vibe:launch-agent", { detail: request }));
};

export default function AgentLaunchDialog({
  request,
  onClose,
}: {
  request: AgentLaunchRequest;
  onClose: () => void;
}) {
  useNativeOverlay();
  const customProfiles = useAgentDefinitionsStore((state) => state.customProfiles);
  const profiles = useMemo(() => allLaunchProfiles(), [customProfiles]);
  const initial =
    profiles.find(
      (profile) => definitionForProfile(profile)?.detectionProfile === request.kind,
    ) ?? profiles[0];
  const [profileId, setProfileId] = useState(initial?.id ?? "");
  const selected = profiles.find((profile) => profile.id === profileId) ?? initial;
  const [draft, setDraft] = useState<AgentLaunchProfile>(selected);
  const [health, setHealth] = useState<"checking" | "available" | "missing">("checking");
  const [rememberName, setRememberName] = useState("");
  const launched = useRef(false);
  const definition = draft ? definitionForProfile(draft) : null;
  const built = definition && draft ? launchCommand(definition, draft) : null;

  useEffect(() => {
    if (selected) setDraft({ ...selected, environment: { ...selected.environment }, extraArguments: [...selected.extraArguments] });
  }, [profileId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!definition) {
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
  }, [definition?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!draft) return null;

  const patch = (value: Partial<AgentLaunchProfile>) => setDraft((current) => ({ ...current, ...value }));
  const launch = () => {
    if (launched.current || !definition || !built || health !== "available") return;
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
      window.dispatchEvent(new CustomEvent("vibe:new-worktree-agent", {
        detail: { workspacePath: request.workspacePath, profile: draft },
      }));
      onClose();
      return;
    }
    const ws = useWorkspacesStore
      .getState()
      .workspaces.find((workspace) => workspace.path === request.workspacePath);
    if (!ws) {
      launched.current = false;
      return;
    }
    if (request.scope === "global") {
      openGlobalTerminal(ws.path, definition.detectionProfile, built.environmentPrelude ?? undefined, built.command);
    } else {
      openWorkspaceTerminal(ws, definition.detectionProfile, built.command, built.environmentPrelude ?? undefined);
    }
    onClose();
  };

  return (
    <div className="agent-launch-backdrop" onMouseDown={onClose}>
      <div className="agent-launch-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="agent-launch-title">Launch Agent</div>
        <label>Profile
          <select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
        </label>
        {!definition ? (
          <div className="agent-launch-error">This profile’s agent definition is missing. Select or repair the profile; it will not be changed to another agent.</div>
        ) : (
          <>
            <div className={`agent-launch-health ${health}`}>{definition.name} · {health}</div>
            <div className="agent-launch-grid">
              <label>Model<input value={draft.model ?? ""} placeholder="Agent default" onChange={(event) => patch({ model: event.target.value || null })} /></label>
              <label>Reasoning<input value={draft.reasoning ?? ""} placeholder="Agent default" onChange={(event) => patch({ reasoning: event.target.value || null })} /></label>
              <label>Permission mode<input value={draft.permissionMode ?? ""} placeholder="Agent default" onChange={(event) => patch({ permissionMode: event.target.value || null })} /></label>
              <label>Sandbox<input value={draft.sandbox ?? ""} placeholder="Agent default" onChange={(event) => patch({ sandbox: event.target.value || null })} /></label>
              <label>Folder
                <select value={draft.folderChoice} onChange={(event) => patch({ folderChoice: event.target.value as AgentLaunchProfile["folderChoice"] })}>
                  <option value="current">Current workspace</option>
                  <option value="new-worktree">New isolated worktree…</option>
                </select>
              </label>
            </div>
            <label>Extra arguments<input value={draft.extraArguments.join(" ")} placeholder="Space-separated" onChange={(event) => patch({ extraArguments: event.target.value.split(/\s+/).filter(Boolean) })} /></label>
            <label>Environment (KEY=value per line)
              <textarea
                value={Object.entries(draft.environment).map(([key, value]) => `${key}=${value}`).join("\n")}
                onChange={(event) => patch({
                  environment: parseEnvironmentLines(event.target.value),
                })}
              />
            </label>
            <div className="agent-launch-command"><code>{built?.command}</code></div>
            <label>Save edited profile as<input value={rememberName} placeholder="Optional profile name" onChange={(event) => setRememberName(event.target.value)} /></label>
          </>
        )}
        <div className="agent-launch-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!definition || health !== "available"} onClick={launch}>Launch</button>
        </div>
      </div>
    </div>
  );
}
