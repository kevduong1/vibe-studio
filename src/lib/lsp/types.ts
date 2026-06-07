/**
 * Hand-rolled subset of the LSP / JSON-RPC wire types — just what the client
 * actually touches (no protocol-package dependency).
 *
 * Coordinate system: the whole service API speaks LSP positions —
 * `{ line, character }`, 0-based, character in UTF-16 CODE UNITS. CodeMirror
 * line text is JS strings, so per-line indices already ARE utf-16 units (the
 * editor converts offset↔position trivially via doc.lineAt), and the future
 * IDE MCP server has no CM document at all — this is the only coordinate
 * system both can speak. CM offset conversion lives exclusively in cmLsp.ts.
 */
import { basename } from "../path";

// --- JSON-RPC ---------------------------------------------------------------

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** One decoded wire message; dispatch on which fields are present
    (id+method = request, method only = notification, id only = response). */
export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

// --- LSP structures ----------------------------------------------------------

export interface LspPosition {
  /** 0-based. */
  line: number;
  /** 0-based, UTF-16 code units. */
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspLocationLink {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange: LspRange;
}

export interface LspDiagnostic {
  range: LspRange;
  /** 1 error, 2 warning, 3 info, 4 hint (absent → treat as error). */
  severity?: number;
  code?: number | string;
  source?: string;
  message: string;
  /** 1 unnecessary, 2 deprecated. */
  tags?: number[];
}

/** One incremental didChange edit, in pre-change document coordinates. */
export interface LspTextChange {
  range: LspRange;
  text: string;
}

export interface LspMarkupContent {
  kind: "markdown" | "plaintext";
  value: string;
}

/** Deprecated LSP shape some servers still send for hover. */
export type LspMarkedString = string | { language: string; value: string };

export interface LspHover {
  contents: LspMarkupContent | LspMarkedString | LspMarkedString[];
  range?: LspRange;
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

export interface LspCompletionItem {
  label: string;
  /** CompletionItemKind, 1–25. */
  kind?: number;
  detail?: string;
  documentation?: string | LspMarkupContent;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  textEdit?: LspTextEdit;
}

export interface LspCompletionList {
  isIncomplete: boolean;
  items: LspCompletionItem[];
}

export interface LspCompletionContext {
  /** 1 invoked, 2 trigger character, 3 re-trigger for incomplete list. */
  triggerKind: number;
  triggerCharacter?: string;
}

// --- Service types -----------------------------------------------------------

/** Server families — registry granularity (one server per workspace × lang). */
export type ServerLang = "typescript" | "python";

export type ServerStatus =
  | "stopped" // no server (no matching docs opened yet)
  | "starting" // resolving the binary / initialize in flight
  | "running"
  | "stopping"
  | "crashed" // died outside our control; manual restart only
  | "missing" // binary not found
  | "disabled"; // toggled off in settings

const EXT_TO_LANG: Record<string, ServerLang> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  js: "typescript",
  mjs: "typescript",
  cjs: "typescript",
  jsx: "typescript",
  py: "python",
  pyi: "python",
};

const EXT_TO_LANGUAGE_ID: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  py: "python",
  pyi: "python",
};

const extOf = (path: string): string => {
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};

/** Which server family owns this file, or null (no LSP for it). */
export const serverLangForPath = (path: string): ServerLang | null =>
  EXT_TO_LANG[extOf(path)] ?? null;

/** LSP textDocument.languageId for didOpen. */
export const lspLanguageIdFor = (path: string): string =>
  EXT_TO_LANGUAGE_ID[extOf(path)] ?? "plaintext";
