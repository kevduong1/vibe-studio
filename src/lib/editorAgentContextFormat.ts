export interface EditorSelectionContext {
  path: string;
  text: string;
  fromLine: number;
  toLine: number;
}

export type AgentEditorContext =
  | { kind: "selection"; selection: EditorSelectionContext }
  | { kind: "file"; path: string }
  | { kind: "diff"; path: string; diffKind: string };

// Leave room inside the 8,192-character programmatic-prompt boundary for the path,
// line range, explanation, and truncation notice.
const MAX_SELECTION_CHARS = 7 * 1024;

export function formatAgentEditorContext(context: AgentEditorContext): string {
  if (context.kind === "selection") {
    const { selection } = context;
    const text = selection.text.slice(0, MAX_SELECTION_CHARS);
    const truncated = selection.text.length > text.length
      ? `\n\n[Selection truncated by Talos at ${MAX_SELECTION_CHARS.toLocaleString()} characters.]`
      : "";
    return `Use this selected editor context from ${selection.path}:${selection.fromLine}-${selection.toLine}:\n\n${text}${truncated}`;
  }
  if (context.kind === "diff") {
    return `Review the ${context.diffKind} diff for ${context.path}. Inspect the repository diff directly and use it as context for the next response.`;
  }
  return `Use this editor file as context for the next response: ${context.path}`;
}
