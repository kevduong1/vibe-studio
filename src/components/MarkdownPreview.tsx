/**
 * Rendered markdown view of a file tab — EditorArea swaps it in for the
 * editor while the status-bar Preview badge is on. Content comes from the
 * tab's unsaved draft when one exists (peekDraft), else from disk, and
 * re-renders on external repo changes (same listener discipline as Editor).
 * Links are never real hrefs (the webview can't navigate); clicks on
 * data-href anchors go through open_url's scheme whitelist.
 */
import { useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { fsReadFile, onRepoChanged, openUrl } from "../lib/ipc";
import { peekDraft } from "../lib/editorBuffers";
import { renderMarkdownDoc } from "../lib/markdownDoc";
import type { Tab } from "../stores/editor";
import { useWorkspace } from "../stores/workspaces";
import "./MarkdownPreview.css";

type FileTab = Extract<Tab, { kind: "file" }>;

/** External edits arrive in bursts (same rationale as Editor's disk check). */
const RERENDER_DEBOUNCE_MS = 250;

export default function MarkdownPreview({ tab }: { tab: FileTab }) {
  const ws = useWorkspace();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let unlistenRepo: UnlistenFn | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const render = async () => {
      try {
        let text = peekDraft(ws.editor, tab.id);
        if (text === null) {
          const file = await fsReadFile(tab.path);
          if (file.binary) throw new Error("File is not valid UTF-8 text.");
          text = file.text;
        }
        if (disposed || !hostRef.current) return;
        // replaceChildren keeps the container's scrollTop across re-renders
        hostRef.current.replaceChildren(renderMarkdownDoc(text));
        setError(null);
      } catch (e) {
        if (!disposed) setError(String(e));
      }
    };
    void render();

    void onRepoChanged((change) => {
      // events arrive for every open workspace — only our file's repo matters
      if (disposed || !tab.path.startsWith(`${change.repoPath}/`)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void render(), RERENDER_DEBOUNCE_MS);
    }).then((fn) => {
      if (disposed) fn();
      else unlistenRepo = fn;
    });

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unlistenRepo?.();
    };
  }, [tab.id, tab.path, ws.path]);

  return (
    <div
      className="md-preview"
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest("a[data-href]");
        const href = a instanceof HTMLElement ? a.dataset.href : undefined;
        if (href) void openUrl(href);
      }}
    >
      {error ? (
        <div className="md-preview-error">{error}</div>
      ) : (
        <div ref={hostRef} />
      )}
    </div>
  );
}
