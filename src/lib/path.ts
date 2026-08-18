/** Shared POSIX-path helpers (macOS app — no Windows separators). */

/** Last path segment ("a/b/c", "a/b/c/" → "c"); the input when separator-free. */
export const basename = (p: string): string =>
  p.split("/").filter(Boolean).pop() ?? p;

/** Everything before the last separator ("" when there is none). */
export const dirname = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
};

/** Markdown files get the status-bar Preview toggle (EditorArea swaps the
    editor for MarkdownPreview when it's on). */
export const isMarkdownPath = (p: string): boolean =>
  /\.(md|markdown|mdown|mkd)$/i.test(p);

/** Raster formats rendered by ImagePreview. SVG stays in the text editor so
    active content is never introduced through the image preview path. */
export const isImagePath = (p: string): boolean =>
  /\.(png|apng|jpe?g|jfif|gif|webp|bmp|ico|avif|tiff?)$/i.test(p);
