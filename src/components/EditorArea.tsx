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
import { isMarkdownPath } from "../lib/path";
import { ContextMenu } from "./ContextMenu";
import { IcBranch, IcClose, IcDiff, IcFile } from "./icons";
import "./EditorArea.css";

const Editor = lazy(() => import("./Editor"));
const DiffViewer = lazy(() => import("./DiffViewer"));
const MarkdownPreview = lazy(() => import("./MarkdownPreview"));

function TabItem({
  tab,
  active,
  dirty,
  onContext,
}: {
  tab: Tab;
  active: boolean;
  dirty: boolean;
  onContext: (tabId: string, e: ReactMouseEvent) => void;
}) {
  const ws = useWorkspace();
  const setActive = useEditor((s) => s.setActive);
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
      className={`editor-tab ${active ? "active" : ""} ${dirty ? "dirty" : ""}`}
      title={tab.kind === "file" ? tab.path : tab.diff.path}
      onClick={() => setActive(tab.id)}
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
          <IcFile />
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
  const close = (ids: string[]) => {
    onClose();
    void closeTabsSafely(ws.editor, ids);
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
      {tab.kind === "file" && (
        <>
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
    </ContextMenu>
  );
}

function EmptyState() {
  return (
    <div className="editor-empty">
      <IcBranch className="empty-icon" />
      <div className="empty-title">Open a file or select a change</div>
      <div className="empty-hints">
        <div className="hint-row">
          <span className="kbd">⌘ `</span>
          <span>Toggle terminal</span>
        </div>
        <div className="hint-row">
          <span className="kbd">⌘ B</span>
          <span>Toggle sidebar</span>
        </div>
        <div className="hint-row">
          <span className="kbd">⌘ W</span>
          <span>Close tab</span>
        </div>
      </div>
    </div>
  );
}

export default function EditorArea() {
  const tabs = useEditor((s) => s.tabs);
  const activeTabId = useEditor((s) => s.activeTabId);
  const dirty = useEditor((s) => s.dirty);
  // Rendered as a sibling of the strip (Titlebar pattern) so backdrop and
  // item clicks don't bubble into the tabs' activate-on-click.
  const [tabMenu, setTabMenu] = useState<{
    tabId: string;
    x: number;
    y: number;
  } | null>(null);
  const markdownPreview = useUiStore((s) => s.markdownPreview);

  const active = tabs.find((t) => t.id === activeTabId) ?? null;

  return (
    <div className="editor-area">
      {tabs.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="editor-tabs">
            {tabs.map((tab) => (
              <TabItem
                key={tab.id}
                tab={tab}
                active={tab.id === activeTabId}
                dirty={!!dirty[tab.id]}
                onContext={(tabId, e) => {
                  e.preventDefault();
                  setTabMenu({ tabId, x: e.clientX, y: e.clientY });
                }}
              />
            ))}
          </div>
          <div className="editor-content">
            <Suspense fallback={<div className="editor-msg dim">Loading…</div>}>
              {active?.kind === "file" &&
                (markdownPreview && isMarkdownPath(active.path) ? (
                  <MarkdownPreview key={active.id} tab={active} />
                ) : (
                  <Editor key={active.id} tab={active} />
                ))}
              {active?.kind === "diff" && (
                <DiffViewer key={active.id} tab={active} />
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
    </div>
  );
}
