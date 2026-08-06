/**
 * Localhost preview picker. It is deliberately workspace-bound: discovery
 * and the new session-only preview tab always belong to the visible editor.
 */
import { useEffect, useRef, useState } from "react";
import { type PreviewServer, previewServers } from "../lib/ipc";
import { useNativeOverlay } from "../lib/nativeOverlays";
import { normalizePreviewInput } from "../lib/previewUrl";
import type { Workspace } from "../stores/workspaces";
import { IcBrowser, IcRefresh } from "./icons";
import "./PreviewPicker.css";

const MANUAL_URL_ERROR = "Enter a localhost HTTP or HTTPS URL";
const MANUAL_URL_ERROR_ID = "preview-picker-url-error";
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

const serverLabel = (server: PreviewServer) =>
  server.framework?.trim() || server.process.trim() || "Local server";

function ServerGroup({
  title,
  servers,
  onOpen,
}: {
  title: string;
  servers: PreviewServer[];
  onOpen: (server: PreviewServer) => void;
}) {
  if (servers.length === 0) return null;
  return (
    <section className="preview-picker-group">
      <div className="preview-picker-heading">{title}</div>
      {servers.map((server) => {
        const label = serverLabel(server);
        return (
          <button
            key={`${server.url}:${server.pid ?? ""}:${server.cwd ?? ""}`}
            className="preview-picker-server"
            onClick={() => onOpen(server)}
          >
            <span className="preview-picker-server-main">
              <IcBrowser />
              <span className="truncate">{label}</span>
            </span>
            <span className="preview-picker-server-meta">
              <span className="truncate">{server.url}</span>
              {server.pid !== null && <span>PID {server.pid}</span>}
            </span>
            {server.cwd && (
              <span className="preview-picker-server-cwd truncate">{server.cwd}</span>
            )}
          </button>
        );
      })}
    </section>
  );
}

export default function PreviewPicker({
  workspace,
  onClose,
}: {
  workspace: Workspace;
  onClose: () => void;
}) {
  useNativeOverlay();
  const [input, setInput] = useState("");
  const [servers, setServers] = useState<PreviewServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    inputRef.current?.focus();

    // Keep focus in the dialog even if a browser/API focus change tries to
    // move it behind the backdrop. Normal Tab cycling is handled below.
    const keepFocusInside = (event: FocusEvent) => {
      if (panel && event.target instanceof Node && !panel.contains(event.target)) {
        inputRef.current?.focus();
      }
    };
    document.addEventListener("focusin", keepFocusInside);
    return () => {
      document.removeEventListener("focusin", keepFocusInside);
      previous?.focus();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    setServers(null);
    setError(null);
    previewServers(workspace.path)
      .then((next) => {
        if (!disposed) setServers(next);
      })
      .catch((reason) => {
        if (!disposed) {
          setServers([]);
          setError(String(reason));
        }
      });
    return () => {
      disposed = true;
    };
  }, [workspace.path, refreshNonce]);

  const openServer = (server: PreviewServer) => {
    const label = serverLabel(server);
    workspace.editor.getState().openPreview(server.url, label);
    onClose();
  };

  const submitManual = () => {
    const url = normalizePreviewInput(input);
    if (!url) {
      setError(MANUAL_URL_ERROR);
      return;
    }
    workspace.editor.getState().openPreview(url);
    onClose();
  };

  const projectServers = servers?.filter((server) => server.projectMatch) ?? [];
  const otherServers = servers?.filter((server) => !server.projectMatch) ?? [];
  const manualInputInvalid = error === MANUAL_URL_ERROR;

  const onKeyDown = (event: React.KeyboardEvent) => {
    // Picker keyboard events must not trigger window-level workspace/tab
    // shortcuts below the overlay.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Enter" && event.target === inputRef.current) {
      event.preventDefault();
      submitManual();
    } else if (event.key === "Tab") {
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || active === panel) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className="preview-picker-backdrop" onMouseDown={onClose}>
      <div
        ref={panelRef}
        className="preview-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Open Preview"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="preview-picker-input-row">
          <input
            ref={inputRef}
            className="text-input"
            aria-label="Localhost preview URL"
            aria-invalid={manualInputInvalid || undefined}
            aria-describedby={manualInputInvalid ? MANUAL_URL_ERROR_ID : undefined}
            placeholder="localhost:3000 or https://localhost:3000"
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              if (error === MANUAL_URL_ERROR) setError(null);
            }}
          />
          <button className="primary-btn" onClick={submitManual}>
            Open
          </button>
        </div>
        {error && (
          <div
            id={manualInputInvalid ? MANUAL_URL_ERROR_ID : undefined}
            className="preview-picker-error"
            role={manualInputInvalid ? "alert" : "status"}
          >
            {error}
          </div>
        )}
        <div className="preview-picker-list">
          <div className="preview-picker-list-header">
            <span>Detected local servers</span>
            <button
              className="icon-btn"
              title="Refresh local servers"
              disabled={servers === null}
              onClick={() => {
                if (servers === null) return;
                setServers(null);
                setRefreshNonce((nonce) => nonce + 1);
              }}
            >
              <IcRefresh />
            </button>
          </div>
          {servers === null ? (
            <div className="preview-picker-empty">Scanning…</div>
          ) : (
            <>
              <ServerGroup
                title="This project"
                servers={projectServers}
                onOpen={openServer}
              />
              <ServerGroup
                title="Other local servers"
                servers={otherServers}
                onOpen={openServer}
              />
              {servers.length === 0 && (
                <div className="preview-picker-empty">No local servers found</div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
