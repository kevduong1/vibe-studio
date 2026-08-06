import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  onPreviewExternal,
  onPreviewLoad,
  openUrl,
  type PreviewBounds,
} from "../lib/ipc";
import { getOrCreatePreviewSession } from "../lib/previewSessions";
import { normalizePreviewInput } from "../lib/previewUrl";
import { currentZoom, onZoomChange } from "../lib/zoom";
import type { PreviewTab } from "../stores/editor";
import { useUiStore } from "../stores/ui";
import { useEditor, useWorkspacesStore } from "../stores/workspaces";
import {
  IcBack,
  IcExternal,
  IcForward,
  IcRefresh,
  IcRotate,
} from "./icons";
import "./PreviewPane.css";

const INPUT_ERROR = "Enter a localhost HTTP or HTTPS URL";

/**
 * Native external-navigation events are app-wide, so they deliberately have
 * one module-level listener rather than one listener per mounted preview.
 * The native id is treated as untrusted/stale until a current workspace tab
 * proves that the preview is still owned by the app.
 */
const handlePreviewExternal = ({ id, url }: { id: string; url: string }) => {
  const owned = useWorkspacesStore
    .getState()
    .workspaces.some((workspace) =>
      workspace.editor
        .getState()
        .tabs.some((tab) => tab.kind === "preview" && tab.id === id),
    );
  if (!owned) return;
  void openUrl(url).catch((error) =>
    console.error(`Failed to open external preview URL for ${id}`, error),
  );
};

type PreviewExternalGlobal = typeof globalThis & {
  __vibeStudioPreviewExternalListener?: Promise<() => void>;
};
const previewExternalGlobal = globalThis as PreviewExternalGlobal;
if (!previewExternalGlobal.__vibeStudioPreviewExternalListener) {
  const listener = onPreviewExternal(handlePreviewExternal);
  previewExternalGlobal.__vibeStudioPreviewExternalListener = listener;
  void listener.catch((error) => {
    if (previewExternalGlobal.__vibeStudioPreviewExternalListener === listener) {
      delete previewExternalGlobal.__vibeStudioPreviewExternalListener;
    }
    console.error("Failed to listen for preview external URLs", error);
  });
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export default function PreviewPane({
  tab,
  workspaceVisible,
}: {
  tab: PreviewTab;
  workspaceVisible: boolean;
}) {
  const session = getOrCreatePreviewSession(tab.id);
  const setPreviewUrl = useEditor((state) => state.setPreviewUrl);
  const setPreviewOrientation = useEditor(
    (state) => state.setPreviewOrientation,
  );
  const panelMaximized = useUiStore((state) => state.panelMaximized);
  const nativeOverlayDepth = useUiStore((state) => state.nativeOverlayDepth);
  const shouldShow =
    workspaceVisible && !panelMaximized && nativeOverlayDepth === 0;

  const [input, setInput] = useState(tab.preview.url);
  const [inputError, setInputError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const [listenerRetryNonce, setListenerRetryNonce] = useState(0);

  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frame = useRef<number | null>(null);
  const syncGeneration = useRef(0);
  const mountedRef = useRef(true);
  const visibleRef = useRef(shouldShow);
  const urlRef = useRef(tab.preview.url);
  const orientationRef = useRef(tab.preview.orientation);
  const errorRef = useRef<string | null>(controlError);

  // These refs are authoritative for callbacks and async completions. They
  // intentionally update during render, before layout effects can schedule
  // native work from the new render.
  visibleRef.current = shouldShow;
  urlRef.current = tab.preview.url;
  orientationRef.current = tab.preview.orientation;
  errorRef.current = controlError;

  useEffect(() => setInput(tab.preview.url), [tab.preview.url]);

  const hideAfterFailure = useCallback(
    (error: unknown, generation?: number) => {
      if (
        !mountedRef.current ||
        (generation !== undefined && generation !== syncGeneration.current)
      ) {
        return;
      }
      const message = errorMessage(error);
      errorRef.current = message;
      syncGeneration.current += 1;
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
      setControlError(message);
      void session
        .setVisible(false)
        .catch((hideError) =>
          console.error(`Failed to hide preview ${tab.id} after an error`, hideError),
        );
    },
    [session, tab.id],
  );

  /** The sole route for measuring and applying native child-view bounds. */
  const syncBounds = useCallback(() => {
    const generation = ++syncGeneration.current;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (!mountedRef.current || generation !== syncGeneration.current) return;

      if (!visibleRef.current || errorRef.current) {
        void session
          .setVisible(false)
          .catch((error) => hideAfterFailure(error, generation));
        return;
      }

      const rect = hostRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      const zoom = currentZoom();
      const bounds: PreviewBounds = {
        x: rect.left * zoom,
        y: rect.top * zoom,
        width: rect.width * zoom,
        height: rect.height * zoom,
      };
      const url = urlRef.current;

      void (async () => {
        await session.ensure(url, bounds);
        if (!mountedRef.current || generation !== syncGeneration.current) return;
        await session.setBounds(bounds);
        if (!mountedRef.current || generation !== syncGeneration.current) return;
        await session.setVisible(visibleRef.current && !errorRef.current);
      })().catch((error) => hideAfterFailure(error, generation));
    });
  }, [hideAfterFailure, session]);

  // Visibility changes bypass measurement: hidden workspaces, a maximized
  // panel, and native-covering overlays must hide the child immediately.
  useLayoutEffect(() => {
    if (!shouldShow || controlError) {
      const generation = ++syncGeneration.current;
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
      void session
        .setVisible(false)
        .catch((error) => hideAfterFailure(error, generation));
      return;
    }
    syncBounds();
  }, [controlError, hideAfterFailure, session, shouldShow, syncBounds]);

  // Orientation is an explicit synchronization trigger even though the
  // ResizeObserver normally sees the resulting size change as well.
  useLayoutEffect(() => {
    syncBounds();
  }, [syncBounds, tab.preview.orientation]);

  useEffect(() => {
    const host = hostRef.current;
    const stage = stageRef.current;
    if (!host && !stage) return;
    const observer = new ResizeObserver(syncBounds);
    if (host) observer.observe(host);
    // The capped device can retain the same dimensions while a sidebar or
    // panel resize moves its centered position. The stage changes size in
    // those layouts, so observing it makes the host's new left/top measurable.
    if (stage) observer.observe(stage);
    window.addEventListener("resize", syncBounds);
    const stopZoomListener = onZoomChange(syncBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
      stopZoomListener();
    };
  }, [controlError, syncBounds]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onPreviewLoad((event) => {
      if (disposed || event.id !== tab.id) return;
      if (event.phase === "started") {
        setLoading(true);
        setPreviewUrl(tab.id, event.url);
      } else {
        setLoading(false);
      }
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error) => {
        if (!disposed) hideAfterFailure(error);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [hideAfterFailure, listenerRetryNonce, setPreviewUrl, tab.id]);

  useLayoutEffect(() => {
    // StrictMode replays effect setup after its simulated cleanup while
    // preserving refs, so each setup must explicitly mark the pane live.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      visibleRef.current = false;
      syncGeneration.current += 1;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      // An inactive tab unmount only hides. Closing remains exclusively owned
      // by the editor/workspace disposal path so page state survives switches.
      void session
        .setVisible(false)
        .catch((error) => console.error(`Failed to hide preview ${tab.id}`, error));
    };
  }, [session, tab.id]);

  const runControl = (operation: () => Promise<void>) => {
    void operation().catch((error) => hideAfterFailure(error));
  };

  const submitUrl = (event: FormEvent) => {
    event.preventDefault();
    const url = normalizePreviewInput(input);
    if (!url) {
      setInputError(INPUT_ERROR);
      return;
    }
    setInputError(null);
    runControl(() => session.navigate(url));
    setPreviewUrl(tab.id, url);
  };

  const rotate = () => {
    const orientation =
      orientationRef.current === "portrait" ? "landscape" : "portrait";
    orientationRef.current = orientation;
    setPreviewOrientation(tab.id, orientation);
  };

  const retry = () => {
    errorRef.current = null;
    setControlError(null);
    setListenerRetryNonce((nonce) => nonce + 1);
    syncBounds();
  };

  return (
    <div className="preview-pane">
      <div className="preview-toolbar">
        <button
          className="icon-btn"
          title="Back"
          aria-label="Back"
          onClick={() => runControl(() => session.back())}
        >
          <IcBack />
        </button>
        <button
          className="icon-btn"
          title="Forward"
          aria-label="Forward"
          onClick={() => runControl(() => session.forward())}
        >
          <IcForward />
        </button>
        <button
          className="icon-btn"
          title="Reload"
          aria-label="Reload"
          onClick={() => runControl(() => session.reload())}
        >
          <IcRefresh />
        </button>
        <form className="preview-address" onSubmit={submitUrl}>
          <input
            className="text-input"
            aria-label="Preview URL"
            aria-invalid={inputError ? true : undefined}
            title={inputError ?? undefined}
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              if (inputError) setInputError(null);
            }}
          />
        </form>
        {loading && <span className="preview-loading">Loading…</span>}
        <button
          className="icon-btn"
          title="Open External"
          aria-label="Open External"
          onClick={() =>
            void openUrl(urlRef.current).catch((error) =>
              console.error("Failed to open preview URL", error),
            )
          }
        >
          <IcExternal />
        </button>
        <button
          className="icon-btn"
          title="Rotate Device"
          aria-label="Rotate Device"
          onClick={rotate}
        >
          <IcRotate />
        </button>
      </div>
      <div
        ref={stageRef}
        className={`preview-stage ${tab.preview.orientation}`}
      >
        <div
          className="preview-device"
          onPointerDown={() => {
            if (!controlError && shouldShow) runControl(() => session.focus());
          }}
        >
          {controlError ? (
            <div className="preview-error" role="alert">
              <div>Preview unavailable</div>
              <div className="preview-error-detail">{controlError}</div>
              <button className="primary-btn" onClick={retry}>
                Retry
              </button>
            </div>
          ) : (
            <div ref={hostRef} className="preview-native-host" />
          )}
        </div>
      </div>
    </div>
  );
}
