import { describe, expect, it, vi } from "vitest";

vi.mock("./ui", () => ({
  useUiStore: {
    getState: () => ({ setPanelMaximized: () => {} }),
  },
}));

import { createEditorStore } from "./editor";

const diff = (path: string) => ({
  repoPath: "/repo",
  path,
  kind: "worktree" as const,
});

describe("editor tab lifecycle", () => {
  it("reuses one clean provisional slot across files and diffs", () => {
    const editor = createEditorStore();
    editor.getState().previewFile("/repo/a.ts");
    expect(editor.getState().tabs.map((tab) => tab.id)).toEqual(["file:/repo/a.ts"]);

    editor.getState().previewFile("/repo/b.ts");
    expect(editor.getState().tabs.map((tab) => tab.id)).toEqual(["file:/repo/b.ts"]);

    editor.getState().previewDiff(diff("b.ts"));
    expect(editor.getState().tabs).toHaveLength(1);
    expect(editor.getState().tabs[0].kind).toBe("diff");
  });

  it("keeps pinned tabs while continuing to reuse one provisional slot", () => {
    const editor = createEditorStore();
    editor.getState().previewFile("/repo/a.ts");
    editor.getState().openFile("/repo/a.ts"); // explorer/tab double-click

    editor.getState().previewFile("/repo/b.ts");
    expect(editor.getState().tabs.map((tab) => tab.title)).toEqual(["a.ts", "b.ts"]);
    expect(editor.getState().transientTabId).toBe("file:/repo/b.ts");

    editor.getState().previewDiff(diff("c.ts"));
    expect(editor.getState().tabs.map((tab) => tab.title)).toEqual(["a.ts", "c.ts"]);
    expect(editor.getState().tabs[1].kind).toBe("diff");
  });

  it("pins provisional tabs on explicit open or edit", () => {
    const editor = createEditorStore();
    editor.getState().previewFile("/repo/a.ts");
    editor.getState().openFile("/repo/a.ts");
    expect(editor.getState().transientTabId).toBeNull();

    editor.getState().previewFile("/repo/b.ts");
    editor.getState().markDirty("file:/repo/b.ts", true);
    expect(editor.getState().transientTabId).toBeNull();

    editor.getState().previewFile("/repo/c.ts");
    expect(editor.getState().tabs.map((tab) => tab.id)).toEqual([
      "file:/repo/a.ts",
      "file:/repo/b.ts",
      "file:/repo/c.ts",
    ]);
  });

  it("does not promote a provisional tab for editor-internal transactions", () => {
    const editor = createEditorStore();
    editor.getState().previewFile("/repo/a.ts");
    editor.getState().markDirty("file:/repo/a.ts", true, false);
    expect(editor.getState().transientTabId).toBe("file:/repo/a.ts");

    // A later genuine user edit must still promote it even though the dirty
    // bit was already set by the internal transaction.
    editor.getState().markDirty("file:/repo/a.ts", true, true);
    expect(editor.getState().transientTabId).toBeNull();
  });

  it("reorders, cycles, closes, and reopens durable tabs", () => {
    const editor = createEditorStore();
    editor.getState().openFile("/repo/a.ts");
    editor.getState().openFile("/repo/b.ts");
    editor.getState().openFile("/repo/c.ts");
    editor.getState().moveTab("file:/repo/c.ts", 0);
    expect(editor.getState().tabs.map((tab) => tab.title)).toEqual(["c.ts", "a.ts", "b.ts"]);

    editor.getState().activateRelative(1);
    expect(editor.getState().activeTabId).toBe("file:/repo/a.ts");
    editor.getState().closeTab("file:/repo/a.ts");
    expect(editor.getState().activeTabId).toBe("file:/repo/b.ts");
    editor.getState().reopenClosedTab();
    expect(editor.getState().activeTabId).toBe("file:/repo/a.ts");
  });

  it("hydrates only a valid active tab from a session snapshot", () => {
    const tab = { id: "file:/repo/a.ts", kind: "file" as const, path: "/repo/a.ts", title: "a.ts" };
    const editor = createEditorStore({ tabs: [tab], activeTabId: "missing", recentFiles: [tab.path] });
    expect(editor.getState().activeTabId).toBe(tab.id);
    expect(editor.getState().recentFiles).toEqual([tab.path]);
  });
});
