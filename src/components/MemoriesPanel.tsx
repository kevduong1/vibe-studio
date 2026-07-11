/**
 * Project-memories sidebar view (ActivityBar brain icon): the active
 * project's agent memories, one section per agent — Claude Code and Codex
 * (memories.rs). Fetched on mount (the sidebar remounts this on every tab
 * switch, so it's always fresh) and via the header's refresh button. A card
 * expands inline to its rendered markdown (lib/markdownDoc — the sanctioned
 * safe renderer); the hover action (or double-click) promotes it to a
 * MemoryPreview tab in the editor area (editor store `openMemory`).
 * data-href link clicks route through open_url's scheme whitelist.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  memoriesList,
  openUrl,
  type MemoryEntry,
  type ProjectMemories,
} from "../lib/ipc";
import { renderMarkdownDoc } from "../lib/markdownDoc";
import type { MemorySource } from "../stores/editor";
import { useWorkspace } from "../stores/workspaces";
import {
  IcChevronRight,
  IcClaude,
  IcCodex,
  IcFile,
  IcRefresh,
  IcSpinner,
} from "./icons";
import "./MemoriesPanel.css";

/** Mounts the detached markdown DOM; replaceChildren keeps scroll position. */
function MemoryBody({ content }: { content: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.replaceChildren(renderMarkdownDoc(content));
  }, [content]);
  return <div className="memory-card-body" ref={ref} />;
}

function MemoryCard({
  source,
  entry,
}: {
  source: MemorySource;
  entry: MemoryEntry;
}) {
  const ws = useWorkspace();
  const [open, setOpen] = useState(false);
  const openTab = () => ws.editor.getState().openMemory(source, entry);

  return (
    <div className={`memory-card ${open ? "open" : ""}`}>
      <div
        className="memory-card-head"
        role="button"
        onClick={() => setOpen((o) => !o)}
        onDoubleClick={openTab}
      >
        <IcChevronRight className="memory-card-chevron" />
        <div className="memory-card-main">
          <div className="memory-card-title">
            <span className="truncate">{entry.title}</span>
            {entry.kind && <span className="memory-chip">{entry.kind}</span>}
          </div>
          {entry.description && (
            <div className="memory-card-desc truncate">{entry.description}</div>
          )}
        </div>
        <button
          className="icon-btn memory-card-open"
          title="Open in Editor"
          onClick={(e) => {
            e.stopPropagation();
            openTab();
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <IcFile />
        </button>
      </div>
      {open && <MemoryBody content={entry.content} />}
    </div>
  );
}

function MemorySection({
  icon,
  title,
  source,
  entries,
}: {
  icon: ReactNode;
  title: string;
  source: MemorySource;
  entries: MemoryEntry[];
}) {
  return (
    <div className="memories-section">
      <div className="memories-section-head">
        {icon}
        <span>{title}</span>
        <span className="memories-count">{entries.length}</span>
      </div>
      {entries.length === 0 ? (
        <div className="memories-empty">No memories for this project</div>
      ) : (
        entries.map((m) => <MemoryCard key={m.id} source={source} entry={m} />)
      )}
    </div>
  );
}

export default function MemoriesPanel() {
  const ws = useWorkspace();
  const [data, setData] = useState<ProjectMemories | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Refresh sequence: a stale response (older click, or one landing after
  // unmount) must never clobber the newest one. (search.ts pattern.)
  const seq = useRef(0);

  const refresh = useCallback(() => {
    const n = ++seq.current;
    setLoading(true);
    setError(null);
    memoriesList(ws.path)
      .then((d) => {
        if (seq.current === n) setData(d);
      })
      .catch((e) => {
        if (seq.current === n) setError(String(e));
      })
      .finally(() => {
        if (seq.current === n) setLoading(false);
      });
  }, [ws.path]);

  useEffect(() => {
    refresh();
    return () => {
      seq.current++;
    };
  }, [refresh]);

  return (
    <div className="memories-panel">
      <div className="memories-panel-head">
        <span className="memories-panel-title">Memories</span>
        <button
          className="icon-btn"
          title="Refresh Memories"
          onClick={refresh}
          disabled={loading}
        >
          {loading ? <IcSpinner className="activity-busy" /> : <IcRefresh />}
        </button>
      </div>
      <div
        className="memories-scroll"
        onClick={(e) => {
          const a = (e.target as HTMLElement).closest("a[data-href]");
          const href = a instanceof HTMLElement ? a.dataset.href : undefined;
          if (href) void openUrl(href);
        }}
      >
        {error ? (
          <div className="memories-empty">{error}</div>
        ) : data ? (
          <>
            <MemorySection
              icon={<IcClaude className="memories-section-icon" />}
              title="Claude"
              source="claude"
              entries={data.claude}
            />
            <MemorySection
              icon={<IcCodex className="memories-section-icon" />}
              title="Codex"
              source="codex"
              entries={data.codex}
            />
          </>
        ) : (
          <div className="memories-empty">Loading…</div>
        )}
      </div>
    </div>
  );
}
