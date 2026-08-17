/** Multiline shell program for nonce-bound check evidence. Real line breaks
 * keep trailing comments and heredoc delimiters from swallowing the marker. */
export function trackedCommandProgram(command: string, runId: string, nonce: string): string {
  const markerRun = encodeURIComponent(runId);
  return `(\n${command}\n)\n__talos_status=$?\nprintf '\\033]6973;talos;%s;%s;%s\\007' '${markerRun}' '${nonce}' "$__talos_status"`;
}
