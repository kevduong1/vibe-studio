/**
 * path ↔ file:// URI conversion. ALL URI handling funnels through here —
 * never string-concat "file://" + path elsewhere: spaces/brackets/% in
 * paths are the LSP equivalent of the git.rs escape_pathspec lesson.
 * (Lives in lsp/, not lib/path.ts: nothing outside LSP needs file URIs.)
 */

/** Absolute POSIX path → file:// URI (per-segment percent-encoding —
    over-escaping is valid URI syntax and handles spaces, #, ?, %, unicode). */
export const pathToFileUri = (path: string): string =>
  "file://" + path.split("/").map(encodeURIComponent).join("/");

/** file:// URI → absolute path; null for any other scheme. */
export function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return null;
  }
}
