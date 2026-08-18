import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../lib/ipc";

const { searchWorkspace } = vi.hoisted(() => ({
  searchWorkspace: vi.fn(),
}));

vi.mock("../lib/ipc", () => ({ searchWorkspace }));

import { createSearchStore } from "./search";

const emptyResult: SearchResult = {
  files: [],
  totalMatches: 0,
  truncated: false,
};

describe("Explorer search state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    searchWorkspace.mockReset();
    searchWorkspace.mockResolvedValue(emptyResult);
  });

  afterEach(() => vi.useRealTimers());

  it("keeps filename queries local and searches the same query on content mode", async () => {
    const store = createSearchStore("/repo");
    store.getState().setQuery("needle");
    await vi.advanceTimersByTimeAsync(300);
    expect(searchWorkspace).not.toHaveBeenCalled();

    store.getState().setMode("content");
    await vi.runAllTimersAsync();
    expect(searchWorkspace).toHaveBeenCalledWith(
      "/repo",
      "needle",
      false,
      false,
      false,
    );
  });

  it("debounces content typing but reruns option changes immediately", async () => {
    const store = createSearchStore("/repo");
    store.getState().setMode("content");
    store.getState().setQuery("first");
    store.getState().setQuery("second");

    await vi.advanceTimersByTimeAsync(249);
    expect(searchWorkspace).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(searchWorkspace).toHaveBeenCalledTimes(1);
    expect(searchWorkspace.mock.calls[0][1]).toBe("second");

    store.getState().toggle("caseSensitive");
    await vi.advanceTimersByTimeAsync(0);
    expect(searchWorkspace).toHaveBeenCalledTimes(2);
    expect(searchWorkspace.mock.calls[1]).toEqual([
      "/repo",
      "second",
      true,
      false,
      false,
    ]);
  });

  it("ignores an in-flight content result after switching to filename mode", async () => {
    let resolveSearch: (value: typeof emptyResult) => void = () => {};
    searchWorkspace.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSearch = resolve;
      }),
    );
    const store = createSearchStore("/repo");
    store.getState().setMode("content");
    store.getState().setQuery("old");
    await vi.advanceTimersByTimeAsync(250);
    expect(store.getState().searching).toBe(true);

    store.getState().setMode("files");
    resolveSearch({
      files: [{ file: "old.ts", matches: [] }],
      totalMatches: 1,
      truncated: false,
    });
    await Promise.resolve();

    expect(store.getState().mode).toBe("files");
    expect(store.getState().searching).toBe(false);
    expect(store.getState().results).toEqual([]);
  });
});
