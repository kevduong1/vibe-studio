/**
 * Explorer-integrated workspace search. "Files" fuzzy-matches the same
 * gitignore-aware path index as Quick Open; "Content" uses the parallel Rust
 * search with case/word/regex options from the per-workspace search store.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { fuzzyMatch } from "../lib/fuzzy";
import {
  listWorkspaceFiles,
  type SearchMatch,
} from "../lib/ipc";
import { basename, dirname } from "../lib/path";
import type { SearchMode, SearchToggle } from "../stores/search";
import { useUiStore } from "../stores/ui";
import {
  useSearch,
  useWorkspace,
  useWorkspacesStore,
} from "../stores/workspaces";
import {
  IcCaseSensitive,
  IcChevronRight,
  IcClose,
  IcRegex,
  IcSearch,
  IcWholeWord,
} from "./icons";
import "./SearchPanel.css";

const MAX_FILE_RESULTS = 200;
/** Survives Explorer unmounts when the user visits another activity view. */
const seenFocusNonces = new Map<string, number>();

interface IndexedFile {
  path: string;
  lower: string;
}

interface FileMatch {
  path: string;
  positions: number[];
  score: number;
}

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
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Wrap consecutive fuzzy-match runs without creating one span per letter. */
function highlighted(text: string, positions: number[]): ReactNode {
  if (positions.length === 0) return text;
  const out: ReactNode[] = [];
  let previous = 0;
  for (let i = 0; i < positions.length; ) {
    const start = positions[i];
    let end = start + 1;
    for (i++; i < positions.length && positions[i] === end; i++) end++;
    if (start > previous) out.push(text.slice(previous, start));
    out.push(
      <span key={start} className="search-match-hl">
        {text.slice(start, end)}
      </span>,
    );
    previous = end;
  }
  if (previous < text.length) out.push(text.slice(previous));
  return out;
}

function ScopeButton({
  mode,
  current,
  onSelect,
  children,
}: {
  mode: SearchMode;
  current: SearchMode;
  onSelect: (mode: SearchMode) => void;
  children: ReactNode;
}) {
  const selected = mode === current;
  return (
    <button
      className={`search-scope ${selected ? "active" : ""}`}
      role="tab"
      aria-selected={selected}
      onClick={() => onSelect(mode)}
    >
      {children}
    </button>
  );
}

export default function SearchPanel() {
  const ws = useWorkspace();
  const mode = useSearch((s) => s.mode);
  const query = useSearch((s) => s.query);
  const setMode = useSearch((s) => s.setMode);
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

  const [files, setFiles] = useState<IndexedFile[] | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesTruncated, setFilesTruncated] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const fileRequest = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusNonce = useUiStore((s) => s.searchFocusNonce);
  const focusPath = useUiStore((s) => s.searchFocusPath);
  const isActive = useWorkspacesStore((s) => s.activePath === ws.path);
  const active = query.length > 0;

  const loadFiles = useCallback(() => {
    const request = ++fileRequest.current;
    setFilesLoading(true);
    setFilesError(null);
    void listWorkspaceFiles(ws.path).then(
      (result) => {
        if (request !== fileRequest.current) return;
        setFiles(
          result.files.map((path) => ({ path, lower: path.toLowerCase() })),
        );
        setFilesTruncated(result.truncated);
        setFilesLoading(false);
      },
      (error) => {
        if (request !== fileRequest.current) return;
        setFilesError(String(error));
        setFilesLoading(false);
      },
    );
  }, [ws.path]);

  // Build the filename index only when it is needed. Returning focus to an
  // existing index refreshes it so newly created files appear without making
  // every worktree watcher event trigger a 50k walk.
  useEffect(() => {
    if (mode === "files" && isActive && active) loadFiles();
    return () => {
      fileRequest.current++;
    };
  }, [mode, isActive, active, loadFiles]);

  // ⌘⇧F opens the targeted workspace's Explorer in Content mode and
  // focuses this shared field. The module map prevents stale refocus after an
  // unrelated activity-view round trip remounts Explorer.
  useEffect(() => {
    if (focusPath !== ws.path) return;
    if (focusNonce === (seenFocusNonces.get(ws.path) ?? 0)) return;
    seenFocusNonces.set(ws.path, focusNonce);
    if (!isActive) return;
    setMode("content");
    inputRef.current?.select();
  }, [focusNonce, focusPath, isActive, setMode, ws.path]);

  const fileMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !files) return { shown: [] as FileMatch[], total: 0 };
    const matches: FileMatch[] = [];
    for (const file of files) {
      const match = fuzzyMatch(q, file.path, file.lower);
      if (match) matches.push({ path: file.path, ...match });
    }
    matches.sort(
      (a, b) =>
        b.score - a.score ||
        a.path.length - b.path.length ||
        (a.path < b.path ? -1 : 1),
    );
    return {
      shown: matches.slice(0, MAX_FILE_RESULTS),
      total: matches.length,
    };
  }, [files, query]);

  const openFile = (path: string) => {
    ws.editor.getState().previewFile(`${ws.path}/${path}`);
  };

  const openContentMatch = (file: string, match: SearchMatch) => {
    ws.editor.getState().previewFile(`${ws.path}/${file}`, {
      line: match.lineNumber,
      column: match.column,
    });
  };

  const mkToggle = (key: SearchToggle) => () => toggle(key);
  return (
    <div className={`search-panel ${active ? "active" : ""}`}>
      <div className="search-input-row">
        <span className="search-input-icon" aria-hidden="true">
          <IcSearch />
        </span>
        <input
          ref={inputRef}
          className="text-input search-input"
          aria-label={mode === "files" ? "Search file names" : "Search file contents"}
          placeholder={mode === "files" ? "Search file names…" : "Search contents…"}
          value={query}
          spellCheck={false}
          onFocus={() => {
            if (mode === "files" && (files !== null || filesError)) loadFiles();
          }}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.stopPropagation();
              setQuery("");
            }
          }}
        />
        {query && (
          <button
            className="search-clear"
            title="Clear search"
            aria-label="Clear search"
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
          >
            <IcClose />
          </button>
        )}
      </div>

      <div className="search-toolbar">
        <div className="search-scopes" role="tablist" aria-label="Search mode">
          <ScopeButton mode="files" current={mode} onSelect={setMode}>
            File names
          </ScopeButton>
          <ScopeButton mode="content" current={mode} onSelect={setMode}>
            Content
          </ScopeButton>
        </div>
        {mode === "content" && (
          <div className="search-toggles" aria-label="Content search options">
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
        )}
      </div>

      {active && mode === "files" && (
        <>
          {filesError && <div className="search-error">{filesError}</div>}
          {!filesError && (
            <div className="search-summary">
              {files === null
                ? "Indexing files…"
                : fileMatches.total === 0
                  ? "No matching files"
                  : `${fileMatches.total} matching file${fileMatches.total === 1 ? "" : "s"}`}
              {(filesTruncated || fileMatches.total > MAX_FILE_RESULTS) &&
                " (showing the best matches)"}
            </div>
          )}
          <div
            className="search-results search-file-results"
            aria-busy={filesLoading}
          >
            {fileMatches.shown.map((file) => {
              const base = basename(file.path);
              const baseStart = file.path.length - base.length;
              const dir = baseStart > 0 ? file.path.slice(0, baseStart - 1) : "";
              const basePositions: number[] = [];
              const dirPositions: number[] = [];
              for (const position of file.positions) {
                if (position >= baseStart) basePositions.push(position - baseStart);
                else if (position < dir.length) dirPositions.push(position);
              }
              return (
                <button
                  key={file.path}
                  className="search-name-match"
                  title={file.path}
                  onClick={() => openFile(file.path)}
                >
                  <span className="search-file-name truncate">
                    {highlighted(base, basePositions)}
                  </span>
                  {dir && (
                    <span className="search-file-dir truncate">
                      {highlighted(dir, dirPositions)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}

      {active && mode === "content" && (
        <>
          {out.error && <div className="search-error">{out.error}</div>}
          {!out.error && (
            <div className="search-summary">
              {out.searching
                ? "Searching contents…"
                : out.totalMatches === 0
                  ? "No results"
                  : `${out.totalMatches} result${out.totalMatches === 1 ? "" : "s"} in ${out.results.length} file${out.results.length === 1 ? "" : "s"}`}
              {out.truncated && " (capped — refine your search)"}
            </div>
          )}
          <div className="search-results" aria-busy={out.searching}>
            {out.results.map((file) => {
              const dir = dirname(file.file);
              const collapsed = !!out.collapsed[file.file];
              return (
                <div key={file.file} className="search-file">
                  <button
                    className="search-file-header"
                    onClick={() => toggleCollapsed(file.file)}
                  >
                    <span className={`search-chevron ${collapsed ? "" : "open"}`}>
                      <IcChevronRight />
                    </span>
                    <span className="search-file-name truncate">
                      {basename(file.file)}
                    </span>
                    {dir && <span className="search-file-dir truncate">{dir}</span>}
                    <span className="search-count">{file.matches.length}</span>
                  </button>
                  {!collapsed &&
                    file.matches.map((match) => (
                      <button
                        key={`${match.lineNumber}:${match.column}`}
                        className="search-match"
                        title={`${file.file}:${match.lineNumber}`}
                        onClick={() => openContentMatch(file.file, match)}
                      >
                        <span className="search-match-line">{match.lineNumber}</span>
                        <span className="search-match-text">
                          {match.text.slice(0, match.start)}
                          <span className="search-match-hl">
                            {match.text.slice(match.start, match.end)}
                          </span>
                          {match.text.slice(match.end)}
                        </span>
                      </button>
                    ))}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
