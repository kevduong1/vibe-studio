/**
 * Read-only raster preview for ordinary file tabs. Images cross IPC as a
 * bounded data URL, keeping arbitrary filesystem paths out of the webview and
 * fitting the existing `img-src data:` content-security policy.
 */
import { useEffect, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { fsReadImage, onRepoChanged } from "../lib/ipc";
import type { Tab } from "../stores/editor";
import "./ImagePreview.css";

type FileTab = Extract<Tab, { kind: "file" }>;

const RELOAD_DEBOUNCE_MS = 250;

export default function ImagePreview({ tab }: { tab: FileTab }) {
  const [source, setSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let unlistenRepo: UnlistenFn | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let request = 0;

    const load = async () => {
      const current = ++request;
      setLoading(true);
      try {
        const image = await fsReadImage(tab.path);
        if (disposed || current !== request) return;
        setSource(image.dataUrl);
        setError(null);
      } catch (value) {
        if (disposed || current !== request) return;
        setSource(null);
        setError(String(value));
      } finally {
        if (!disposed && current === request) setLoading(false);
      }
    };

    void load();
    void onRepoChanged((change) => {
      if (disposed || !tab.path.startsWith(`${change.repoPath}/`)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), RELOAD_DEBOUNCE_MS);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenRepo = unlisten;
    });

    return () => {
      disposed = true;
      request += 1;
      if (timer) clearTimeout(timer);
      unlistenRepo?.();
    };
  }, [tab.path]);

  return (
    <div className="image-preview">
      {source && (
        <img
          className="image-preview-image"
          src={source}
          alt={tab.title}
          onError={() => {
            setSource(null);
            setError("The image could not be decoded.");
          }}
        />
      )}
      {error && <div className="editor-msg danger">{error}</div>}
      {loading && <div className="editor-loading">Loading image…</div>}
    </div>
  );
}
