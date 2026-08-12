import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/path", () => ({ resolveResource: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: vi.fn() }));
vi.mock("./ipc", () => ({
  notificationDismiss: vi.fn(),
  notificationRequest: vi.fn(),
  notificationSend: vi.fn(),
  notificationState: vi.fn(),
  playSound: vi.fn(),
}));
vi.mock("../stores/agentTerminals", () => ({
  useAgentTerminalsStore: { getState: () => ({ terminals: {} }) },
}));
vi.mock("../stores/workspaces", () => ({
  useWorkspacesStore: { getState: () => ({ workspaces: [] }) },
}));
vi.mock("../stores/agentRuntime", () => ({
  subscribeAgentTransitions: vi.fn(),
  useAgentRuntimeStore: { getState: () => ({ states: {} }) },
}));
vi.mock("./projectNames", () => ({ projectDisplayName: () => "Project" }));

import { enqueueAgentBannerOperation } from "./agentNotifications";

describe("agent banner operation ordering", () => {
  it("waits for asynchronous add acceptance before dismissing the same identifier", async () => {
    const order: string[] = [];
    let acceptAdd!: () => void;
    const add = enqueueAgentBannerOperation("terminal-order", () => {
      order.push("add-started");
      return new Promise<void>((resolve) => {
        acceptAdd = () => {
          order.push("add-accepted");
          resolve();
        };
      });
    });
    const dismiss = enqueueAgentBannerOperation("terminal-order", async () => {
      order.push("dismissed");
    });

    await vi.waitFor(() => expect(order).toEqual(["add-started"]));
    acceptAdd();
    await Promise.all([add, dismiss]);
    expect(order).toEqual(["add-started", "add-accepted", "dismissed"]);
  });

  it("continues the identifier queue after a failed operation", async () => {
    const order: string[] = [];
    const failed = enqueueAgentBannerOperation("terminal-failure", async () => {
      order.push("failed");
      throw new Error("rejected");
    });
    const recovered = enqueueAgentBannerOperation("terminal-failure", async () => {
      order.push("recovered");
    });

    await expect(failed).rejects.toThrow("rejected");
    await expect(recovered).resolves.toBeUndefined();
    expect(order).toEqual(["failed", "recovered"]);
  });
});
