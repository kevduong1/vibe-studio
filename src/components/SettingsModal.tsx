/**
 * ⌘, settings: centered modal overlay (QuickOpen/TaskPicker shell — backdrop
 * click-catcher, owns the keyboard while open). Sections are plain blocks so
 * future non-LSP settings can be appended.
 *
 * The Language Servers section shows live per-server status for the ACTIVE
 * workspace (servers are per workspace × language); with no workspace open
 * only the persistent enable toggles render.
 */
import { useEffect, useRef } from "react";
import { copyText } from "../lib/clipboard";
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
import { IcClose, IcRefresh } from "./icons";
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
          className="icon-btn settings-restart"
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
        </div>
      </div>
    </div>
  );
}
