import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gitInit: vi.fn(),
  gitStatus: vi.fn(),
  gitStashList: vi.fn(),
  gitLog: vi.fn(),
  onRepoChanged: vi.fn(),
  watchRepo: vi.fn(),
  unwatchRepo: vi.fn(),
}));

vi.mock("../lib/ipc", () => ({
  gitCheckout: vi.fn(),
  gitCherryPick: vi.fn(),
  gitCommit: vi.fn(),
  gitCreateBranch: vi.fn(),
  gitDiscard: vi.fn(),
  gitFetch: vi.fn(),
  gitInit: mocks.gitInit,
  gitLog: mocks.gitLog,
  gitPull: vi.fn(),
  gitPush: vi.fn(),
  gitRebase: vi.fn(),
  gitReset: vi.fn(),
  gitSquash: vi.fn(),
  gitStage: vi.fn(),
  gitStashApply: vi.fn(),
  gitStashDrop: vi.fn(),
  gitStashList: mocks.gitStashList,
  gitStashPop: vi.fn(),
  gitStashSave: vi.fn(),
  gitStatus: mocks.gitStatus,
  gitUnstage: vi.fn(),
  onRepoChanged: mocks.onRepoChanged,
  unwatchRepo: mocks.unwatchRepo,
  watchRepo: mocks.watchRepo,
}));

import { createRepoStore } from "./repo";

const status = {
  branch: { name: "main", detached: false, ahead: 0, behind: 0 },
  staged: [],
  unstaged: [{ path: "notes.txt", status: "?" as const }],
};

describe("optional repository store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.onRepoChanged.mockResolvedValue(vi.fn());
    mocks.watchRepo.mockResolvedValue(undefined);
    mocks.unwatchRepo.mockResolvedValue(undefined);
    mocks.gitStatus.mockResolvedValue(status);
    mocks.gitStashList.mockResolvedValue([]);
    mocks.gitLog.mockResolvedValue({ commits: [], hasMore: false });
  });

  it("watches an ordinary folder without issuing Git reads", async () => {
    const store = createRepoStore("/workspace", false, vi.fn());

    await store.getState().init();

    expect(mocks.watchRepo).toHaveBeenCalledWith("/workspace");
    expect(mocks.gitStatus).not.toHaveBeenCalled();
    expect(store.getState().isGitRepository).toBe(false);
    store.getState().dispose();
  });

  it("initializes Git in place and enables repository state", async () => {
    const onInitialized = vi.fn();
    mocks.gitInit.mockResolvedValue({
      root: "/workspace",
      tabGroupId: "gitdir:/workspace/.git",
    });
    const store = createRepoStore("/workspace", false, onInitialized);
    await store.getState().init();

    await expect(store.getState().initialize()).resolves.toBe(true);

    expect(mocks.gitInit).toHaveBeenCalledWith("/workspace");
    expect(onInitialized).toHaveBeenCalledWith({
      root: "/workspace",
      tabGroupId: "gitdir:/workspace/.git",
    });
    expect(store.getState().isGitRepository).toBe(true);
    expect(store.getState().status).toEqual(status);
    store.getState().dispose();
  });

  it("keeps the folder open when initialization fails", async () => {
    mocks.gitInit.mockRejectedValue(new Error("permission denied"));
    const store = createRepoStore("/workspace", false, vi.fn());

    await expect(store.getState().initialize()).resolves.toBe(false);

    expect(store.getState().isGitRepository).toBe(false);
    expect(store.getState().error).toContain("permission denied");
  });
});
