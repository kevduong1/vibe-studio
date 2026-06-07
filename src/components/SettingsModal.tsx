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
import { IcClose, IcPlay, IcRefresh } from "./icons";
import "./SettingsModal.css";

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

export default function SettingsModal({ onClose }: { onClose: () => void }) {
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
            <h3>Agent Notifications</h3>
            <p className="settings-hint">
              Alerts for agent terminals with notifications enabled
              (right-click a tab in the agent dock). The sound is played by
              the app itself — Focus modes and notification settings don't
              silence it. Banners need a bundled build and OS permission;
              "Show banners" decides whether they also appear while the app
              is focused.
            </p>
            <AttentionSoundRow />
            <BannerModeRow />
          </section>
        </div>
      </div>
    </div>
  );
}
