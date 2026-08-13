/**
 * ⌘, settings: centered modal overlay (QuickOpen/TaskPicker shell — backdrop
 * click-catcher, owns the keyboard while open). Sections are plain blocks so
 * future non-LSP settings can be appended.
 *
 * The Language Servers section shows live per-server status for the ACTIVE
 * workspace (servers are per workspace × language); with no workspace open
 * only the persistent enable toggles render.
 */
import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  bannerMode,
  playAttentionSound,
  setAttentionSoundPath,
  setBannerMode,
  storedAttentionSound,
  SYSTEM_SOUNDS,
  systemSoundPath,
  type BannerMode,
} from "../lib/agentNotifications";
import { copyText } from "../lib/clipboard";
import {
  APP_THEME_GROUPS,
  APP_THEMES,
  setAppTheme,
  useAppTheme,
} from "../lib/appTheme";
import { agentControlInfo, executableVersion, lspResolve } from "../lib/ipc";
import { useNativeOverlay } from "../lib/nativeOverlays";
import { AGENT_PROFILES } from "../lib/agentProfiles";
import { basename } from "../lib/path";
import {
  getWorkspaceLsp,
  useLspStatusVersionValue,
  type LspServerInfo,
} from "../lib/lsp/servers";
import {
  LSP_LANGUAGES,
  setLanguageEnabled,
  setLspMode,
  STATUS_KIND,
  STATUS_LABEL,
  useLspMode,
  useLspSettings,
} from "../lib/lsp/settings";
import type { ServerLang } from "../lib/lsp/types";
import { useActiveWorkspace, type Workspace } from "../stores/workspaces";
import { useUsageStore } from "../stores/usage";
import { useCodexUsageStore } from "../stores/codexUsage";
import {
  allAgentDefinitions,
  useAgentDefinitionsStore,
  type AgentDefinition,
} from "../stores/agentDefinitions";
import { useAgentRuntimeStore } from "../stores/agentRuntime";
import {
  runTerminalRecipe,
  useTerminalRecipesStore,
} from "../stores/terminalRecipes";
import { IcClose, IcPlay, IcRefresh } from "./icons";
import "./SettingsModal.css";

function AppearanceSettings() {
  const theme = useAppTheme((state) => state.theme);

  return (
    <div className="settings-theme-library">
      {APP_THEME_GROUPS.map((group) => (
        <div
          className="settings-theme-group"
          role="group"
          aria-labelledby={`settings-theme-${group.id}`}
          key={group.id}
        >
          <div className="settings-theme-group-name" id={`settings-theme-${group.id}`}>
            {group.label}
          </div>
          <div className="settings-theme-grid">
            {APP_THEMES.filter((option) => option.group === group.id).map((option) => (
              <button
                key={option.id}
                className={`settings-theme-option${theme === option.id ? " active" : ""}`}
                data-theme={option.id}
                aria-pressed={theme === option.id}
                onClick={() => setAppTheme(option.id)}
              >
                <span className="settings-theme-preview" aria-hidden="true">
                  <span className="settings-theme-preview-app" />
                  <span className="settings-theme-preview-sidebar" />
                  <span className="settings-theme-preview-editor" />
                </span>
                <span className="settings-theme-name">{option.label}</span>
                <span className="settings-theme-description">{option.description}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ServerRow({
  lang,
  label,
  installHint,
  ws,
  enabled,
  modeOn,
}: {
  lang: ServerLang;
  label: string;
  installHint: string;
  ws: Workspace | null;
  /** Raw persisted per-language toggle (editable even while mode is off). */
  enabled: boolean;
  modeOn: boolean;
}) {
  const info: LspServerInfo | null = ws
    ? getWorkspaceLsp(ws.path).serverInfo(lang)
    : null;
  // Status/install/restart key off the EFFECTIVE state (mode AND toggle);
  // the switch below stays bound to the raw toggle.
  const effective = modeOn && enabled;
  const status = info?.status ?? (effective ? "stopped" : "disabled");
  const showInstall = effective && status === "missing";
  // Restart doubles as "recheck" for a missing binary (it re-resolves with a
  // fresh login-shell PATH, so install-then-click works).
  const showRestart =
    !!ws && effective && (status === "running" || status === "crashed" || status === "missing");

  return (
    <div className={`settings-row${modeOn ? "" : " off"}`}>
      <div className="settings-row-main">
        <span className="settings-row-name">{label}</span>
        <span
          className="settings-row-status"
          title={info?.error ?? info?.resolved?.path ?? undefined}
        >
          <span className={`lsp-dot ${STATUS_KIND[status]}`} />
          {STATUS_LABEL[status]}
          {status === "crashed" && info?.error ? ` — ${info.error}` : ""}
        </span>
        {showInstall && (
          <span className="settings-install">
            <code>{installHint}</code>
            <button
              className="settings-copy"
              title="Copy install command"
              onClick={() => void copyText(installHint)}
            >
              Copy
            </button>
          </span>
        )}
      </div>
      {showRestart && (
        <button
          className="icon-btn"
          title={status === "missing" ? "Recheck binary" : "Restart server"}
          onClick={() => ws && getWorkspaceLsp(ws.path).restartServer(lang)}
        >
          <IcRefresh />
        </button>
      )}
      <button
        className={`settings-toggle ${enabled ? "on" : ""}`}
        role="switch"
        aria-checked={enabled}
        title={`${enabled ? "Disable" : "Enable"} ${label}`}
        onClick={() => setLanguageEnabled(lang, !enabled)}
      />
    </div>
  );
}

/** Attention-sound picker: the bundled default, the standard system sounds,
 *  or any audio file. Selection persists immediately and previews itself. */
function AttentionSoundRow() {
  // null = the bundled default (sounds/alert.mp3) — same encoding as storage.
  const [sound, setSound] = useState(storedAttentionSound);
  const systemName = sound
    ? SYSTEM_SOUNDS.find((n) => systemSoundPath(n) === sound)
    : undefined;

  const preview = () => void playAttentionSound();
  const pick = (path: string | null) => {
    setAttentionSoundPath(path);
    setSound(path);
    preview();
  };
  const onChange = async (value: string) => {
    if (value === "default") {
      pick(null);
      return;
    }
    if (value !== "choose") {
      pick(systemSoundPath(value));
      return;
    }
    const file = await openDialog({
      multiple: false,
      directory: false,
      filters: [
        {
          name: "Audio",
          extensions: ["aiff", "aif", "wav", "mp3", "m4a", "caf", "flac"],
        },
      ],
    });
    // Cancel: the controlled value simply snaps back to the current sound.
    if (typeof file === "string") pick(file);
  };

  return (
    <div className="settings-row">
      <div className="settings-row-main">
        <span className="settings-row-name">Attention sound</span>
        <span className="settings-row-status" title={sound ?? undefined}>
          {sound === null
            ? "Bundled alert"
            : systemName
              ? "macOS system sound"
              : sound}
        </span>
      </div>
      <select
        className="settings-select"
        value={sound === null ? "default" : (systemName ?? "custom")}
        onChange={(e) => void onChange(e.target.value).catch(() => {})}
      >
        <option value="default">Alert (default)</option>
        {SYSTEM_SOUNDS.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
        {sound !== null && !systemName && (
          // Inert label for the ACTIVE custom file. Switching files goes
          // through "Choose file…" — re-selecting the selected option never
          // fires onChange, so the action must live on a distinct value.
          <option value="custom">Custom — {basename(sound)}</option>
        )}
        <option value="choose">Choose file…</option>
      </select>
      <button
        className="icon-btn"
        title="Preview sound"
        onClick={preview}
      >
        <IcPlay />
      </button>
    </div>
  );
}

/** Banner visibility: macOS only presents banners from a frontmost app when
 *  notify.rs' delegate allows it — "Always" opts into that; "App in
 *  background" keeps the OS default; "Never" is sound-only. */
function BannerModeRow() {
  const [mode, setMode] = useState(bannerMode);
  const LABEL: Record<BannerMode, string> = {
    always: "Even while the app is focused",
    background: "Only while the app is in the background",
    never: "Sound only",
  };
  const pick = (value: string) => {
    const m: BannerMode =
      value === "background" || value === "never" ? value : "always";
    setBannerMode(m);
    setMode(m);
  };
  return (
    <div className="settings-row">
      <div className="settings-row-main">
        <span className="settings-row-name">Show banners</span>
        <span className="settings-row-status">{LABEL[mode]}</span>
      </div>
      <select
        className="settings-select"
        value={mode}
        onChange={(e) => pick(e.target.value)}
      >
        <option value="always">Always</option>
        <option value="background">App in background</option>
        <option value="never">Never</option>
      </select>
    </div>
  );
}

function AgentIntegrationRow({ definition }: { definition: AgentDefinition }) {
  const [status, setStatus] = useState("Checking…");
  const probeSequence = useRef(0);
  const probe = (refresh: boolean) => {
    const sequence = ++probeSequence.current;
    setStatus("Checking…");
    void lspResolve(definition.executable, [], refresh).then(async (result) => {
      if (sequence !== probeSequence.current) return;
      if (!result.path) {
        setStatus("Unavailable — not found in login-shell PATH");
        return;
      }
      try {
        const version = await executableVersion(result.path);
        if (sequence === probeSequence.current) setStatus(version);
      } catch (error) {
        if (sequence === probeSequence.current) setStatus(`Probe failed — ${String(error)}`);
      }
    }, (error) => {
      if (sequence === probeSequence.current) setStatus(`Unavailable — ${String(error)}`);
    });
  };
  useEffect(() => {
    probe(false);
    return () => {
      probeSequence.current += 1;
    };
  }, [definition.executable]); // eslint-disable-line react-hooks/exhaustive-deps
  const capabilities = Object.entries(definition.capabilities)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .join(", ");
  return (
    <div className="settings-row">
      <div className="settings-row-main">
        <span className="settings-row-name">{definition.name}</span>
        <span className="settings-row-status">
          <span className={`lsp-dot ${status.startsWith("Unavailable") || status.startsWith("Probe failed") ? "crashed" : status === "Checking…" ? "idle" : "ok"}`} />
          {status}
        </span>
        <span className="settings-row-status">
          {definition.transport} · {definition.detectionProfile} detection · resume {definition.resumeSupport} · {capabilities}
        </span>
      </div>
      <button className="icon-btn" title="Refresh integration health" onClick={() => probe(true)}><IcRefresh /></button>
    </div>
  );
}

function AgentIntegrations() {
  const customDefinitions = useAgentDefinitionsStore((state) => state.customDefinitions);
  const [name, setName] = useState("");
  const [executable, setExecutable] = useState("");
  const [profile, setProfile] = useState<"claude" | "codex">("claude");
  const definitions = allAgentDefinitions();
  const add = () => {
    if (!name.trim() || !executable.trim()) return;
    const id = `custom.${crypto.randomUUID()}`;
    useAgentDefinitionsStore.getState().upsertDefinition({
      id,
      name: name.trim(),
      executable: executable.trim(),
      defaultArguments: [],
      transport: "terminal",
      detectionProfile: profile,
      resumeSupport: "none",
      capabilities: { models: true, reasoning: profile === "codex", permissions: true, sandbox: profile === "codex", subagents: true },
      builtin: false,
    });
    useAgentDefinitionsStore.getState().upsertProfile({
      id: `profile.${crypto.randomUUID()}`,
      name: `${name.trim()} — Default`,
      definitionId: id,
      model: null,
      reasoning: null,
      permissionMode: null,
      sandbox: null,
      environment: {},
      extraArguments: [],
      folderChoice: "current",
      builtin: false,
    });
    setName("");
    setExecutable("");
  };
  return (
    <>
      {definitions.map((definition) => <AgentIntegrationRow key={definition.id} definition={definition} />)}
      <div className="settings-agent-add">
        <input value={name} placeholder="Custom agent name" onChange={(event) => setName(event.target.value)} />
        <input value={executable} placeholder="Executable" onChange={(event) => setExecutable(event.target.value)} />
        <select value={profile} onChange={(event) => setProfile(event.target.value as "claude" | "codex")}>
          <option value="claude">Claude screen profile</option>
          <option value="codex">Codex screen profile</option>
        </select>
        <button disabled={!name.trim() || !executable.trim()} onClick={add}>Add</button>
      </div>
      {customDefinitions.length > 0 && (
        <p className="settings-hint">Custom commands keep their definition IDs. Missing definitions disable their profiles instead of silently launching another agent.</p>
      )}
    </>
  );
}

/** Privacy-bounded explain view: configuration versions plus the semantic
 * fields already held in memory. It deliberately never renders terminal
 * text, process arguments, environment, or submitted prompts. */
function AgentDetectionDiagnostics() {
  const states = useAgentRuntimeStore((state) => state.states);
  const rows = Object.values(states).sort((a, b) =>
    a.workspacePath.localeCompare(b.workspacePath) || a.terminalId.localeCompare(b.terminalId),
  );
  return (
    <>
      <div className="settings-profile-versions">
        {Object.values(AGENT_PROFILES).map((profile) => (
          <code key={profile.kind}>
            {profile.kind} v{profile.version} · {profile.authoredFor} · {profile.rules.length} rules
          </code>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="settings-hint">No monitored terminal sessions.</p>
      ) : rows.map((runtime) => (
        <div className="settings-row" key={runtime.terminalId}>
          <div className="settings-row-main">
            <span className="settings-row-name">
              {runtime.kind} · {runtime.terminalId.slice(0, 8)} · generation {runtime.generation}
            </span>
            <span className="settings-row-status">
              {runtime.occupancy} / {runtime.lifecycle} · authority {runtime.authority ?? "none"} · rule {runtime.matchedRule ?? "none"}
            </span>
            <span className="settings-row-status" title={runtime.workspacePath}>
              {runtime.scope} · {runtime.workspacePath}
            </span>
          </div>
        </div>
      ))}
    </>
  );
}

const EMPTY_RECIPES: never[] = [];

function TerminalRecipes({ ws }: { ws: Workspace | null }) {
  const recipes = useTerminalRecipesStore((state) =>
    ws ? (state.projects[ws.path] ?? EMPTY_RECIPES) : EMPTY_RECIPES,
  );
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  if (!ws) return <p className="settings-hint">Open a project to configure its recipes.</p>;
  const add = () => {
    if (!name.trim() || !command.trim()) return;
    useTerminalRecipesStore.getState().add(ws.path, name, command);
    setName("");
    setCommand("");
  };
  return (
    <>
      {recipes.map((recipe) => (
        <div className="settings-row" key={recipe.id}>
          <div className="settings-row-main">
            <span className="settings-row-name">{recipe.name}</span>
            <code className="settings-recipe-command">{recipe.command}</code>
            <label className="settings-recipe-policy">
              <input
                type="checkbox"
                checked={recipe.runOnRestore}
                onChange={(event) => useTerminalRecipesStore.getState().update(ws.path, {
                  ...recipe,
                  runOnRestore: event.target.checked,
                })}
              />
              Run automatically only when this workspace is restored at app launch
            </label>
          </div>
          <button onClick={() => runTerminalRecipe(ws, recipe)}>Run</button>
          <button
            className="icon-btn"
            title="Remove recipe"
            onClick={() => useTerminalRecipesStore.getState().remove(ws.path, recipe.id)}
          >
            <IcClose />
          </button>
        </div>
      ))}
      <div className="settings-recipe-add">
        <input value={name} placeholder="Recipe name" onChange={(event) => setName(event.target.value)} />
        <input value={command} placeholder="Command" onChange={(event) => setCommand(event.target.value)} />
        <button disabled={!name.trim() || !command.trim()} onClick={add}>Add</button>
      </div>
    </>
  );
}

function AgentControlInfo() {
  const [info, setInfo] = useState<{
    socketPath: string;
    tokenPath: string;
    cliPath: string;
    skillPath: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    void agentControlInfo().then(
      (value) => { if (!disposed) setInfo(value); },
      (reason) => { if (!disposed) setError(String(reason)); },
    );
    return () => { disposed = true; };
  }, []);
  if (error) return <p className="settings-hint">Unavailable: {error}</p>;
  if (!info) return <p className="settings-hint">Starting local control socket…</p>;
  return (
    <div className="settings-row">
      <div className="settings-row-main">
        <span className="settings-row-name">Authenticated Unix socket</span>
        <code className="settings-recipe-command">{info.socketPath}</code>
        <span className="settings-row-name">Bundled CLI</span>
        <code className="settings-recipe-command">{info.cliPath}</code>
        <span className="settings-row-name">Bundled skill</span>
        <code className="settings-recipe-command">{info.skillPath}</code>
        <span className="settings-row-status">
          Mode-0600 bearer token: {info.tokenPath}. Use project-scoped, expiring capabilities for repository automation; never inject the global token into a terminal.
        </span>
      </div>
      <button onClick={() => void copyText(info.cliPath)}>Copy CLI path</button>
    </div>
  );
}

/** Claude subscription usage: opt-in toggle. Off by default because fetching
 *  reaches into Claude Code's credential store (a keychain prompt is possible)
 *  and calls Anthropic. */
function ClaudeUsageRow() {
  const enabled = useUsageStore((s) => s.enabled);
  const setEnabled = useUsageStore((s) => s.setEnabled);
  const state = useUsageStore((s) => s.state);
  const stale = useUsageStore((s) => s.stale);

  const status = !enabled
    ? "Off"
    : !state
      ? "Checking…"
      : state.status === "ok"
        ? stale
          ? "Connected — showing last reading (refresh failed)"
          : "Connected"
        : state.status === "unauthenticated"
          ? "No Claude Code login found"
          : state.status === "expired"
            ? "Token expired — run Claude Code to refresh"
            : `Error — ${state.message}`;
  const dot =
    !enabled || !state
      ? "idle"
      : state.status === "ok"
        ? "ok"
        : state.status === "expired"
          ? "idle"
          : "crashed";

  return (
    <div className="settings-row">
      <div className="settings-row-main">
        <span className="settings-row-name">Claude usage meter</span>
        <span
          className="settings-row-status"
          title={state?.status === "error" ? state.message : undefined}
        >
          <span className={`lsp-dot ${dot}`} />
          {status}
        </span>
      </div>
      <button
        className={`settings-toggle ${enabled ? "on" : ""}`}
        role="switch"
        aria-checked={enabled}
        title={`${enabled ? "Disable" : "Enable"} the Claude usage gauge`}
        onClick={() => setEnabled(!enabled)}
      />
    </div>
  );
}

function CodexUsageRow() {
  const enabled = useCodexUsageStore((s) => s.enabled);
  const setEnabled = useCodexUsageStore((s) => s.setEnabled);
  const state = useCodexUsageStore((s) => s.state);
  const stale = useCodexUsageStore((s) => s.stale);

  const status = !enabled
    ? "Off"
    : !state
      ? "Checking…"
      : state.status === "ok"
        ? stale
          ? "Connected — showing last reading (refresh failed)"
          : "Connected"
        : state.status === "unauthenticated"
          ? "No Codex login found"
          : `Error — ${state.message}`;
  const dot =
    !enabled || !state
      ? "idle"
      : state.status === "ok"
        ? "ok"
        : "crashed";

  return (
    <div className="settings-row">
      <div className="settings-row-main">
        <span className="settings-row-name">Codex usage meter</span>
        <span
          className="settings-row-status"
          title={state?.status === "error" ? state.message : undefined}
        >
          <span className={`lsp-dot ${dot}`} />
          {status}
        </span>
      </div>
      <button
        className={`settings-toggle ${enabled ? "on" : ""}`}
        role="switch"
        aria-checked={enabled}
        title={`${enabled ? "Disable" : "Enable"} the Codex usage gauge`}
        onClick={() => setEnabled(!enabled)}
      />
    </div>
  );
}

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  useNativeOverlay();
  const ws = useActiveWorkspace();
  const enabled = useLspSettings();
  const modeOn = useLspMode() === "dynamic";
  useLspStatusVersionValue(); // re-render rows on any server status change
  const panelRef = useRef<HTMLDivElement>(null);

  // The modal owns the keyboard while open (picker rule) — no input to
  // focus, so the panel itself takes focus for key events.
  useEffect(() => panelRef.current?.focus(), []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    // Focus trap: cycle Tab/Shift-Tab within the panel — if focus escaped
    // behind the modal, this handler (Escape + the shortcut shield above)
    // would stop seeing keys. Forward Tab from the panel itself naturally
    // enters the first control, so only the two wrap-around edges need help.
    if (e.key === "Tab") {
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || active === panel) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className="settings-backdrop" onMouseDown={onClose}>
      <div
        ref={panelRef}
        className="settings"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="settings-header">
          <span className="settings-title">Settings</span>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <IcClose />
          </button>
        </div>
        <div className="settings-content">
          <section className="settings-section">
            <h3>Appearance</h3>
            <p className="settings-hint">
              Choose from 22 dark background palettes across neutral, cool,
              warm, earth, and jewel tones. The app, editor, and terminals
              update immediately, and your choice is saved for the next launch.
            </p>
            <AppearanceSettings />
          </section>
          <section className="settings-section">
            <h3>Language Servers</h3>
            <p className="settings-hint">
              Diagnostics, hover info, completions and go-to-definition in the
              editor. Off at every launch — enable below (or via the status-bar
              LSP button) for this session; servers then run per workspace and
              start when a matching file opens.
            </p>
            <div className="settings-row">
              <div className="settings-row-main">
                <span className="settings-row-name">Language services</span>
                <span className="settings-row-status">
                  <span className={`lsp-dot ${modeOn ? "ok" : "idle"}`} />
                  {modeOn ? "On for this session" : "Off — resets every launch"}
                </span>
              </div>
              <button
                className={`settings-toggle ${modeOn ? "on" : ""}`}
                role="switch"
                aria-checked={modeOn}
                title={`${modeOn ? "Disable" : "Enable"} language services for this session`}
                onClick={() => setLspMode(modeOn ? "disabled" : "dynamic")}
              />
            </div>
            {LSP_LANGUAGES.map((l) => (
              <ServerRow
                key={l.id}
                lang={l.id}
                label={l.label}
                installHint={l.installHint}
                ws={ws}
                enabled={enabled[l.id]}
                modeOn={modeOn}
              />
            ))}
          </section>
          <section className="settings-section">
            <h3>Agent Integrations</h3>
            <p className="settings-hint">
              Executable health, version, detection identity, and structured capabilities used by the launch sheet. Claude and Codex remain terminal-native; custom commands select an existing screen profile as fallback detection.
            </p>
            <AgentIntegrations />
          </section>
          <section className="settings-section">
            <h3>Agent Detection Diagnostics</h3>
            <p className="settings-hint">
              Internal explain view for versioned screen profiles and current semantic matches. No terminal text, commands, arguments, environment, or prompts are retained here.
            </p>
            <AgentDetectionDiagnostics />
          </section>
          <section className="settings-section">
            <h3>Workspace Terminal Recipes</h3>
            <p className="settings-hint">
              Local, user-owned commands for {ws?.path ?? "the active project"}. Nothing runs on app restore unless its per-recipe policy is enabled here.
            </p>
            <TerminalRecipes ws={ws} />
          </section>
          <section className="settings-section">
            <h3>Local Agent Control</h3>
            <p className="settings-hint">
              The bundled vibe-agent CLI supports semantic snapshots, ordered events, isolated starts, generation-pinned prompts, focus, waits, cancellation, and short-lived project capabilities.
            </p>
            <AgentControlInfo />
          </section>
          <section className="settings-section">
            <h3>Agent Notifications</h3>
            <p className="settings-hint">
              Alerts for agent terminals with notifications enabled
              (right-click an agent tab in Global Terminals). The sound is played by
              the app itself — Focus modes and notification settings don't
              silence it. Banners need a bundled build and OS permission;
              "Show banners" decides whether they also appear while the app
              is focused.
            </p>
            <AttentionSoundRow />
            <BannerModeRow />
          </section>
          <section className="settings-section">
            <h3>Claude Usage</h3>
            <p className="settings-hint">
              Shows your Claude subscription rate-limit gauges (the 5-hour and
              weekly windows) in the status bar. Reuses the login token Claude
              Code already stored on this machine — read-only, so it never
              affects that login. The first read may prompt for keychain
              access. Off by default.
            </p>
            <ClaudeUsageRow />
          </section>
          <section className="settings-section">
            <h3>Codex Usage</h3>
            <p className="settings-hint">
              Shows Codex's 5-hour and weekly rate-limit gauges in the status
              bar. The installed Codex CLI reads and refreshes its own login;
              this app never accesses the token. Off by default.
            </p>
            <CodexUsageRow />
          </section>
        </div>
      </div>
    </div>
  );
}
