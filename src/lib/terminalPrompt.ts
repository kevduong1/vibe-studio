/** Format one programmatic agent prompt as terminal input. Escape/control
 * bytes are removed so prompt content cannot terminate bracketed paste or
 * inject terminal control sequences. */
export function terminalPromptInput(text: string, bracketedPaste: boolean): string {
  const safe = text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
  if (bracketedPaste) return `\x1b[200~${safe}\x1b[201~\r`;
  return `${safe.replace(/[\n\t]+/g, " ")}\r`;
}
