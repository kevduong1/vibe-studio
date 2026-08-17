/**
 * ⌘⇧F workspace text search, as a sidebar view. All state lives in the
 * per-workspace search store (stores/search.ts) — the sidebar unmounts this
 * component on tab switches, so it is pure presentation plus focus glue.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import type { SearchMatch } from "../lib/ipc";
import { basename, dirname } from "../lib/path";
import type { SearchToggle } from "../stores/search";
import { useUiStore } from "../stores/ui";
import {
  useSearch,
  useWorkspace,
  useWorkspacesStore,
} from "../stores/workspaces";
import {
  IcCaseSensitive,
  IcChevronRight,
  IcRegex,
  IcWholeWord,
} from "./icons";
import "./SearchPanel.css";

function ToggleBtn({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean;
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={`search-toggle ${active ? "active" : ""}`}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export default function SearchPanel() {
  const ws = useWorkspace();
  const query = useSearch((s) => s.query);
  const setQuery = useSearch((s) => s.setQuery);
  const toggle = useSearch((s) => s.toggle);
  const toggleCollapsed = useSearch((s) => s.toggleCollapsed);
  const opts = useSearch(
    useShallow((s) => ({
      caseSensitive: s.caseSensitive,
      wholeWord: s.wholeWord,
      useRegex: s.useRegex,
    })),
  );
  const out = useSearch(
    useShallow((s) => ({
      results: s.results,
      totalMatches: s.totalMatches,
      truncated: s.truncated,
      searching: s.searching,
      error: s.error,
      collapsed: s.collapsed,
    })),
  );

  // ⌘⇧F focus: each nonce bump focuses the ACTIVE workspace's input. This
  // panel also renders (hidden) in inactive workspace trees — those mark
  // the nonce as seen WITHOUT grabbing focus, so switching back to their
  // workspace later doesn't steal it.
  const inputRef = useRef<HTMLInputElement>(null);
  const focusNonce = useUiStore((s) => s.searchFocusNonce);
  const isActive = useWorkspacesStore((s) => s.activePath === ws.path);
  const seenNonce = useRef(0);
  useEffect(() => {
    if (focusNonce === seenNonce.current) return;
    seenNonce.current = focusNonce;
    if (isActive) inputRef.current?.select();
  }, [focusNonce, isActive]);

  const openMatch = (file: string, m: SearchMatch) => {
    // Backend paths are repo-relative; the editor wants absolute.
    ws.editor.getState().previewFile(`${ws.path}/${file}`, {
      line: m.lineNumber,
      column: m.column,
    });
  };

  const mkToggle = (k: SearchToggle) => () => toggle(k);

  return (
    <div className="search-panel">
      <div className="search-header">
        <span className="search-title">Search</span>
      </div>
      <div className="search-input-row">
        <input
          ref={inputRef}
          className="text-input search-input"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="search-toggles">
          <ToggleBtn
            active={opts.caseSensitive}
            title="Match Case"
            onClick={mkToggle("caseSensitive")}
          >
            <IcCaseSensitive />
          </ToggleBtn>
          <ToggleBtn
            active={opts.wholeWord}
            title="Match Whole Word"
            onClick={mkToggle("wholeWord")}
          >
            <IcWholeWord />
          </ToggleBtn>
          <ToggleBtn
            active={opts.useRegex}
            title="Use Regular Expression"
            onClick={mkToggle("useRegex")}
          >
            <IcRegex />
          </ToggleBtn>
        </div>
      </div>
      {out.error && <div className="search-error">{out.error}</div>}
      {!out.error && query && !out.searching && (
        <div className="search-summary">
          {out.totalMatches === 0
            ? "No results"
            : `${out.totalMatches} result${out.totalMatches === 1 ? "" : "s"} in ${out.results.length} file${out.results.length === 1 ? "" : "s"}`}
          {out.truncated && " (capped — refine your search)"}
        </div>
      )}
      <div className="search-results">
        {out.results.map((f) => {
          const dir = dirname(f.file);
          const isCollapsed = !!out.collapsed[f.file];
          return (
            <div key={f.file} className="search-file">
              <button
                className="search-file-header"
                onClick={() => toggleCollapsed(f.file)}
              >
                <span className={`search-chevron ${isCollapsed ? "" : "open"}`}>
                  <IcChevronRight />
                </span>
                <span className="search-file-name truncate">
                  {basename(f.file)}
                </span>
                {dir && <span className="search-file-dir truncate">{dir}</span>}
                <span className="search-count">{f.matches.length}</span>
              </button>
              {!isCollapsed &&
                f.matches.map((m) => (
                  <button
                    key={`${m.lineNumber}:${m.column}`}
                    className="search-match"
                    title={`${f.file}:${m.lineNumber}`}
                    onClick={() => openMatch(f.file, m)}
                  >
                    <span className="search-match-text">
                      {m.text.slice(0, m.start)}
                      <span className="search-match-hl">
                        {m.text.slice(m.start, m.end)}
                      </span>
                      {m.text.slice(m.end)}
                    </span>
                  </button>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
