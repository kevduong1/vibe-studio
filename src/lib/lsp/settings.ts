/**
 * LSP settings: a session-scoped master mode (Disabled | Dynamic — every
 * launch starts Disabled, deliberately NOT persisted; language services are
 * opt-in per session) over per-language enable toggles persisted across
 * restarts (projectColors.ts pattern: module-level state + localStorage + a
 * zustand version-bump store for reactivity). The service (servers.ts)
 * consumes isLanguageEnabled + subscribeLspSettings — the mode is ANDed into
 * isLanguageEnabled, so every gate and the change fan-out inherit it; the
 * settings UI renders through useLspMode/useLspSettings.
 */
import { create } from "zustand";

import type { ServerLang, ServerStatus } from "./types";

/** UI metadata for the settings modal, in display order. Spawn config
    (binary names, local candidates) lives in servers.ts. */
export const LSP_LANGUAGES: {
  id: ServerLang;
  label: string;
  installHint: string;
}[] = [
  {
    id: "typescript",
    label: "TypeScript / JavaScript",
    installHint: "npm i -g typescript-language-server typescript",
  },
  {
    id: "python",
    label: "Python (Pyright)",
    installHint: "npm i -g pyright",
  },
];

/** Server-status display strings (settings modal rows + status-bar tooltip). */
export const STATUS_LABEL: Record<ServerStatus, string> = {
  stopped: "Idle — starts when a matching file opens",
  starting: "Starting…",
  running: "Running",
  stopping: "Stopping…",
  crashed: "Crashed",
  missing: "Not installed",
  disabled: "Disabled",
};

/** Status → color class of the shared .lsp-dot indicator (theme.css). */
export const STATUS_KIND: Record<ServerStatus, "ok" | "busy" | "bad" | "idle"> = {
  stopped: "idle",
  starting: "busy",
  running: "ok",
  stopping: "idle",
  crashed: "bad",
  missing: "busy",
  disabled: "idle",
};

const STORAGE_KEY = "vibe-studio:lsp";

interface PersistedLsp {
  version: 1;
  enabled: Partial<Record<ServerLang, boolean>>;
}

/** Default enabled: zero-config for installed servers; a missing binary
    degrades to a "missing" status line in settings, not an error. */
const DEFAULTS: Record<ServerLang, boolean> = { typescript: true, python: true };

const load = (): Record<ServerLang, boolean> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as PersistedLsp;
    if (parsed.version !== 1) return { ...DEFAULTS };
    const out = { ...DEFAULTS };
    for (const lang of Object.keys(DEFAULTS) as ServerLang[]) {
      const v = parsed.enabled[lang];
      if (typeof v === "boolean") out[lang] = v;
    }
    return out;
  } catch {
    return { ...DEFAULTS };
  }
};

const enabled = load();

const save = () => {
  const data: PersistedLsp = { version: 1, enabled };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
};

const useLspSettingsVersion = create<{ version: number }>(() => ({ version: 0 }));
const bump = () => useLspSettingsVersion.setState((s) => ({ version: s.version + 1 }));

/** Master switch. "disabled" until manually flipped (status-bar LSP button or
    ⌘, settings); "dynamic" = the lazy per-workspace start/idle-stop policy. */
export type LspMode = "disabled" | "dynamic";

let mode: LspMode = "disabled";

export function getLspMode(): LspMode {
  return mode;
}

export function setLspMode(m: LspMode): void {
  if (mode === m) return;
  mode = m;
  bump();
}

/** Reactive mode for UI (status-bar toggle, settings master switch). */
export function useLspMode(): LspMode {
  useLspSettingsVersion();
  return mode;
}

/** THE service/editor gate: a language runs only in dynamic mode AND with its
    own toggle on. */
export function isLanguageEnabled(lang: ServerLang): boolean {
  return mode === "dynamic" && enabled[lang];
}

export function setLanguageEnabled(lang: ServerLang, on: boolean): void {
  if (enabled[lang] === on) return;
  enabled[lang] = on;
  save();
  bump();
}

/** Vanilla change subscription (service + editor wiring). */
export function subscribeLspSettings(cb: () => void): () => void {
  return useLspSettingsVersion.subscribe(cb);
}

/** Reactive snapshot of the RAW per-language toggles for the settings UI
    (mode-independent — the switches stay editable while mode is off). */
export function useLspSettings(): Record<ServerLang, boolean> {
  useLspSettingsVersion();
  return { ...enabled };
}
