import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
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
const MIN_VIEWPORT = 200;
const MAX_VIEWPORT = 5120;

const VIEWPORT_PRESETS = [
  { label: "Phone", width: 390, height: 844 },
  { label: "Large Phone", width: 430, height: 932 },
  { label: "Tablet", width: 768, height: 1024 },
  { label: "HD", width: 1280, height: 720 },
  { label: "Notebook", width: 1366, height: 768 },
  { label: "Laptop", width: 1440, height: 900 },
  { label: "Full HD", width: 1920, height: 1080 },
] as const;

const viewportKey = (width: number, height: number) => `${width}x${height}`;

const validDimension = (value: string): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(MAX_VIEWPORT, Math.max(MIN_VIEWPORT, Math.round(parsed)));
};

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
  const setPreviewDimensions = useEditor(
    (state) => state.setPreviewDimensions,
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
  const [widthInput, setWidthInput] = useState(String(tab.preview.width));
  const [heightInput, setHeightInput] = useState(String(tab.preview.height));

  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frame = useRef<number | null>(null);
  const syncGeneration = useRef(0);
  const mountedRef = useRef(true);
  const visibleRef = useRef(shouldShow);
  const urlRef = useRef(tab.preview.url);
  const dimensionsRef = useRef({
    width: tab.preview.width,
    height: tab.preview.height,
  });
  const errorRef = useRef<string | null>(controlError);

  // These refs are authoritative for callbacks and async completions. They
  // intentionally update during render, before layout effects can schedule
  // native work from the new render.
  visibleRef.current = shouldShow;
  urlRef.current = tab.preview.url;
  dimensionsRef.current = {
    width: tab.preview.width,
    height: tab.preview.height,
  };
  errorRef.current = controlError;

  useEffect(() => setInput(tab.preview.url), [tab.preview.url]);
  useEffect(() => setWidthInput(String(tab.preview.width)), [tab.preview.width]);
  useEffect(() => setHeightInput(String(tab.preview.height)), [tab.preview.height]);

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
        pageZoom: (rect.width * zoom) / dimensionsRef.current.width,
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

  // Viewport dimensions are an explicit synchronization trigger even though the
  // ResizeObserver normally sees the resulting size change as well.
  useLayoutEffect(() => {
    syncBounds();
  }, [syncBounds, tab.preview.width, tab.preview.height]);

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

  const applyDimensions = (width: number, height: number) => {
    dimensionsRef.current = { width, height };
    setPreviewDimensions(tab.id, width, height);
  };

  const commitDimensionInputs = () => {
    const width = validDimension(widthInput) ?? dimensionsRef.current.width;
    const height = validDimension(heightInput) ?? dimensionsRef.current.height;
    setWidthInput(String(width));
    setHeightInput(String(height));
    applyDimensions(width, height);
  };

  const rotate = () => {
    const { width, height } = dimensionsRef.current;
    applyDimensions(height, width);
  };

  const presetValue = VIEWPORT_PRESETS.some(
    (preset) =>
      preset.width === tab.preview.width && preset.height === tab.preview.height,
  )
    ? viewportKey(tab.preview.width, tab.preview.height)
    : "custom";

  const deviceStyle = {
    "--preview-width": tab.preview.width,
    "--preview-height": tab.preview.height,
    "--preview-width-px": `${tab.preview.width}px`,
    "--preview-ratio": tab.preview.width / tab.preview.height,
  } as CSSProperties;

  const retry = () => {
    const generation = ++syncGeneration.current;
    // A control failure may mean WKWebView disappeared while the registry's
    // cached `created` bit remained true. Reset the same owned session before
    // clearing the error; the next bounds sync will ensure a fresh native
    // child and cannot race an old same-id session close.
    void session
      .reset()
      .then(() => {
        if (!mountedRef.current || generation !== syncGeneration.current) return;
        errorRef.current = null;
        setControlError(null);
        setListenerRetryNonce((nonce) => nonce + 1);
      })
      .catch((error) => hideAfterFailure(error, generation));
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
        <div className="preview-size-controls">
          <select
            aria-label="Preview size preset"
            title="Viewport preset"
            value={presetValue}
            onChange={(event) => {
              const preset = VIEWPORT_PRESETS.find(
                (item) => viewportKey(item.width, item.height) === event.target.value,
              );
              if (preset) applyDimensions(preset.width, preset.height);
            }}
          >
            {VIEWPORT_PRESETS.map((preset) => (
              <option
                key={viewportKey(preset.width, preset.height)}
                value={viewportKey(preset.width, preset.height)}
              >
                {preset.label} · {preset.width}×{preset.height}
              </option>
            ))}
            <option value="custom">Custom</option>
          </select>
          <input
            type="number"
            min={MIN_VIEWPORT}
            max={MAX_VIEWPORT}
            aria-label="Preview width"
            title={`Viewport width (${MIN_VIEWPORT}–${MAX_VIEWPORT}px)`}
            value={widthInput}
            onChange={(event) => setWidthInput(event.target.value)}
            onBlur={commitDimensionInputs}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <span aria-hidden="true">×</span>
          <input
            type="number"
            min={MIN_VIEWPORT}
            max={MAX_VIEWPORT}
            aria-label="Preview height"
            title={`Viewport height (${MIN_VIEWPORT}–${MAX_VIEWPORT}px)`}
            value={heightInput}
            onChange={(event) => setHeightInput(event.target.value)}
            onBlur={commitDimensionInputs}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </div>
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
        className="preview-stage"
      >
        <div
          className="preview-device"
          style={deviceStyle}
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
