import { describe, expect, it } from "vitest";
import {
  withWorktreePathsLocked,
  worktreePathOperationPending,
} from "./worktreeOperations";

describe("worktree operation queue", () => {
  it("serializes operations that share any parent or checkout path", async () => {
    const order: string[] = [];
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const first = withWorktreePathsLocked(["/repo", "/repo/task"], async () => {
      order.push("first:start");
      markFirstStarted();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first:end");
    });
    const second = withWorktreePathsLocked(["/repo/task", "/repo/child"], async () => {
      order.push("second:start");
    });

    await firstStarted;
    expect(worktreePathOperationPending("/repo/task/")).toBe(true);
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
    expect(worktreePathOperationPending("/repo/task")).toBe(false);
  });

  it("does not block operations on unrelated paths", async () => {
    let releaseFirst!: () => void;
    let secondStarted = false;
    const first = withWorktreePathsLocked(["/one"], () =>
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }));
    const second = withWorktreePathsLocked(["/two"], async () => {
      secondStarted = true;
    });

    await second;
    expect(secondStarted).toBe(true);
    releaseFirst();
    await first;
  });
});
