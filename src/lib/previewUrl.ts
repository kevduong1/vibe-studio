const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Normalize a user-entered localhost preview URL, or reject it client-side. */
export function normalizePreviewInput(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const candidate = /^\d+$/.test(raw)
    ? `http://localhost:${raw}`
    : raw.includes("://")
      ? raw
      : `http://${raw}`;
  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();
    const loopback = LOOPBACK.has(hostname) || hostname === "::1";
    if (!/^https?:$/.test(url.protocol) || !loopback) return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}
