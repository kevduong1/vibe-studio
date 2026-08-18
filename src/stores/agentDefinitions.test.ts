import { describe, expect, it } from "vitest";
import {
  agentDefinitionDetectionConflict,
  agentExecutableBasename,
  BUILTIN_AGENT_DEFINITIONS,
  BUILTIN_LAUNCH_PROFILES,
  buildAgentDetectionRegistry,
  definitionForProfile,
  invalidEnvironmentLines,
  launchCommand,
  parseEnvironmentLines,
} from "./agentDefinitions";

describe("agent launch profiles", () => {
  it("keeps codex --yolo as the visible initial default", () => {
    const definition = BUILTIN_AGENT_DEFINITIONS.find((item) => item.id === "builtin.codex")!;
    const profile = BUILTIN_LAUNCH_PROFILES.find((item) => item.id === "builtin.codex.yolo")!;
    const command = launchCommand(definition, profile).command;
    expect(command).toContain("'--yolo'");
    expect(command).toContain(
      `'tui.terminal_title=["activity","thread-title","task-progress"]'`,
    );
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
    expect(parseEnvironmentLines("TOKEN=header.payload=sig\nEMPTY=\nBAD-KEY=no\ninvalid")).toEqual({
      TOKEN: "header.payload=sig",
      EMPTY: "",
    });
    expect(invalidEnvironmentLines("TOKEN=x\nBAD-KEY=no\ninvalid\n\nEMPTY=")).toEqual([2, 3]);
  });

  it("honors the definition's declared launch capabilities", () => {
    const claude = BUILTIN_AGENT_DEFINITIONS.find((item) => item.id === "builtin.claude")!;
    const profile = {
      ...BUILTIN_LAUNCH_PROFILES.find((item) => item.id === "builtin.claude.default")!,
      model: "sonnet",
      reasoning: "high",
      permissionMode: "plan",
      sandbox: "read-only",
    };
    const command = launchCommand(claude, profile).command;
    expect(command).toContain("'--model' 'sonnet'");
    expect(command).toContain("'--permission-mode' 'plan'");
    expect(command).not.toContain("reasoning");
    expect(command).not.toContain("sandbox");
  });

  it("registers custom executable basenames under their screen profile", () => {
    const custom = {
      ...BUILTIN_AGENT_DEFINITIONS[1],
      id: "custom.acme",
      executable: "/Applications/Agent Tools/acme-codex",
      builtin: false,
    };
    expect(agentExecutableBasename(custom.executable)).toBe("acme-codex");
    const registry = buildAgentDetectionRegistry([custom]);
    expect(registry.kindByExecutable.get("acme-codex")).toBe("codex");
    expect(registry.executableNames).toEqual(expect.arrayContaining(["claude", "codex", "acme-codex"]));
    expect(launchCommand(custom, BUILTIN_LAUNCH_PROFILES[1]).command)
      .not.toContain("tui.terminal_title");
  });

  it("fails closed for ambiguous custom names without disabling canonical names", () => {
    const codexAsClaude = {
      ...BUILTIN_AGENT_DEFINITIONS[0],
      id: "custom.bad-codex",
      executable: "codex",
      builtin: false,
    };
    const sharedClaude = {
      ...BUILTIN_AGENT_DEFINITIONS[0],
      id: "custom.shared-claude",
      executable: "shared-agent",
      builtin: false,
    };
    const sharedCodex = {
      ...BUILTIN_AGENT_DEFINITIONS[1],
      id: "custom.shared-codex",
      executable: "/opt/tools/shared-agent",
      builtin: false,
    };
    const registry = buildAgentDetectionRegistry([codexAsClaude, sharedClaude, sharedCodex]);
    expect(registry.conflicts).toEqual(["codex", "shared-agent"]);
    expect(registry.kindByExecutable.get("codex")).toBe("codex");
    expect(registry.kindByExecutable.has("shared-agent")).toBe(false);
    expect(agentDefinitionDetectionConflict(codexAsClaude, [codexAsClaude])).toContain("both Claude and Codex");
    expect(agentDefinitionDetectionConflict(BUILTIN_AGENT_DEFINITIONS[1], [codexAsClaude])).toBeNull();
  });
});
