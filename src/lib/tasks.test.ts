import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../stores/workspaces";

const mocks = vi.hoisted(() => ({
  text: "",
}));

vi.mock("./ipc", () => ({
  fsReadFile: vi.fn(async () => ({
    binary: false,
    truncated: false,
    text: mocks.text,
  })),
}));

import { loadTaskDocument, loadTasks, shellCommandLine, type TaskDef } from "./tasks";

describe("tasks.json normalization", () => {
  beforeEach(() => {
    mocks.text = JSON.stringify({ tasks: [] });
  });

  it("retains malformed execution fields as diagnostics", async () => {
    mocks.text = JSON.stringify({
      tasks: [{
        label: "verify",
        type: "shell",
        command: "pnpm test",
        args: ["--run", 42],
        dependsOrder: "sometimes",
        isBackground: "no",
        options: {
          cwd: 12,
          env: { GOOD: "yes", "BAD-KEY": "no", ALSO_BAD: false },
        },
        group: "test",
      }],
    });

    const document = await loadTaskDocument("/repo");
    expect(document.tasks[0].diagnostics).toEqual(expect.arrayContaining([
      "args must be an array of strings",
      "dependsOrder must be parallel or sequence",
      "isBackground must be a boolean",
      "options.cwd must be a non-empty string",
      "options.env key BAD-KEY is not a valid shell identifier",
      "options.env.ALSO_BAD must be a string",
    ]));
    expect(document.tasks[0].args).toEqual([]);
    expect(document.tasks[0].env).toEqual({ GOOD: "yes" });
  });

  it("does not expose malformed commands to the legacy task runner", async () => {
    mocks.text = JSON.stringify({
      tasks: [
        { label: "safe", type: "shell", command: "pnpm test" },
        { label: "weaker-than-authored", type: "shell", command: "pnpm test", args: ["--run", 7] },
      ],
    });
    await expect(loadTasks("/repo")).resolves.toMatchObject([{ label: "safe" }]);
  });

  it("diagnoses whitespace-only task fields and dependencies", async () => {
    mocks.text = JSON.stringify({
      tasks: [
        { label: "   ", type: "shell", command: "pnpm test" },
        {
          label: "blank execution fields",
          type: " \t ",
          command: "  ",
          dependsOn: ["build", " \n"],
          options: { cwd: "   " },
        },
        {
          label: "empty dependency list",
          dependsOn: [],
        },
      ],
    });

    const document = await loadTaskDocument("/repo");
    expect(document.diagnostics.map((item) => item.message)).toEqual(expect.arrayContaining([
      "Task is missing a label",
      "type must be a non-empty string",
      "command must be a non-empty string",
      "dependsOn must be a non-empty string or an array of non-empty strings",
      "options.cwd must be a non-empty string",
    ]));
    expect(document.tasks.find((task) => task.label === "blank execution fields"))
      .toMatchObject({ command: null, dependsOn: [], cwd: null });
    await expect(loadTasks("/repo")).resolves.toEqual([]);
  });

  it("preserves valid authored whitespace after checking non-blank values", async () => {
    mocks.text = JSON.stringify({
      tasks: [{
        label: " padded label ",
        type: "shell",
        command: " echo ok ",
        dependsOn: [" padded dependency "],
      }],
    });

    const document = await loadTaskDocument("/repo");
    expect(document.tasks[0]).toMatchObject({
      label: " padded label ",
      command: " echo ok ",
      dependsOn: [" padded dependency "],
      diagnostics: [],
    });
  });
});

describe("task command semantics", () => {
  const workspace = {
    path: "/repo",
    editor: { getState: () => ({ tabs: [], activeTabId: null }) },
  } as unknown as Workspace;
  const task = (taskType: "shell" | "process", command: string): TaskDef => ({
    label: "command",
    command,
    args: ["value with spaces"],
    taskType,
    supported: true,
    dependsOn: [],
    dependsOrder: "parallel",
    isBackground: false,
    diagnostics: [],
    cwd: null,
    env: {},
    group: null,
    isDefaultBuild: false,
    detail: null,
    reveal: "always",
    panel: "shared",
  });

  it("quotes a process executable as one word but preserves shell command syntax", () => {
    expect(shellCommandLine(task("process", "/Applications/My Tool/lint"), workspace))
      .toBe("'/Applications/My Tool/lint' 'value with spaces'");
    expect(shellCommandLine(task("shell", "echo one && echo two"), workspace))
      .toBe("echo one && echo two 'value with spaces'");
  });
});
