/**
 * ⌘, settings: centered modal overlay (QuickOpen/TaskPicker shell — backdrop
 * click-catcher, owns the keyboard while open). A category sidebar keeps the
 * large set of controls focused without turning the modal into one long page.
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
  agentDefinitionDetectionConflict,
  allAgentDefinitions,
  useAgentDefinitionsStore,
  type AgentDefinition,
} from "../stores/agentDefinitions";
import { useAgentRuntimeStore } from "../stores/agentRuntime";
import { useUiStore } from "../stores/ui";
import {
  runTerminalRecipe,
  useTerminalRecipesStore,
} from "../stores/terminalRecipes";
import {
  IcBell,
  IcBrain,
  IcClose,
  IcFile,
  IcGear,
  IcPlay,
  IcRefresh,
  IcRows,
  IcSparkle,
  IcTerminal,
} from "./icons";
import "./SettingsModal.css";

const SETTINGS_PAGES = [
  { id: "editor", label: "Editor", icon: IcFile },
  { id: "languages", label: "Language Services", icon: IcSparkle },
  { id: "agents", label: "Agents", icon: IcBrain },
  { id: "terminal", label: "Terminal", icon: IcTerminal },
  { id: "notifications", label: "Notifications", icon: IcBell },
  { id: "usage", label: "Usage", icon: IcRows },
  { id: "advanced", label: "Advanced", icon: IcGear },
] as const;

type SettingsPageId = (typeof SETTINGS_PAGES)[number]["id"];

function SettingsPane({
  id,
  title,
  description,
  children,
}: {
  id: SettingsPageId;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="settings-pane"
      id={`settings-pane-${id}`}
      role="tabpanel"
      aria-labelledby={`settings-nav-${id}`}
    >
      <header className="settings-pane-header">
        <h2>{title}</h2>
        <p>{description}</p>
      </header>
      {children}
    </div>
  );
}

function EditorSettings() {
  const wordWrap = useUiStore((state) => state.wordWrap);
  const autoSave = useUiStore((state) => state.autoSave);
  const toggleWordWrap = useUiStore((state) => state.toggleWordWrap);
  const toggleAutoSave = useUiStore((state) => state.toggleAutoSave);
  return (
    <>
      <div className="settings-row">
        <div className="settings-row-main">
          <span className="settings-row-name">Word wrap</span>
          <span className="settings-row-status">Soft-wrap long lines</span>
        </div>
        <button
          className={`settings-toggle ${wordWrap ? "on" : ""}`}
          role="switch"
          aria-checked={wordWrap}
          onClick={toggleWordWrap}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-main">
          <span className="settings-row-name">Auto Save</span>
          <span className="settings-row-status">After one second without typing</span>
        </div>
        <button
          className={`settings-toggle ${autoSave ? "on" : ""}`}
          role="switch"
          aria-checked={autoSave}
          onClick={toggleAutoSave}
        />
      </div>
    </>
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
  const detectionConflict = agentDefinitionDetectionConflict(definition);
  const probe = (refresh: boolean) => {
    const sequence = ++probeSequence.current;
    if (detectionConflict) {
      setStatus(`Detection conflict — ${detectionConflict}`);
      return;
    }
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
  }, [definition.executable, detectionConflict]); // eslint-disable-line react-hooks/exhaustive-deps
  const capabilities = Object.entries(definition.capabilities)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .join(", ");
  return (
    <div className="settings-row">
      <div className="settings-row-main">
        <span className="settings-row-name">{definition.name}</span>
        <span className="settings-row-status">
          <span className={`lsp-dot ${status.startsWith("Unavailable") || status.startsWith("Probe failed") || status.startsWith("Detection conflict") ? "crashed" : status === "Checking…" ? "idle" : "ok"}`} />
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
  const pendingDefinition: AgentDefinition = {
    id: "custom.pending",
    name: name.trim(),
    executable: executable.trim(),
    defaultArguments: [],
    transport: "terminal",
    detectionProfile: profile,
    resumeSupport: "none",
    capabilities: { models: true, reasoning: profile === "codex", permissions: true, sandbox: profile === "codex", subagents: true },
    builtin: false,
  };
  const pendingConflict = executable.trim()
    ? agentDefinitionDetectionConflict(pendingDefinition, [...definitions, pendingDefinition])
    : null;
  const add = () => {
    if (!name.trim() || !executable.trim() || pendingConflict) return;
    const id = `custom.${crypto.randomUUID()}`;
    useAgentDefinitionsStore.getState().upsertDefinition({
      ...pendingDefinition,
      id,
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
        <button disabled={!name.trim() || !executable.trim() || Boolean(pendingConflict)} onClick={add}>Add</button>
      </div>
      {pendingConflict && <p className="settings-hint">{pendingConflict}</p>}
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
              {runtime.requestedKind && runtime.requestedKind !== runtime.kind
                ? `detected ${runtime.kind} · ${runtime.requestedKind} tab default`
                : runtime.requestedKind
                  ? `${runtime.kind} dedicated`
                  : `${runtime.kind} discovered`} · {runtime.terminalId.slice(0, 8)} · generation {runtime.generation}
            </span>
            <span className="settings-row-status">
              {runtime.occupancy} / {runtime.lifecycle} · pid {runtime.occupantPid ?? "none"} · authority {runtime.authority ?? "none"} · rule {runtime.matchedRule ?? "none"} · background {runtime.background?.summary ?? "none"}
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
  const [activePage, setActivePage] = useState<SettingsPageId>("editor");

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

  const selectPage = (page: SettingsPageId, focus = false) => {
    setActivePage(page);
    if (focus) {
      requestAnimationFrame(() => {
        document.getElementById(`settings-nav-${page}`)?.focus();
      });
    }
  };

  const onNavKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = (index + 1) % SETTINGS_PAGES.length;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIndex = (index - 1 + SETTINGS_PAGES.length) % SETTINGS_PAGES.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = SETTINGS_PAGES.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    selectPage(SETTINGS_PAGES[nextIndex].id, true);
  };

  const page = (() => {
    switch (activePage) {
      case "editor":
        return (
          <SettingsPane
            id="editor"
            title="Editor"
            description="Choose how files behave while you work. These preferences are saved across launches."
          >
            <EditorSettings />
          </SettingsPane>
        );
      case "languages":
        return (
          <SettingsPane
            id="languages"
            title="Language Services"
            description="Enable diagnostics, hover information, completions, and go-to-definition for this session."
          >
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
            {LSP_LANGUAGES.map((language) => (
              <ServerRow
                key={language.id}
                lang={language.id}
                label={language.label}
                installHint={language.installHint}
                ws={ws}
                enabled={enabled[language.id]}
                modeOn={modeOn}
              />
            ))}
          </SettingsPane>
        );
      case "agents":
        return (
          <SettingsPane
            id="agents"
            title="Agents"
            description="Check installed coding agents and add terminal-native integrations."
          >
            <AgentIntegrations />
          </SettingsPane>
        );
      case "terminal":
        return (
          <SettingsPane
            id="terminal"
            title="Terminal"
            description={`Save commands for ${ws?.path ?? "the active project"}. Recipes only run when you choose Run.`}
          >
            <TerminalRecipes ws={ws} />
          </SettingsPane>
        );
      case "notifications":
        return (
          <SettingsPane
            id="notifications"
            title="Notifications"
            description="Choose how enabled agent terminals alert you when work finishes or needs input."
          >
            <AttentionSoundRow />
            <BannerModeRow />
            <p className="settings-note">
              Sounds play directly from Talos. Banners require notification
              permission in a bundled build.
            </p>
          </SettingsPane>
        );
      case "usage":
        return (
          <SettingsPane
            id="usage"
            title="Usage"
            description="Show optional subscription rate-limit gauges in the status bar."
          >
            <section className="settings-group">
              <h3>Claude</h3>
              <p className="settings-hint">
                Uses the existing Claude Code login read-only. The first check
                may prompt for keychain access.
              </p>
              <ClaudeUsageRow />
            </section>
            <section className="settings-group">
              <h3>Codex</h3>
              <p className="settings-hint">
                The installed Codex CLI reads and refreshes its own login;
                Talos never accesses the token.
              </p>
              <CodexUsageRow />
            </section>
          </SettingsPane>
        );
      case "advanced":
        return (
          <SettingsPane
            id="advanced"
            title="Advanced"
            description="Inspect agent detection and local automation details."
          >
            <section className="settings-group">
              <h3>Agent detection</h3>
              <p className="settings-hint">
                Versioned screen profiles and current semantic matches. Talos
                does not retain terminal text, arguments, environment, or prompts here.
              </p>
              <AgentDetectionDiagnostics />
            </section>
            <section className="settings-group">
              <h3>Local agent control</h3>
              <p className="settings-hint">
                Authenticated paths for the bundled control CLI and agent skill.
              </p>
              <AgentControlInfo />
            </section>
          </SettingsPane>
        );
    }
  })();

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
          <button className="icon-btn" title="Close settings" onClick={onClose}>
            <IcClose />
          </button>
        </div>
        <div className="settings-body">
          <nav
            className="settings-nav"
            aria-label="Settings categories"
            role="tablist"
            aria-orientation="vertical"
          >
            {SETTINGS_PAGES.map((item, index) => {
              const Icon = item.icon;
              const selected = item.id === activePage;
              return (
                <button
                  key={item.id}
                  id={`settings-nav-${item.id}`}
                  className={`settings-nav-item${selected ? " active" : ""}`}
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`settings-pane-${item.id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => selectPage(item.id)}
                  onKeyDown={(event) => onNavKeyDown(event, index)}
                >
                  <Icon />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
          <div className="settings-content">
            {page}
          </div>
        </div>
      </div>
    </div>
  );
}
