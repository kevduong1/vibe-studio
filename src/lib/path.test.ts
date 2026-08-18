import { describe, expect, it } from "vitest";
import { isImagePath, isMarkdownPath } from "./path";

describe("file preview paths", () => {
  it("recognizes markdown paths case-insensitively", () => {
    expect(isMarkdownPath("docs/README.MD")).toBe(true);
    expect(isMarkdownPath("docs/readme.txt")).toBe(false);
  });

  it("recognizes supported raster images without treating SVG as an image", () => {
    for (const path of [
      "art.PNG",
      "photo.jpeg",
      "animation.gif",
      "texture.webp",
      "icon.ico",
      "scan.tiff",
    ]) {
      expect(isImagePath(path)).toBe(true);
    }
    expect(isImagePath("vector.svg")).toBe(false);
    expect(isImagePath("not-an-image.png.txt")).toBe(false);
  });
});
