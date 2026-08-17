import { useEffect, useState } from "react";
import { useStore } from "zustand";
import type { CodexUsageLimit, UsageLimit } from "../lib/ipc";
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
import { useActiveEditorStatus } from "../lib/editorStatus";
import { useActiveWorkspace, type Workspace } from "../stores/workspaces";
import { useUiStore } from "../stores/ui";
import {
  selectTerminalRollup,
  useAgentRuntimeStore,
} from "../stores/agentRuntime";
import { initUsagePolling, useUsageStore } from "../stores/usage";
import {
  initCodexUsagePolling,
  useCodexUsageStore,
} from "../stores/codexUsage";
import {
  IcBranch,
  IcClaude,
  IcCodex,
  IcEye,
  IcGear,
  IcSidebar,
  IcTerminal,
} from "./icons";
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

/** Cursor/file-format fundamentals for the active editable buffer. */
function EditorStatusItems({ ws }: { ws: Workspace }) {
  const status = useActiveEditorStatus(ws.editor);
  const wordWrap = useUiStore((s) => s.wordWrap);
  const toggleWordWrap = useUiStore((s) => s.toggleWordWrap);
  if (!status) return null;
  return (
    <>
      <span className="statusbar-item" title="Cursor position">
        Ln {status.line}, Col {status.column}
        {status.selected > 0 ? ` (${status.selected} selected)` : ""}
      </span>
      <span className="statusbar-item" title="Detected indentation">
        {status.indentation}
      </span>
      <span className="statusbar-item" title="Line ending preserved on save">
        {status.lineEnding}
      </span>
      <button
        className={`statusbar-item statusbar-clickable${wordWrap ? " statusbar-md-on" : ""}`}
        title={`${wordWrap ? "Disable" : "Enable"} word wrap`}
        onClick={toggleWordWrap}
      >
        Wrap
      </button>
    </>
  );
}

type UsageTone = "low" | "mid" | "high";
function usageTone(pct: number): UsageTone {
  if (pct >= 80) return "high";
  if (pct >= 50) return "mid";
  return "low";
}

/** "2h 14m" / "3d 5h" until a reset instant, or null when it's absent/past. */
function resetLabel(resetsAt: string | number | null): string | null {
  if (!resetsAt) return null;
  if (typeof resetsAt === "number") {
    const ms = resetsAt * 1000 - Date.now();
    if (ms <= 0) return "now";
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) {
      const rem = mins % 60;
      return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
    }
    const days = Math.floor(hrs / 24);
    const remHrs = hrs % 24;
    return remHrs ? `${days}d ${remHrs}h` : `${days}d`;
  }
  // Anthropic sends microsecond ISO strings; JSC (Safari) only reliably
  // parses millisecond precision — trim extra fractional digits.
  const norm = resetsAt.replace(/(\.\d{3})\d+/, "$1");
  const ms = new Date(norm).getTime() - Date.now();
  if (!isFinite(ms)) return null;
  if (ms <= 0) return "now";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) {
    const rem = mins % 60;
    return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
  }
  const days = Math.floor(hrs / 24);
  const remHrs = hrs % 24;
  return remHrs ? `${days}d ${remHrs}h` : `${days}d`;
}

function UsageRow({
  label,
  limit,
}: {
  label: string;
  limit: UsageLimit | CodexUsageLimit | null;
}) {
  if (!limit) return null;
  const pct = Math.round(limit.utilization);
  const reset = resetLabel(limit.resetsAt);
  return (
    <div className="usage-row">
      <div className="usage-row-head">
        <span className="usage-row-label">{label}</span>
        <span className="usage-row-pct">{pct}%</span>
      </div>
      <div className="usage-bar">
        <div
          className={`usage-bar-fill usage-${usageTone(pct)}`}
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>
      {reset && <div className="usage-row-reset">resets in {reset}</div>}
    </div>
  );
}

/** Codex rate-limit gauge queried through the local Codex CLI. */
function CodexUsageStatusItem() {
  const enabled = useCodexUsageStore((s) => s.enabled);
  const state = useCodexUsageStore((s) => s.state);
  const stale = useCodexUsageStore((s) => s.stale);
  const refresh = useCodexUsageStore((s) => s.refresh);
  const [open, setOpen] = useState(false);

  if (!enabled || !state) return null;
  if (state.status !== "ok") {
    const text =
      state.status === "unauthenticated"
        ? "Codex: sign in"
        : "Codex: usage error";
    const title =
      state.status === "unauthenticated"
        ? "No Codex login found — run codex login"
        : `Codex usage error: ${state.message}`;
    return (
      <button
        className="statusbar-item statusbar-clickable statusbar-usage-muted"
        title={`${title} (click to retry)`}
        onClick={() => void refresh({ force: true })}
      >
        <IcCodex />
        <span className="truncate">{text}</span>
      </button>
    );
  }

  const u = state.usage;
  const segs = [
    u.fiveHour && { label: "5h", pct: Math.round(u.fiveHour.utilization) },
    u.sevenDay && { label: "7d", pct: Math.round(u.sevenDay.utilization) },
  ].filter((s): s is { label: string; pct: number } => Boolean(s));

  return (
    <div className="statusbar-usage-wrap">
      <button
        className={`statusbar-item statusbar-clickable statusbar-usage${stale ? " statusbar-usage-stale" : ""}`}
        title={`Codex usage${stale ? " (last reading — refresh failed)" : ""} — click for details`}
        onClick={() =>
          setOpen((o) => {
            if (!o) void refresh({ force: true });
            return !o;
          })
        }
      >
        <IcCodex />
        <span>Codex</span>
        {segs.map((s) => (
          <span
            key={s.label}
            className={`statusbar-usage-seg usage-${usageTone(s.pct)}`}
          >
            {s.label} {s.pct}%
          </span>
        ))}
        {u.resetCreditExpiries.length > 0 && (
          <span className="statusbar-usage-seg usage-low">
            {u.resetCreditExpiries.length} reset
            {u.resetCreditExpiries.length > 1 ? "s" : ""}
          </span>
        )}
      </button>
      {open && (
        <>
          <div
            className="statusbar-usage-backdrop"
            onClick={() => setOpen(false)}
          />
          <div className="statusbar-usage-popover" role="dialog">
            <div className="statusbar-usage-head">
              <span>
                Codex usage
                {u.planType
                  ? ` · ${u.planType.replaceAll("_", " ")}`
                  : ""}
              </span>
              <button
                className="statusbar-usage-refresh"
                title="Refresh now"
                onClick={() => void refresh({ force: true })}
              >
                Refresh
              </button>
            </div>
            <UsageRow label="5-hour" limit={u.fiveHour} />
            <UsageRow label="Weekly" limit={u.sevenDay} />
            {u.resetCreditExpiries.length > 0 && (
              <div className="usage-row">
                <div className="usage-row-head">
                  <span className="usage-row-label">Reset credits</span>
                  <span className="usage-row-pct">
                    {u.resetCreditExpiries.length}
                  </span>
                </div>
                {u.resetCreditExpiries.map((exp, i) => (
                  <div key={i} className="usage-row-reset">
                    #{i + 1} expires in {resetLabel(exp) ?? "—"}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Live Claude subscription gauge (opt-in via Settings). The chip shows the
    primary 5-hour window; clicking opens a popover with every window. */
function UsageStatusItem() {
  const enabled = useUsageStore((s) => s.enabled);
  const state = useUsageStore((s) => s.state);
  const stale = useUsageStore((s) => s.stale);
  const refresh = useUsageStore((s) => s.refresh);
  const [open, setOpen] = useState(false);

  // Nothing to render until enabled and the first fetch has resolved (avoids
  // a flicker of empty/placeholder chrome on launch).
  if (!enabled || !state) return null;

  if (state.status !== "ok") {
    const text =
      state.status === "unauthenticated"
        ? "Claude: sign in"
        : state.status === "expired"
          ? "Claude: token expired"
          : "Claude: usage error";
    const title =
      state.status === "unauthenticated"
        ? "No Claude Code login found — run Claude Code (claude) to sign in"
        : state.status === "expired"
          ? "Claude Code's access token expired — run Claude Code to refresh it"
          : `Claude usage error: ${state.message}`;
    return (
      <button
        className="statusbar-item statusbar-clickable statusbar-usage-muted"
        title={`${title} (click to retry)`}
        onClick={() => void refresh({ force: true })}
      >
        <IcClaude />
        <span className="truncate">{text}</span>
      </button>
    );
  }

  const u = state.usage;
  // New model buckets (including Fable) arrive in a generic server-supplied
  // array. Keep the legacy Opus/Sonnet fields for older responses and avoid a
  // duplicate row if Anthropic emits a model through both shapes.
  const legacyModelNames = new Set<string>();
  if (u.sevenDayOpus) legacyModelNames.add("opus");
  if (u.sevenDaySonnet) legacyModelNames.add("sonnet");
  const modelScoped = u.modelScoped.filter(
    (limit) => !legacyModelNames.has(limit.displayName.trim().toLowerCase()),
  );
  // The rolling 5-hour and the weekly (all-models) cap go straight in the bar
  // — the two windows that actually gate work — each toned by its own load;
  // the popover keeps the full per-model breakdown.
  const segs: { label: string; pct: number }[] = [];
  const push = (label: string, limit: UsageLimit | null) => {
    if (limit) segs.push({ label, pct: Math.round(limit.utilization) });
  };
  push("5h", u.fiveHour);
  push("7d", u.sevenDay);
  // Degenerate response missing both common windows — show whatever exists.
  if (!segs.length) {
    const fallback = u.sevenDayOpus ?? u.sevenDaySonnet ?? modelScoped[0];
    if (fallback) push("wk", fallback);
  }

  return (
    <div className="statusbar-usage-wrap">
      <button
        className={`statusbar-item statusbar-clickable statusbar-usage${stale ? " statusbar-usage-stale" : ""}`}
        title={
          stale
            ? "Claude subscription usage (last reading — refresh failed) — click for details"
            : "Claude subscription usage — click for details"
        }
        onClick={() =>
          setOpen((o) => {
            // Opening the chip is the on-demand refresh (background polling is
            // intentionally slow); don't re-pull when collapsing it.
            if (!o) void refresh({ force: true });
            return !o;
          })
        }
      >
        <IcClaude />
        <span>Claude</span>
        {segs.map((s) => (
          <span
            key={s.label}
            className={`statusbar-usage-seg usage-${usageTone(s.pct)}`}
          >
            {s.label} {s.pct}%
          </span>
        ))}
      </button>
      {open && (
        <>
          <div
            className="statusbar-usage-backdrop"
            onClick={() => setOpen(false)}
          />
          <div className="statusbar-usage-popover" role="dialog">
            <div className="statusbar-usage-head">
              <span>Claude usage</span>
              <button
                className="statusbar-usage-refresh"
                title="Refresh now"
                onClick={() => void refresh({ force: true })}
              >
                Refresh
              </button>
            </div>
            <UsageRow label="5-hour" limit={u.fiveHour} />
            <UsageRow label="Weekly (all models)" limit={u.sevenDay} />
            <UsageRow label="Weekly Opus" limit={u.sevenDayOpus} />
            <UsageRow label="Weekly Sonnet" limit={u.sevenDaySonnet} />
            {modelScoped.map((limit) => (
              <UsageRow
                key={limit.displayName}
                label={`Weekly ${limit.displayName}`}
                limit={limit}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function StatusBar({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
}) {
  const ws = useActiveWorkspace();
  // Start the background poll once; every tick no-ops while usage is disabled.
  useEffect(() => {
    initUsagePolling();
    initCodexUsagePolling();
  }, []);

  const panelVisible = useUiStore((s) => s.panelVisible);
  const sidebarVisible = useUiStore((s) => s.sidebarVisible);
  const togglePanel = useUiStore((s) => s.togglePanel);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  // A waiting agent terminal has no visible indicator when the panel is
  // hidden and its project's titlebar tab is closed — surface it here.
  const agentActivity = useAgentRuntimeStore((s) => selectTerminalRollup(s));

  return (
    <div className="statusbar">
      {ws && <RepoStatus key={ws.path} ws={ws} />}

      <div className="statusbar-right">
        <CodexUsageStatusItem />
        <UsageStatusItem />
        {ws && <EditorStatusItems ws={ws} />}
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
          {!panelVisible && agentActivity !== null && agentActivity !== "idle" && (
            <span
              className={`statusbar-attention-dot ${agentActivity}`}
              title={
                agentActivity === "blocked"
                  ? "Agent needs input"
                  : agentActivity === "done"
                    ? "Agent finished"
                    : "Agent working"
              }
            />
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
