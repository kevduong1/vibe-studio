import type { TaskDef, TaskDocument } from "./tasks";

export interface PipelineValidation {
  root: TaskDef | null;
  nodes: TaskDef[];
  errors: string[];
}

export const automaticPipelineAuthorized = (
  task: { generation: number; autoRun: boolean; selectedPipeline: string | null } | undefined,
  rootLabel: string,
  generation: number,
  trusted: boolean,
): boolean => Boolean(
  trusted &&
  task &&
  task.generation === generation &&
  task.autoRun &&
  task.selectedPipeline === rootLabel,
);

export function fingerprintDecision(
  attempt: 1 | 2,
  status: string,
  before: string,
  after: string,
): "stable" | "rerun" | "invalidated" {
  if (status !== "passed" || before === after) return "stable";
  return attempt === 1 ? "rerun" : "invalidated";
}

const ACTIVE_FILE_VARIABLES = new Set([
  "file",
  "fileWorkspaceFolder",
  "relativeFile",
  "relativeFileDirname",
  "fileBasename",
  "fileDirname",
  "fileDirnameBasename",
  "fileExtname",
  "fileBasenameNoExtension",
  "selectedText",
  "lineNumber",
  "columnNumber",
]);
const CHECK_VARIABLES = new Set([
  "workspaceFolder",
  "workspaceRoot",
  "workspaceFolderBasename",
  "cwd",
  "pathSeparator",
  "userHome",
]);
const VARIABLE = /\$\{([^}]+)\}/g;

const taskValues = (task: TaskDef): string[] =>
  [task.command ?? "", ...task.args, task.cwd ?? "", ...Object.values(task.env)];

const usesActiveFileVariable = (task: TaskDef): boolean =>
  taskValues(task).some((value) =>
    [...value.matchAll(VARIABLE)].some((match) => ACTIVE_FILE_VARIABLES.has(match[1])),
  );

const unsupportedVariables = (task: TaskDef): string[] => {
  const names = taskValues(task).flatMap((value) =>
    [...value.matchAll(VARIABLE)].map((match) => match[1]),
  );
  return [...new Set(names.filter((name) =>
    !ACTIVE_FILE_VARIABLES.has(name) &&
    !CHECK_VARIABLES.has(name) &&
    !/^env:[A-Za-z_]\w*$/.test(name),
  ))];
};

export const selectablePipelineRoots = (document: TaskDocument): TaskDef[] =>
  document.tasks.filter((task) => task.group === "build" || task.group === "test");

export function validatePipeline(document: TaskDocument, rootLabel: string): PipelineValidation {
  const errors: string[] = [];
  const candidates = new Map<string, TaskDef[]>();
  for (const task of document.tasks) {
    candidates.set(task.label, [...(candidates.get(task.label) ?? []), task]);
  }
  const rootCandidates = candidates.get(rootLabel) ?? [];
  const root = rootCandidates.length === 1 ? rootCandidates[0] : null;
  if (rootCandidates.length > 1) errors.push(`Duplicate task label: ${rootLabel}`);
  else if (!root) errors.push(`Missing pipeline root: ${rootLabel}`);

  const nodes: TaskDef[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (label: string, chain: string[]) => {
    const matches = candidates.get(label) ?? [];
    if (matches.length > 1) {
      errors.push(`Duplicate task label: ${label}`);
      return;
    }
    const task = matches[0];
    if (!task) {
      errors.push(`Missing dependency: ${[...chain, label].join(" → ")}`);
      return;
    }
    if (visiting.has(label)) {
      errors.push(`Task dependency cycle: ${[...chain, label].join(" → ")}`);
      return;
    }
    if (visited.has(label)) return;
    visiting.add(label);
    for (const diagnostic of task.diagnostics) errors.push(`${label}: ${diagnostic}`);
    if (!task.supported) errors.push(`${label}: unsupported task type ${task.taskType}`);
    if (task.isBackground) errors.push(`${label}: background/watch tasks cannot be checked safely`);
    if (usesActiveFileVariable(task)) errors.push(`${label}: active-file variables are not supported in checks`);
    const unsupported = unsupportedVariables(task);
    if (unsupported.length) errors.push(`${label}: unsupported variables: ${unsupported.map((name) => `\${${name}}`).join(", ")}`);
    for (const dependency of task.dependsOn) walk(dependency, [...chain, label]);
    visiting.delete(label);
    visited.add(label);
    nodes.push(task);
  };
  if (root) walk(root.label, []);
  return { root, nodes, errors: [...new Set(errors)] };
}
