/** Multiline shell program for nonce-bound check evidence. Real line breaks
 * keep trailing comments and heredoc delimiters from swallowing the marker. */
export function trackedCommandProgram(command: string, runId: string, nonce: string): string {
  const markerRun = encodeURIComponent(runId);
  return `(\n${command}\n)\n__vibe_status=$?\nprintf '\\033]6973;vibe;%s;%s;%s\\007' '${markerRun}' '${nonce}' "$__vibe_status"`;
}
