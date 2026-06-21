import { useStore } from "zustand";
import { getWorkspaceLsp, useLspStatusVersionValue } from "../lib/lsp/servers";
import {
  isLanguageEnabled,
  LSP_LANGUAGES,
  setLspMode,
  STATUS_KIND,
  STATUS_LABEL,
  useLspMode,
} from "../lib/lsp/settings";
import { serverLangForPath } from "../lib/lsp/types";
import { isMarkdownPath } from "../lib/path";
import { useActiveWorkspace, type Workspace } from "../stores/workspaces";
import { useUiStore } from "../stores/ui";
import { useAgentTerminalsStore } from "../stores/agentTerminals";
import { aggregateActivity } from "../stores/terminal";
import { IcBranch, IcEye, IcGear, IcSidebar, IcTerminal } from "./icons";
import "./StatusBar.css";

/** Branch / sync / error readout for the active workspace. */
function RepoStatus({ ws }: { ws: Workspace }) {
  const status = useStore(ws.repo, (s) => s.status);
  const syncing = useStore(ws.repo, (s) => s.syncing);
  const error = useStore(ws.repo, (s) => s.error);

  const branch = status?.branch ?? null;

  return (
    <>
      {branch && (
        <button
          className="statusbar-item statusbar-clickable"
          title="Refresh repository status"
          onClick={() => void ws.repo.getState().refresh()}
        >
          <IcBranch />
          <span className="truncate statusbar-branch-name">{branch.name}</span>
        </button>
      )}
      {branch && (branch.ahead > 0 || branch.behind > 0) && (
        <span className="statusbar-item">
          {branch.ahead > 0 && <span>&#8593;{branch.ahead}</span>}
          {branch.behind > 0 && <span>&#8595;{branch.behind}</span>}
        </span>
      )}
      {syncing && (
        <span className="statusbar-item">
          <span className="statusbar-spinner" />
          Syncing
        </span>
      )}
      {error && (
        <button
          className="statusbar-item statusbar-clickable statusbar-error"
          title="Click to dismiss"
          onClick={() => ws.repo.getState().clearError()}
        >
          <span className="truncate">{error}</span>
        </button>
      )}
    </>
  );
}

/** One-click session LSP switch (mode resets to off every launch), doubling
    as the language-server state for the active editor tab's file — the only
    place "binary missing" / "crashed" is visible without opening settings
    (which stay one gear-click away). */
function LspStatusItem({ ws }: { ws: Workspace }) {
  useLspStatusVersionValue();
  const modeOn = useLspMode() === "dynamic";
  const filePath = useStore(ws.editor, (s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return tab?.kind === "file" ? tab.path : null;
  });
  const lang = filePath ? serverLangForPath(filePath) : null;
  // isLanguageEnabled folds in the mode; null info = nothing serves this file.
  const info = lang && isLanguageEnabled(lang) ? getWorkspaceLsp(ws.path).serverInfo(lang) : null;
  const label = lang ? (LSP_LANGUAGES.find((l) => l.id === lang)?.label ?? lang) : null;
  const title = !modeOn
    ? "Language services off — click to enable for this session"
    : info
      ? `${label}: ${STATUS_LABEL[info.status]}${info.error ? ` — ${info.error}` : ""} (click to disable)`
      : "Language services on for this session — click to disable";
  return (
    <button
      className={`statusbar-item statusbar-clickable${modeOn ? "" : " statusbar-lsp-off"}`}
      title={title}
      onClick={() => setLspMode(modeOn ? "disabled" : "dynamic")}
    >
      <span className={`lsp-dot ${info ? STATUS_KIND[info.status] : "idle"}`} />
      LSP
    </button>
  );
}

/** Markdown preview switch — appears only while the active tab is a .md
    file; EditorArea swaps the editor for the rendered view while it's on. */
function MarkdownPreviewItem({ ws }: { ws: Workspace }) {
  const on = useUiStore((s) => s.markdownPreview);
  const toggle = useUiStore((s) => s.toggleMarkdownPreview);
  const isMd = useStore(ws.editor, (s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return tab?.kind === "file" && isMarkdownPath(tab.path);
  });
  if (!isMd) return null;
  return (
    <button
      className={`statusbar-item statusbar-clickable${on ? " statusbar-md-on" : ""}`}
      title={
        on
          ? "Showing rendered markdown — click to edit the source"
          : "Show rendered markdown"
      }
      onClick={toggle}
    >
      <IcEye />
      Preview
    </button>
  );
}

export default function StatusBar({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
}) {
  const ws = useActiveWorkspace();

  const panelVisible = useUiStore((s) => s.panelVisible);
  const sidebarVisible = useUiStore((s) => s.sidebarVisible);
  const togglePanel = useUiStore((s) => s.togglePanel);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  // A waiting agent terminal has no visible indicator when the panel is
  // hidden and its project's titlebar tab is closed — surface it here.
  const agentAttention = useAgentTerminalsStore(
    (s) => aggregateActivity(s.paneActivity) === "attention",
  );

  return (
    <div className="statusbar">
      {ws && <RepoStatus key={ws.path} ws={ws} />}

      <div className="statusbar-right">
        {ws && <MarkdownPreviewItem ws={ws} />}
        {ws && <LspStatusItem ws={ws} />}
        {ws && (
          <span className="truncate statusbar-path" title={ws.path}>
            {ws.path}
          </span>
        )}
        <span className="statusbar-divider" />
        <button
          className="icon-btn statusbar-toggle"
          title="Settings (⌘,)"
          onClick={onOpenSettings}
        >
          <IcGear />
        </button>
        <button
          className={`icon-btn statusbar-toggle ${panelVisible ? "active" : ""}`}
          title="Toggle panel"
          onClick={togglePanel}
        >
          <IcTerminal />
          {!panelVisible && agentAttention && (
            <span className="statusbar-attention-dot" />
          )}
        </button>
        <button
          className={`icon-btn statusbar-toggle ${sidebarVisible ? "active" : ""}`}
          title="Toggle sidebar"
          onClick={toggleSidebar}
        >
          <IcSidebar />
        </button>
      </div>
    </div>
  );
}
