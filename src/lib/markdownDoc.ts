/**
 * Full-document markdown → detached DOM renderer for the editor's preview
 * mode (MarkdownPreview.tsx). Parses with @lezer/markdown's GFM parser
 * (already in the dependency tree via @codemirror/language-data) and walks
 * the syntax tree building DOM with createElement/textContent ONLY — the
 * lsp/markdown.ts discipline — so raw HTML in the document renders inert as
 * muted literal text and no sanitizer is needed.
 *
 * Deliberate limits: images render as a labelled placeholder (the CSP allows
 * no remote/file image sources), inline/block HTML is shown as literal text,
 * and only http(s)/mailto links are clickable (via data-href — consumed by
 * MarkdownPreview's click handler; never a real href, so the webview can
 * never navigate).
 */
import type { SyntaxNode } from "@lezer/common";
import { GFM, parser as commonmarkParser } from "@lezer/markdown";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { StyleModule } from "style-mod";
import { highlightInto } from "./lsp/markdown";

const parser = commonmarkParser.configure(GFM);

// Fenced-code token classes are normally mounted by editor views
// (editorTheme); the preview can render before any editor ever existed, so
// mount them explicitly. mount() dedupes — at most one <style> ever.
if (oneDarkHighlightStyle.module) {
  StyleModule.mount(document, oneDarkHighlightStyle.module);
}

const EXTERNAL_URL = /^(https?:|mailto:)/i;

const HEADINGS: Record<string, string> = {
  ATXHeading1: "h1",
  ATXHeading2: "h2",
  ATXHeading3: "h3",
  ATXHeading4: "h4",
  ATXHeading5: "h5",
  ATXHeading6: "h6",
  SetextHeading1: "h1",
  SetextHeading2: "h2",
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntity(raw: string): string {
  const m = /^&(?:#(\d+)|#x([0-9a-fA-F]+)|(\w+));$/.exec(raw);
  if (!m) return raw;
  try {
    if (m[1]) return String.fromCodePoint(Number(m[1]));
    if (m[2]) return String.fromCodePoint(parseInt(m[2], 16));
  } catch {
    return raw;
  }
  return NAMED_ENTITIES[m[3].toLowerCase()] ?? raw;
}

const el = (tag: string, cls?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

const slice = (src: string, n: SyntaxNode) => src.slice(n.from, n.to);

/** Inline content of `node` clipped to [from, to]: literal text between
    child nodes, recursion into them. The clip range scopes link labels
    (children outside it — URL, closing marks — are skipped). */
function inlineRange(
  node: SyntaxNode,
  src: string,
  parent: HTMLElement,
  from: number,
  to: number,
) {
  let pos = from;
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.to <= from || c.from >= to) continue;
    if (c.from > pos) parent.append(src.slice(pos, c.from));
    inlineNode(c, src, parent);
    pos = c.to;
  }
  if (pos < to) parent.append(src.slice(pos, to));
}

const inline = (node: SyntaxNode, src: string, parent: HTMLElement) =>
  inlineRange(node, src, parent, node.from, node.to);

function wrapInline(node: SyntaxNode, src: string, parent: HTMLElement, tag: string) {
  const e = el(tag);
  inline(node, src, e);
  parent.append(e);
}

/** The label region of a Link/Image: between the opening and closing
    LinkMark ("[…]"), falling back to the whole node. */
function labelRange(node: SyntaxNode): [number, number] {
  const marks = node.getChildren("LinkMark");
  return marks.length >= 2
    ? [marks[0].to, marks[1].from]
    : [node.from, node.to];
}

function renderLink(node: SyntaxNode, src: string, parent: HTMLElement) {
  const urlNode = node.getChild("URL");
  const url = urlNode ? slice(src, urlNode) : null;
  const a = el("a", "md-link") as HTMLAnchorElement;
  if (url) {
    a.title = url;
    if (EXTERNAL_URL.test(url)) a.dataset.href = url;
  }
  const [from, to] = labelRange(node);
  inlineRange(node, src, a, from, to);
  parent.append(a);
}

function inlineNode(node: SyntaxNode, src: string, parent: HTMLElement) {
  switch (node.name) {
    // structural marks render nothing
    case "EmphasisMark":
    case "CodeMark":
    case "StrikethroughMark":
    case "LinkMark":
    case "HeaderMark":
    case "TaskMarker":
    case "Comment":
      return;
    case "Emphasis":
      return wrapInline(node, src, parent, "em");
    case "StrongEmphasis":
      return wrapInline(node, src, parent, "strong");
    case "Strikethrough":
      return wrapInline(node, src, parent, "del");
    case "InlineCode":
      return wrapInline(node, src, parent, "code");
    case "Link":
      return renderLink(node, src, parent);
    case "Image": {
      // no loadable image sources under the app CSP — labelled placeholder
      const span = el("span", "md-image");
      const urlNode = node.getChild("URL");
      if (urlNode) span.title = slice(src, urlNode);
      const [from, to] = labelRange(node);
      inlineRange(node, src, span, from, to);
      if (!span.textContent) span.append("image");
      parent.append(span);
      return;
    }
    case "Autolink":
    case "URL": {
      const url = slice(src, node).replace(/^<|>$/g, "");
      const a = el("a", "md-link") as HTMLAnchorElement;
      a.title = url;
      const target = /^[\w.+-]+@/.test(url) ? `mailto:${url}` : url;
      if (EXTERNAL_URL.test(target)) a.dataset.href = target;
      a.append(url);
      parent.append(a);
      return;
    }
    case "Escape":
      parent.append(src.slice(node.from + 1, node.to));
      return;
    case "Entity":
      parent.append(decodeEntity(slice(src, node)));
      return;
    case "HardBreak":
      parent.append(document.createElement("br"));
      return;
    case "HTMLTag":
      parent.append(Object.assign(el("span", "md-html"), { textContent: slice(src, node) }));
      return;
    default:
      // unknown container — render its contents rather than dropping them
      inline(node, src, parent);
  }
}

// CodeText slices carry their own newlines (indented blocks emit one node
// per line, the line break inside the node) — concatenate, never join("\n").
const codeText = (node: SyntaxNode, src: string) =>
  node.getChildren("CodeText").map((c) => slice(src, c)).join("");

function renderFencedCode(node: SyntaxNode, src: string, parent: HTMLElement) {
  const info = node.getChild("CodeInfo");
  const text = codeText(node, src);
  const pre = el("pre", "md-code");
  pre.textContent = text;
  const lang = info ? slice(src, info).trim().split(/\s+/)[0] : "";
  if (lang && text.trim()) highlightInto(pre, text, lang);
  parent.append(pre);
}

function renderTable(node: SyntaxNode, src: string, parent: HTMLElement) {
  const table = el("table", "md-table");
  const tbody = el("tbody");
  const renderRow = (row: SyntaxNode, cellTag: string, into: HTMLElement) => {
    const tr = el("tr");
    for (const cell of row.getChildren("TableCell")) {
      const td = el(cellTag);
      inline(cell, src, td);
      tr.append(td);
    }
    into.append(tr);
  };
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === "TableHeader") {
      const thead = el("thead");
      renderRow(c, "th", thead);
      table.append(thead);
    } else if (c.name === "TableRow") {
      renderRow(c, "td", tbody);
    } // TableDelimiter renders nothing
  }
  if (tbody.childNodes.length) table.append(tbody);
  parent.append(table);
}

function renderList(node: SyntaxNode, src: string, parent: HTMLElement) {
  const list = el(node.name === "OrderedList" ? "ol" : "ul") as HTMLOListElement;
  if (node.name === "OrderedList") {
    const mark = node.getChild("ListItem")?.getChild("ListMark");
    const start = mark ? parseInt(slice(src, mark), 10) : NaN;
    if (!Number.isNaN(start) && start !== 1) list.start = start;
  }
  for (const item of node.getChildren("ListItem")) {
    const li = el("li");
    renderBlocks(item, src, li);
    list.append(li);
  }
  parent.append(list);
}

function blockNode(node: SyntaxNode, src: string, parent: HTMLElement) {
  const heading = HEADINGS[node.name];
  if (heading) return wrapInline(node, src, parent, heading);
  switch (node.name) {
    // structure consumed by the parent renderers
    case "QuoteMark":
    case "ListMark":
    case "CommentBlock":
    case "LinkReference":
      return;
    case "Paragraph":
      return wrapInline(node, src, parent, "p");
    case "FencedCode":
      return renderFencedCode(node, src, parent);
    case "CodeBlock": {
      // indented code block — no info string, never highlighted
      const pre = el("pre", "md-code");
      pre.textContent = codeText(node, src);
      parent.append(pre);
      return;
    }
    case "Blockquote": {
      const bq = el("blockquote");
      renderBlocks(node, src, bq);
      parent.append(bq);
      return;
    }
    case "BulletList":
    case "OrderedList":
      return renderList(node, src, parent);
    case "HorizontalRule":
      parent.append(document.createElement("hr"));
      return;
    case "Table":
      return renderTable(node, src, parent);
    case "Task": {
      // GFM task-list item body: checkbox + the rest as inline content
      const p = el("p", "md-task");
      const marker = node.getChild("TaskMarker");
      const box = el("input") as HTMLInputElement;
      box.type = "checkbox";
      box.disabled = true;
      box.checked = !!marker && /x/i.test(slice(src, marker));
      p.append(box);
      inlineRange(node, src, p, marker ? marker.to : node.from, node.to);
      parent.append(p);
      return;
    }
    case "HTMLBlock":
      parent.append(Object.assign(el("pre", "md-html"), { textContent: slice(src, node) }));
      return;
    default:
      // unknown block — render as a paragraph rather than dropping it
      return wrapInline(node, src, parent, "p");
  }
}

function renderBlocks(node: SyntaxNode, src: string, parent: HTMLElement) {
  for (let c = node.firstChild; c; c = c.nextSibling) blockNode(c, src, parent);
}

/** Markdown document → detached DOM tree (style with .md-doc). */
export function renderMarkdownDoc(src: string): HTMLElement {
  const root = el("div", "md-doc");
  renderBlocks(parser.parse(src).topNode, src, root);
  return root;
}
