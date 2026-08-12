import { afterAll, describe, expect, it, vi } from "vitest";
import type { IsolatedTask } from "./isolatedTasks";

const values = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
});

const { useIsolatedTasksStore } = await import("./isolatedTasks");

const task = (): IsolatedTask => ({
  id: "task",
  name: "Task",
  parentWorkspacePath: "/repo",
  worktreePath: "/repo-task",
  baseCommit: "base",
  branch: "vibe/task",
  agentKind: "codex",
  agentTerminalId: null,
  nativeSessionRef: null,
  plan: [],
  previewPort: 4100,
  bootstrapCommand: null,
  includeIgnored: [],
  createdAt: 1,
  updatedAt: 1,
  outcome: "active",
  checkoutRemovedAt: null,
  cleanupProvenance: "created-by-vibe",
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("isolated task outcome transitions", () => {
  it("compare-and-sets one expected outcome without accepting a stale action", () => {
    useIsolatedTasksStore.setState({ tasks: { task: task() } });

    expect(useIsolatedTasksStore.getState().transitionOutcome(
      "task",
      "active",
      "discarded",
      { checkoutRemovedAt: 10 },
    )).toBe(true);
    expect(useIsolatedTasksStore.getState().transitionOutcome(
      "task",
      "active",
      "archived",
    )).toBe(false);
    expect(useIsolatedTasksStore.getState().tasks.task).toMatchObject({
      outcome: "discarded",
      checkoutRemovedAt: 10,
    });
  });
});
