import { create } from "zustand";
import type { AgentKind } from "../lib/agentState";
import { AGENT_PROFILES } from "../lib/agentProfiles";
import { codexTerminalTitleArguments } from "../lib/codexTerminalTitle";

const STORAGE_KEY = "talos:agent-definitions";

export interface AgentDefinition {
  id: string;
  name: string;
  executable: string;
  defaultArguments: string[];
  transport: "terminal";
  detectionProfile: AgentKind;
  resumeSupport: "none" | "native-cli";
  capabilities: {
    models: boolean;
    reasoning: boolean;
    permissions: boolean;
    sandbox: boolean;
    subagents: boolean;
  };
  builtin: boolean;
}

export interface AgentLaunchProfile {
  id: string;
  name: string;
  definitionId: string;
  model: string | null;
  reasoning: string | null;
  permissionMode: string | null;
  sandbox: string | null;
  environment: Record<string, string>;
  extraArguments: string[];
  folderChoice: "current" | "new-worktree";
  builtin: boolean;
}

export const BUILTIN_AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    id: "builtin.claude",
    name: "Claude Code",
    executable: "claude",
    defaultArguments: [],
    transport: "terminal",
    detectionProfile: "claude",
    resumeSupport: "native-cli",
    capabilities: { models: true, reasoning: false, permissions: true, sandbox: false, subagents: true },
    builtin: true,
  },
  {
    id: "builtin.codex",
    name: "Codex CLI",
    executable: "codex",
    // Intentional product default, represented visibly in the definition.
    defaultArguments: ["--yolo"],
    transport: "terminal",
    detectionProfile: "codex",
    resumeSupport: "native-cli",
    capabilities: { models: true, reasoning: true, permissions: true, sandbox: true, subagents: true },
    builtin: true,
  },
];

export const BUILTIN_LAUNCH_PROFILES: AgentLaunchProfile[] = [
  {
    id: "builtin.claude.default",
    name: "Claude — Default",
    definitionId: "builtin.claude",
    model: null,
    reasoning: null,
    permissionMode: null,
    sandbox: null,
    environment: {},
    extraArguments: [],
    folderChoice: "current",
    builtin: true,
  },
  {
    id: "builtin.codex.yolo",
    name: "Codex — Full Auto",
    definitionId: "builtin.codex",
    model: null,
    reasoning: null,
    permissionMode: null,
    sandbox: null,
    environment: {},
    extraArguments: [],
    folderChoice: "current",
    builtin: true,
  },
];

interface AgentDefinitionsState {
  customDefinitions: AgentDefinition[];
  customProfiles: AgentLaunchProfile[];
  upsertProfile: (profile: AgentLaunchProfile) => void;
  upsertDefinition: (definition: AgentDefinition) => void;
}

const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const validDefinition = (value: unknown): value is AgentDefinition => {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const capabilities = item.capabilities as Record<string, unknown> | null;
  return (
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    typeof item.executable === "string" &&
    Array.isArray(item.defaultArguments) &&
    item.defaultArguments.every((argument) => typeof argument === "string") &&
    item.transport === "terminal" &&
    (item.detectionProfile === "claude" || item.detectionProfile === "codex") &&
    (item.resumeSupport === "none" || item.resumeSupport === "native-cli") &&
    Boolean(capabilities) &&
    ["models", "reasoning", "permissions", "sandbox", "subagents"].every(
      (key) => typeof capabilities?.[key] === "boolean",
    ) &&
    item.builtin === false
  );
};

const validProfile = (value: unknown): value is AgentLaunchProfile => {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const environment = item.environment as Record<string, unknown> | null;
  return (
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    typeof item.definitionId === "string" &&
    nullableString(item.model) &&
    nullableString(item.reasoning) &&
    nullableString(item.permissionMode) &&
    nullableString(item.sandbox) &&
    Boolean(environment) &&
    !Array.isArray(environment) &&
    Object.values(environment ?? {}).every((entry) => typeof entry === "string") &&
    Array.isArray(item.extraArguments) &&
    item.extraArguments.every((argument) => typeof argument === "string") &&
    (item.folderChoice === "current" || item.folderChoice === "new-worktree") &&
    item.builtin === false
  );
};

const load = (): Pick<AgentDefinitionsState, "customDefinitions" | "customProfiles"> => {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Record<string, unknown> | null;
    return {
      customDefinitions: Array.isArray(parsed?.definitions)
        ? parsed.definitions.filter(validDefinition)
        : [],
      customProfiles: Array.isArray(parsed?.profiles)
        ? parsed.profiles.filter(validProfile)
        : [],
    };
  } catch {
    return { customDefinitions: [], customProfiles: [] };
  }
};

export const useAgentDefinitionsStore = create<AgentDefinitionsState>((set) => ({
  ...load(),
  upsertProfile: (profile) =>
    set((state) => ({
      customProfiles: [
        ...state.customProfiles.filter((item) => item.id !== profile.id),
        { ...profile, builtin: false },
      ],
    })),
  upsertDefinition: (definition) =>
    set((state) => ({
      customDefinitions: [
        ...state.customDefinitions.filter((item) => item.id !== definition.id),
        { ...definition, builtin: false },
      ],
    })),
}));

useAgentDefinitionsStore.subscribe((state, previous) => {
  if (
    state.customDefinitions !== previous.customDefinitions ||
    state.customProfiles !== previous.customProfiles
  ) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      definitions: state.customDefinitions,
      profiles: state.customProfiles,
    }));
  }
});

export const allAgentDefinitions = (): AgentDefinition[] => [
  ...BUILTIN_AGENT_DEFINITIONS,
  ...useAgentDefinitionsStore.getState().customDefinitions,
];

export interface AgentDetectionRegistry {
  executableNames: string[];
  kindByExecutable: ReadonlyMap<string, AgentKind>;
  /** Basenames mapped to both screen profiles are never guessed. Ambiguous
   * custom names are excluded; canonical names retain their built-in mapping.
   * Settings exposes every conflict so the configuration can be repaired. */
  conflicts: string[];
}

/** `ps comm` is reduced to its basename by the backend, so definitions must
 * participate in detection under the same exact, argument-free identity. */
export const agentExecutableBasename = (executable: string): string | null => {
  const normalized = executable.trim().replaceAll("\\", "/");
  const name = normalized.split("/").pop()?.trim() ?? "";
  return name && name !== "." && name !== ".." ? name : null;
};

export function buildAgentDetectionRegistry(
  definitions: readonly AgentDefinition[] = allAgentDefinitions(),
): AgentDetectionRegistry {
  const canonical = new Map<string, AgentKind>();
  const customCandidates = new Map<string, Set<AgentKind>>();
  const conflicts = new Set<string>();
  const add = (name: string, kind: AgentKind) => {
    const kinds = customCandidates.get(name) ?? new Set<AgentKind>();
    kinds.add(kind);
    customCandidates.set(name, kinds);
  };
  for (const profile of Object.values(AGENT_PROFILES)) {
    for (const name of profile.executableNames) canonical.set(name, profile.kind);
  }
  for (const definition of definitions) {
    const name = agentExecutableBasename(definition.executable);
    if (!name) continue;
    const canonicalKind = canonical.get(name);
    if (canonicalKind) {
      if (canonicalKind !== definition.detectionProfile) conflicts.add(name);
    } else {
      add(name, definition.detectionProfile);
    }
  }
  const kindByExecutable = new Map<string, AgentKind>(canonical);
  for (const [name, kinds] of customCandidates) {
    if (kinds.size === 1) kindByExecutable.set(name, [...kinds][0]);
    else conflicts.add(name);
  }
  return {
    executableNames: [...kindByExecutable.keys()].sort(),
    kindByExecutable,
    conflicts: [...conflicts].sort(),
  };
}

export const agentDefinitionDetectionConflict = (
  definition: AgentDefinition,
  definitions: readonly AgentDefinition[] = allAgentDefinitions(),
): string | null => {
  const name = agentExecutableBasename(definition.executable);
  if (!name) return "Executable must include a valid basename.";
  const canonicalKind = Object.values(AGENT_PROFILES).find((profile) =>
    profile.executableNames.includes(name)
  )?.kind;
  const kinds = canonicalKind
    ? new Set<AgentKind>([canonicalKind, definition.detectionProfile])
    : new Set<AgentKind>([
        ...definitions
          .filter((item) => item.id !== definition.id)
          .filter((item) => agentExecutableBasename(item.executable) === name)
          .map((item) => item.detectionProfile),
        definition.detectionProfile,
      ]);
  return kinds.size > 1
    ? `Executable basename “${name}” is assigned to both Claude and Codex detection.`
    : null;
};

export const allLaunchProfiles = (): AgentLaunchProfile[] => [
  ...BUILTIN_LAUNCH_PROFILES,
  ...useAgentDefinitionsStore.getState().customProfiles,
];

/** Missing definition IDs stay missing; never coerce to another agent. */
export const definitionForProfile = (
  profile: AgentLaunchProfile,
): AgentDefinition | null =>
  allAgentDefinitions().find((definition) => definition.id === profile.definitionId) ?? null;

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

export function parseEnvironmentLines(value: string): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const line of value.split("\n")) {
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      entries.push([key, line.slice(separator + 1)]);
    }
  }
  return Object.fromEntries(entries);
}

export function invalidEnvironmentLines(value: string): number[] {
  return value.split("\n").flatMap((line, index) => {
    if (!line.trim()) return [];
    const separator = line.indexOf("=");
    const key = separator > 0 ? line.slice(0, separator).trim() : "";
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? [] : [index + 1];
  });
}

export function launchCommand(
  definition: AgentDefinition,
  profile: AgentLaunchProfile,
): { command: string; environmentPrelude: string | null } {
  const args = [
    ...(definition.id === "builtin.codex" ? codexTerminalTitleArguments() : []),
    ...definition.defaultArguments.filter(
      (argument) =>
        !(
          argument === "--yolo" &&
          definition.detectionProfile === "codex" &&
          ((profile.permissionMode && definition.capabilities.permissions) ||
            (profile.sandbox && definition.capabilities.sandbox))
        ),
    ),
  ];
  if (profile.model && definition.capabilities.models) args.push("--model", profile.model);
  if (
    profile.reasoning &&
    definition.capabilities.reasoning &&
    definition.detectionProfile === "codex"
  ) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(profile.reasoning)}`);
  }
  if (profile.permissionMode && definition.capabilities.permissions) {
    args.push(
      definition.detectionProfile === "codex" ? "--ask-for-approval" : "--permission-mode",
      profile.permissionMode,
    );
  }
  if (
    profile.sandbox &&
    definition.capabilities.sandbox &&
    definition.detectionProfile === "codex"
  ) {
    args.push("--sandbox", profile.sandbox);
  }
  args.push(...profile.extraArguments);
  const environment = Object.entries(profile.environment)
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .map(([key, value]) => `${key}=${quote(value)}`);
  return {
    command: [definition.executable, ...args].map(quote).join(" "),
    environmentPrelude: environment.length > 0 ? `export ${environment.join(" ")}` : null,
  };
}
