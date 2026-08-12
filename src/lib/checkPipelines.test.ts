import { describe, expect, it } from "vitest";
import {
  automaticPipelineAuthorized,
  fingerprintDecision,
  validatePipeline,
} from "./pipelineModel";
import type { TaskDef, TaskDocument } from "./tasks";

const task = (label: string, patch: Partial<TaskDef> = {}): TaskDef => ({
  label,
  command: `echo ${label}`,
  args: [],
  taskType: "shell",
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
  ...patch,
});

const doc = (...tasks: TaskDef[]): TaskDocument => ({ tasks, diagnostics: [] });

describe("check pipeline validation", () => {
  it("accepts compound roots and deduplicates shared dependencies", () => {
    const result = validatePipeline(doc(
      task("root", { command: null, group: "test", dependsOn: ["left", "right"] }),
      task("left", { dependsOn: ["shared"] }),
      task("right", { dependsOn: ["shared"] }),
      task("shared"),
    ), "root");
    expect(result.errors).toEqual([]);
    expect(result.nodes.map((value) => value.label).sort()).toEqual(["left", "right", "root", "shared"]);
  });

  it("reports cycles, missing dependencies, duplicates, background, unsupported, and active-file variables", () => {
    const result = validatePipeline(doc(
      task("root", { group: "build", dependsOn: ["cycle", "missing", "watch", "typed", "file"] }),
      task("cycle", { dependsOn: ["root"] }),
      task("watch", { isBackground: true }),
      task("typed", { supported: false, taskType: "npm" }),
      task("file", { args: ["${file}"] }),
      task("dup"), task("dup"),
    ), "root");
    expect(result.errors.join("\n")).toMatch(/cycle/i);
    expect(result.errors.join("\n")).toMatch(/Missing dependency/);
    expect(result.errors.join("\n")).toMatch(/background\/watch/);
    expect(result.errors.join("\n")).toMatch(/unsupported task type/);
    expect(result.errors.join("\n")).toMatch(/active-file variables/);
  });

  it("retains sequential dependency order metadata", () => {
    const result = validatePipeline(doc(
      task("root", { group: "test", dependsOn: ["one", "two"], dependsOrder: "sequence" }),
      task("one"), task("two"),
    ), "root");
    expect(result.root?.dependsOrder).toBe("sequence");
    expect(result.errors).toEqual([]);
  });

  it("ignores malformed unrelated tasks but rejects reachable diagnostics and variables", () => {
    const result = validatePipeline({
      tasks: [
        task("root", { group: "test", dependsOn: ["bad"] }),
        task("bad", {
          args: ["${fileWorkspaceFolder}", "${columnNumber}", "${config:thing}"],
          diagnostics: ["dependsOn must be strings"],
        }),
        task("unrelated"),
        task("unrelated"),
      ],
      diagnostics: [{ index: 99, label: null, message: "Unrelated malformed entry" }],
    }, "root");
    expect(result.errors.join("\n")).toMatch(/dependsOn must be strings/);
    expect(result.errors.join("\n")).toMatch(/active-file variables/);
    expect(result.errors.join("\n")).toMatch(/config:thing/);
    expect(result.errors.join("\n")).not.toMatch(/Duplicate task label: unrelated/);
    expect(result.errors.join("\n")).not.toMatch(/Unrelated malformed entry/);
  });
});

describe("check fingerprint stability", () => {
  it("reruns one changing pass and invalidates a second mutation", () => {
    expect(fingerprintDecision(1, "passed", "before", "after")).toBe("rerun");
    expect(fingerprintDecision(2, "passed", "before", "after")).toBe("invalidated");
    expect(fingerprintDecision(1, "passed", "same", "same")).toBe("stable");
    expect(fingerprintDecision(1, "failed", "before", "after")).toBe("stable");
  });
});

describe("automatic pipeline authorization", () => {
  const selected = { generation: 3, autoRun: true, selectedPipeline: "verify" };

  it("requires the same generation, selected root, trust, and enabled flag", () => {
    expect(automaticPipelineAuthorized(selected, "verify", 3, true)).toBe(true);
    expect(automaticPipelineAuthorized(selected, "other", 3, true)).toBe(false);
    expect(automaticPipelineAuthorized(selected, "verify", 4, true)).toBe(false);
    expect(automaticPipelineAuthorized(selected, "verify", 3, false)).toBe(false);
    expect(automaticPipelineAuthorized({ ...selected, autoRun: false }, "verify", 3, true)).toBe(false);
    expect(automaticPipelineAuthorized(undefined, "verify", 3, true)).toBe(false);
  });
});
