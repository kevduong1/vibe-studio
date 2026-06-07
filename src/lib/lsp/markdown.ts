/**
 * Minimal renderer for the markdown subset language servers actually emit in
 * hover/completion docs (tsserver: ```ts signature blocks + jsdoc prose;
 * pyright: signatures + `---` rules). Hand-rolled — no dependency, and
 * inherently sanitized: everything is built with createElement/textContent,
 * never innerHTML, so raw HTML in server output renders inert as text.
 *
 * Scope: fenced code blocks (syntax-highlighted when the fence names a
 * language — see highlightInto), inline `code`, **bold**, star- and
 * underscore-italics, [text](url) → text only (no clickable links), ---
 * rules, paragraphs. Everything else passes through as plain text.
 */
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { highlightTree } from "@lezer/highlight";

import type { LspMarkupContent } from "./types";

/** Progressive syntax highlighting for a fenced block: the caller has already
    painted plain text (always correct), and when the language chunk resolves
    (lazy-loaded once, then cached by language-data) the pre's children are
    swapped for highlighted spans. oneDarkHighlightStyle's classes are mounted
    by every editor view (editorTheme), so tooltip spans pick up the editor's
    own token colors. Sanitization discipline holds: spans are built with
    createElement/textContent only. */
function highlightInto(pre: HTMLElement, code: string, fenceTag: string) {
  const desc = LanguageDescription.matchLanguageName(languages, fenceTag, true);
  if (!desc) return;
  desc.load().then(
    (support) => {
      const frag = document.createDocumentFragment();
      let pos = 0; // gaps between styled ranges are emitted as plain text
      highlightTree(
        support.language.parser.parse(code),
        oneDarkHighlightStyle,
        (from, to, classes) => {
          if (from > pos) frag.append(code.slice(pos, from));
          const span = document.createElement("span");
          span.className = classes;
          span.textContent = code.slice(from, to);
          frag.append(span);
          pos = to;
        },
      );
      if (pos < code.length) frag.append(code.slice(pos));
      pre.replaceChildren(frag);
    },
    () => {}, // load failure → keep the plain text
  );
}

const INLINE =
  /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|\[([^\]]*)\]\([^)]*\)/g;

function appendInline(parent: HTMLElement, text: string) {
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    // CommonMark forbids intraword `_` emphasis (snake_case, __init__):
    // reject the underscore branch when a word character precedes the
    // opening `_`. Leaving `last` untouched folds the rejected span into
    // the next literal slice; the scan resumes after it. Checked in code —
    // safari16 (the Vite build target) lacks regex lookbehind.
    if (m[4] !== undefined && at > 0 && /\w/.test(text[at - 1])) continue;
    if (at > last) parent.append(text.slice(last, at));
    if (m[1] !== undefined) {
      const el = document.createElement("code");
      el.textContent = m[1];
      parent.append(el);
    } else if (m[2] !== undefined) {
      const el = document.createElement("strong");
      el.textContent = m[2];
      parent.append(el);
    } else if (m[3] !== undefined || m[4] !== undefined) {
      const el = document.createElement("em");
      el.textContent = (m[3] ?? m[4])!;
      parent.append(el);
    } else if (m[5] !== undefined) {
      parent.append(m[5]);
    }
    last = at + m[0].length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

/** Markdown string → detached DOM tree. */
export function renderMarkdown(md: string): HTMLElement {
  const root = document.createElement("div");
  const lines = md.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trimStart().startsWith("```")) {
      // Fenced code block: collect until the closing fence (or EOF). The
      // info string names the language (tsserver: ```typescript, pyright:
      // ```python; first word only — CommonMark allows trailing metadata).
      const fenceTag = line.trimStart().slice(3).trim().split(/\s+/)[0];
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        code.push(lines[i]);
        i++;
      }
      i++; // skip the closing fence
      const pre = document.createElement("pre");
      pre.className = "cm-lsp-md-code";
      const text = code.join("\n");
      pre.textContent = text;
      if (fenceTag && text.trim()) highlightInto(pre, text, fenceTag);
      root.append(pre);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      root.append(document.createElement("hr"));
      i++;
      continue;
    }
    // Paragraph: greedily absorb until a blank line, fence, or rule.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trimStart().startsWith("```") &&
      !/^\s*([-*_])\s*(\1\s*){2,}$/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    const p = document.createElement("p");
    appendInline(p, para.join("\n"));
    root.append(p);
  }
  return root;
}

function renderPlaintext(text: string): HTMLElement {
  const root = document.createElement("div");
  for (const para of text.split(/\n{2,}/)) {
    if (!para.trim()) continue;
    const p = document.createElement("p");
    p.textContent = para;
    root.append(p);
  }
  return root;
}

/** Completion documentation: plain string (markdown by convention) or
    MarkupContent with an explicit kind. */
export function renderMarkup(doc: string | LspMarkupContent): HTMLElement {
  if (typeof doc === "string") return renderMarkdown(doc);
  return doc.kind === "plaintext"
    ? renderPlaintext(doc.value)
    : renderMarkdown(doc.value);
}
