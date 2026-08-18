/**
 * Editor area: tab bar + the active tab's content (file editor or diff
 * viewer). Inactive tabs are unmounted; unsaved file text survives via the
 * draft cache in Editor.tsx. The CodeMirror-heavy panes are lazy-loaded so
 * they stay out of the initial bundle.
 */
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { closeTabSafely, closeTabsSafely, type Tab } from "../stores/editor";
import { useEditor, useRepo, useWorkspace } from "../stores/workspaces";
import { useUiStore } from "../stores/ui";
import { statusColor } from "../lib/status";
import { copyText } from "../lib/clipboard";
import { fsReveal } from "../lib/ipc";
import {
  currentEditorSelection,
  sendEditorContextToAgent,
} from "../lib/editorAgentContext";
import { message } from "@tauri-apps/plugin-dialog";
import { isImagePath, isMarkdownPath } from "../lib/path";
import { ContextMenu } from "./ContextMenu";
import PreviewPane from "./PreviewPane";
import PreviewPicker from "./PreviewPicker";
import {
  IcBrain,
  IcBrowser,
  IcClose,
  IcDiff,
  IcFile,
  IcImage,
  IcPlus,
  IcSparkle,
} from "./icons";
import "./EditorArea.css";

const Editor = lazy(() => import("./Editor"));
const DiffViewer = lazy(() => import("./DiffViewer"));
const ImagePreview = lazy(() => import("./ImagePreview"));
const MarkdownPreview = lazy(() => import("./MarkdownPreview"));
const MemoryPreview = lazy(() => import("./MemoryPreview"));

function TabItem({
  tab,
  active,
  dirty,
  transient,
  onActivate,
  onPointerDown,
  onContext,
}: {
  tab: Tab;
  active: boolean;
  dirty: boolean;
  transient: boolean;
  onActivate: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onContext: (tabId: string, e: ReactMouseEvent) => void;
}) {
  const ws = useWorkspace();
  const pinTab = useEditor((s) => s.pinTab);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  const iconColor =
    tab.kind === "diff" && tab.diff.status
      ? statusColor(tab.diff.status)
      : undefined;

  return (
    <div
      ref={ref}
      data-editor-tab-id={tab.id}
      className={`editor-tab ${active ? "active" : ""} ${dirty ? "dirty" : ""} ${transient ? "transient" : ""}`}
      title={
        tab.kind === "file"
          ? tab.path
          : tab.kind === "diff"
            ? tab.diff.path
            : tab.kind === "memory"
              ? tab.memory.entry.description || tab.title
              : tab.preview.url
      }
      onClick={onActivate}
      onPointerDown={onPointerDown}
      onDoubleClick={() => pinTab(tab.id)}
      onMouseDown={(e) => {
        // prevent middle-click autoscroll; close on aux click below
        if (e.button === 1) e.preventDefault();
      }}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          void closeTabSafely(ws.editor, tab.id);
        }
      }}
      onContextMenu={(e) => onContext(tab.id, e)}
    >
      <span className="tab-icon">
        {tab.kind === "file" ? (
          isImagePath(tab.path) ? <IcImage /> : <IcFile />
        ) : tab.kind === "memory" ? (
          <IcBrain />
        ) : tab.kind === "preview" ? (
          <IcBrowser />
        ) : (
          <IcDiff style={iconColor ? { color: iconColor } : undefined} />
        )}
      </span>
      <span className="tab-title truncate">{tab.title}</span>
      <span className="tab-trailing">
        <span className="tab-dirty-dot" />
        <button
          className="icon-btn tab-close"
          title="Close"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            void closeTabSafely(ws.editor, tab.id);
          }}
        >
          <IcClose />
        </button>
      </span>
    </div>
  );
}

/** Right-click menu for an editor tab: close family + path actions.
    Re-reads the tab list from the store so disabled states stay honest. */
function TabMenu({
  tabId,
  x,
  y,
  onClose,
}: {
  tabId: string;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const ws = useWorkspace();
  const repoPath = useRepo((s) => s.repoPath);
  const tabs = useEditor((s) => s.tabs);
  const idx = tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return null; // tab closed from under the menu
  const tab = tabs[idx];
  const fileChange =
    tab.kind === "file" && tab.path.startsWith(`${repoPath}/`)
      ? (() => {
          const rel = tab.path.slice(repoPath.length + 1);
          const status = ws.repo.getState().status;
          const unstaged = status?.unstaged.find((file) => file.path === rel);
          const staged = status?.staged.find((file) => file.path === rel);
          return unstaged
            ? { file: unstaged, kind: "worktree" as const }
            : staged
              ? { file: staged, kind: "staged" as const }
              : null;
        })()
      : null;
  const close = (ids: string[]) => {
    onClose();
    void closeTabsSafely(ws.editor, ids);
  };
  const sendContext = (context: Parameters<typeof sendEditorContextToAgent>[1]) => {
    onClose();
    void sendEditorContextToAgent(ws.path, context).catch((error) =>
      message(String(error), { title: "Send to Agent", kind: "error" }),
    );
  };
  return (
    <ContextMenu x={x} y={y} onClose={onClose}>
      <button onClick={() => close([tab.id])}>Close</button>
      <button
        disabled={tabs.length === 1}
        onClick={() => close(tabs.filter((t) => t.id !== tab.id).map((t) => t.id))}
      >
        Close Others
      </button>
      <button
        disabled={idx === tabs.length - 1}
        onClick={() => close(tabs.slice(idx + 1).map((t) => t.id))}
      >
        Close Tabs to the Right
      </button>
      <button onClick={() => close(tabs.map((t) => t.id))}>Close All</button>
      <button
        disabled={idx === 0}
        onClick={() => close(tabs.slice(0, idx).map((t) => t.id))}
      >
        Close Tabs to the Left
      </button>
      <button
        disabled={!tabs.some((candidate) => !ws.editor.getState().dirty[candidate.id])}
        onClick={() =>
          close(
            tabs
              .filter((candidate) => !ws.editor.getState().dirty[candidate.id])
              .map((candidate) => candidate.id),
          )
        }
      >
        Close Saved Tabs
      </button>
      {ws.editor.getState().transientTabId === tab.id && (
        <button
          onClick={() => {
            ws.editor.getState().pinTab(tab.id);
            onClose();
          }}
        >
          Keep Open
        </button>
      )}
      {tab.kind === "file" && (
        <>
          <div className="ctx-menu-sep" />
          {!isImagePath(tab.path) && (
            <button
              onClick={() => {
                const selection = currentEditorSelection(ws.path, tab.id);
                if (selection) sendContext({ kind: "selection", selection });
                else {
                  onClose();
                  void message("Select text in the editor first.", {
                    title: "Send Selection to Agent",
                  });
                }
              }}
            >
              Send Selection to Agent
            </button>
          )}
          <button onClick={() => sendContext({ kind: "file", path: tab.path })}>
            Send File to Agent
          </button>
          {fileChange && (
            <button
              onClick={() => {
                ws.editor.getState().openDiff({
                  repoPath,
                  path: fileChange.file.path,
                  kind: fileChange.kind,
                  status: fileChange.file.status,
                  origPath: fileChange.file.origPath,
                });
                onClose();
              }}
            >
              View Changes
            </button>
          )}
          <div className="ctx-menu-sep" />
          <button
            onClick={() => {
              void copyText(tab.path);
              onClose();
            }}
          >
            Copy Path
          </button>
          <button
            onClick={() => {
              // go-to-def can open files outside the repo — keep those absolute
              void copyText(
                tab.path.startsWith(repoPath + "/")
                  ? tab.path.slice(repoPath.length + 1)
                  : tab.path,
              );
              onClose();
            }}
          >
            Copy Relative Path
          </button>
          <button
            onClick={() => {
              void fsReveal(tab.path);
              onClose();
            }}
          >
            Reveal in Finder
          </button>
        </>
      )}
      {tab.kind === "diff" && (
        <>
          <div className="ctx-menu-sep" />
          <button
            disabled={tab.diff.status === "D"}
            onClick={() => {
              ws.editor.getState().openFile(`${tab.diff.repoPath}/${tab.diff.path}`);
              onClose();
            }}
          >
            Open File
          </button>
          <button onClick={() => sendContext({
            kind: "diff",
            path: tab.diff.path,
            diffKind: tab.diff.kind,
          })}>
            Send Diff to Agent
          </button>
          <div className="ctx-menu-sep" />
          <button
            onClick={() => {
              void copyText(`${tab.diff.repoPath}/${tab.diff.path}`);
              onClose();
            }}
          >
            Copy Path
          </button>
          <button
            onClick={() => {
              void copyText(tab.diff.path);
              onClose();
            }}
          >
            Copy Relative Path
          </button>
          <button
            disabled={tab.diff.status === "D"}
            onClick={() => {
              void fsReveal(`${tab.diff.repoPath}/${tab.diff.path}`);
              onClose();
            }}
          >
            Reveal in Finder
          </button>
        </>
      )}
    </ContextMenu>
  );
}

function EmptyState({ onOpenPreview }: { onOpenPreview: () => void }) {
  return (
    <div className="editor-empty">
      <div className="empty-icon-wrap" aria-hidden="true">
        <IcSparkle className="empty-icon" />
      </div>
      <div className="empty-kicker">Workspace ready</div>
      <div className="empty-title">What are we building?</div>
      <div className="empty-copy">Open a file, review a change, or bring your app into focus.</div>
      <button className="primary-btn empty-preview-action" onClick={onOpenPreview}>
        <IcBrowser /> Open Preview…
      </button>
      <div className="empty-hints">
        <div className="hint-row">
          <span>Persistent terminals</span>
          <span className="kbd">⌘ `</span>
        </div>
        <div className="hint-row">
          <span>Toggle sidebar</span>
          <span className="kbd">⌘ B</span>
        </div>
        <div className="hint-row">
          <span>Quick open</span>
          <span className="kbd">⌘ P</span>
        </div>
      </div>
    </div>
  );
}

export default function EditorArea({
  workspaceVisible,
}: {
  workspaceVisible: boolean;
}) {
  const workspace = useWorkspace();
  const tabs = useEditor((s) => s.tabs);
  const activeTabId = useEditor((s) => s.activeTabId);
  const transientTabId = useEditor((s) => s.transientTabId);
  const dirty = useEditor((s) => s.dirty);
  // Rendered as a sibling of the strip (Titlebar pattern) so backdrop and
  // item clicks don't bubble into the tabs' activate-on-click.
  const [tabMenu, setTabMenu] = useState<{
    tabId: string;
    x: number;
    y: number;
  } | null>(null);
  const [previewPickerOpen, setPreviewPickerOpen] = useState(false);
  const markdownPreview = useUiStore((s) => s.markdownPreview);
  const draggedRef = useRef(false);

  const beginTabDrag = (event: React.PointerEvent, tabId: string) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    const move = (pointer: PointerEvent) => {
      if (!dragging && Math.hypot(pointer.clientX - startX, pointer.clientY - startY) < 4) return;
      dragging = true;
      draggedRef.current = true;
      const target = document
        .elementFromPoint(pointer.clientX, pointer.clientY)
        ?.closest<HTMLElement>("[data-editor-tab-id]");
      const targetId = target?.dataset.editorTabId;
      if (!targetId || targetId === tabId) return;
      const state = workspace.editor.getState();
      const index = state.tabs.findIndex((candidate) => candidate.id === targetId);
      if (index >= 0) state.moveTab(tabId, index);
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (dragging) setTimeout(() => (draggedRef.current = false), 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const active = tabs.find((t) => t.id === activeTabId) ?? null;

  return (
    <div className="editor-area">
      {tabs.length === 0 ? (
        <EmptyState onOpenPreview={() => setPreviewPickerOpen(true)} />
      ) : (
        <>
          <div className="editor-tabs">
            {tabs.map((tab) => (
              <TabItem
                key={tab.id}
                tab={tab}
                active={tab.id === activeTabId}
                dirty={!!dirty[tab.id]}
                transient={tab.id === transientTabId}
                onActivate={() => {
                  if (draggedRef.current) return;
                  workspace.editor.getState().setActive(tab.id);
                }}
                onPointerDown={(event) => beginTabDrag(event, tab.id)}
                onContext={(tabId, e) => {
                  e.preventDefault();
                  setTabMenu({ tabId, x: e.clientX, y: e.clientY });
                }}
              />
            ))}
            <button
              className="icon-btn editor-tab-add"
              title="Open Preview"
              onClick={() => setPreviewPickerOpen(true)}
            >
              <IcPlus />
            </button>
          </div>
          <div className="editor-content">
            <Suspense fallback={<div className="editor-msg dim">Loading…</div>}>
              {active?.kind === "file" &&
                (isImagePath(active.path) ? (
                  <ImagePreview key={active.id} tab={active} />
                ) : markdownPreview && isMarkdownPath(active.path) ? (
                  <MarkdownPreview key={active.id} tab={active} />
                ) : (
                  <Editor key={active.id} tab={active} />
                ))}
              {active?.kind === "diff" && (
                <DiffViewer key={active.id} tab={active} />
              )}
              {active?.kind === "memory" && (
                <MemoryPreview key={active.id} tab={active} />
              )}
              {active?.kind === "preview" && (
                <PreviewPane
                  key={active.id}
                  tab={active}
                  workspaceVisible={workspaceVisible}
                />
              )}
            </Suspense>
          </div>
        </>
      )}
      {tabMenu && (
        <TabMenu
          tabId={tabMenu.tabId}
          x={tabMenu.x}
          y={tabMenu.y}
          onClose={() => setTabMenu(null)}
        />
      )}
      {previewPickerOpen && (
        <PreviewPicker
          workspace={workspace}
          onClose={() => setPreviewPickerOpen(false)}
        />
      )}
    </div>
  );
}
