import { describe, expect, it } from "vitest";
import {
  BUILTIN_AGENT_DEFINITIONS,
  BUILTIN_LAUNCH_PROFILES,
  definitionForProfile,
  launchCommand,
  parseEnvironmentLines,
} from "./agentDefinitions";

describe("agent launch profiles", () => {
  it("keeps codex --yolo as the visible initial default", () => {
    const definition = BUILTIN_AGENT_DEFINITIONS.find((item) => item.id === "builtin.codex")!;
    const profile = BUILTIN_LAUNCH_PROFILES.find((item) => item.id === "builtin.codex.yolo")!;
    expect(launchCommand(definition, profile).command).toContain("'--yolo'");
  });

  it("replaces yolo when the visible profile chooses explicit controls", () => {
    const definition = BUILTIN_AGENT_DEFINITIONS.find((item) => item.id === "builtin.codex")!;
    const profile = {
      ...BUILTIN_LAUNCH_PROFILES.find((item) => item.id === "builtin.codex.yolo")!,
      permissionMode: "on-request",
      sandbox: "workspace-write",
      reasoning: "high",
      environment: { TASK_TOKEN: "a b" },
    };
    const result = launchCommand(definition, profile);
    expect(result.command).not.toContain("--yolo");
    expect(result.command).toContain("'--ask-for-approval' 'on-request'");
    expect(result.command).toContain("'--sandbox' 'workspace-write'");
    expect(result.environmentPrelude).toBe("export TASK_TOKEN='a b'");
  });

  it("does not coerce a missing definition to another agent", () => {
    expect(definitionForProfile({
      ...BUILTIN_LAUNCH_PROFILES[0],
      definitionId: "removed.definition",
    })).toBeNull();
  });

  it("preserves equals signs and empty values in environment lines", () => {
    expect(parseEnvironmentLines("TOKEN=header.payload=sig\nEMPTY=\ninvalid")).toEqual({
      TOKEN: "header.payload=sig",
      EMPTY: "",
    });
  });
});
