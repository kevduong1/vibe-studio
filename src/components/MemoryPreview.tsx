/**
 * Editor-area rendering of one agent memory (Tab kind "memory"): a document
 * header — source + type chips, title, description — above the markdown
 * body (lib/markdownDoc, MarkdownPreview's .md-doc typography). Content is
 * the tab's snapshot: the sidebar refetches fresh from disk/sqlite and
 * `openMemory` refreshes an already-open tab in place, so this pane never
 * does its own IPC. Links route through open_url's scheme whitelist.
 */
import { useEffect, useRef } from "react";
import { openUrl } from "../lib/ipc";
import { renderMarkdownDoc } from "../lib/markdownDoc";
import type { Tab } from "../stores/editor";
import { IcClaude, IcCodex } from "./icons";
import "./MarkdownPreview.css";
import "./MemoryPreview.css";

type MemoryTab = Extract<Tab, { kind: "memory" }>;

export default function MemoryPreview({ tab }: { tab: MemoryTab }) {
  const { source, entry } = tab.memory;
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    hostRef.current?.replaceChildren(renderMarkdownDoc(entry.content));
  }, [entry.content]);

  return (
    <div
      className="md-preview memory-preview"
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest("a[data-href]");
        const href = a instanceof HTMLElement ? a.dataset.href : undefined;
        if (href) void openUrl(href);
      }}
    >
      <div className="memory-preview-doc">
        <header className="memory-preview-head">
          <div className="memory-preview-chips">
            <span className="memory-preview-chip source">
              {source === "claude" ? <IcClaude /> : <IcCodex />}
              {source === "claude" ? "Claude" : "Codex"}
            </span>
            {entry.kind && (
              <span className="memory-preview-chip">{entry.kind}</span>
            )}
          </div>
          <h1 className="memory-preview-title">{entry.title}</h1>
          {entry.description && (
            <p className="memory-preview-desc">{entry.description}</p>
          )}
        </header>
        <div ref={hostRef} />
      </div>
    </div>
  );
}
