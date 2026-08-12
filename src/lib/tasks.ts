/**
 * VS Code-compatible task definitions (.vscode/tasks.json): JSONC parsing,
 * ${variable} substitution, and shell command-line assembly. Tasks are
 * re-read from disk on every use (⌘⇧B) so edits apply without a watcher;
 * execution glue lives in lib/taskRunner.ts.
 *
 * Supported subset: "shell" / "process" tasks,
 * label/command/args/options.{cwd,env}/group/detail,
 * presentation.{reveal,panel}, dependency DAG metadata, and the `osx`
 * platform override (always merged — this is a macOS app). Unsupported and
 * malformed entries are retained as parse diagnostics for review pipelines.
 */
import { fsReadFile } from "./ipc";
import { basename } from "./path";
import type { Workspace } from "../stores/workspaces";

export interface TaskDef {
  label: string;
  command: string | null;
  args: string[];
  taskType: string;
  supported: boolean;
  dependsOn: string[];
  dependsOrder: "parallel" | "sequence";
  isBackground: boolean;
  /** Entry-local parse/normalization diagnostics. */
  diagnostics: string[];
  /** Working directory (may be ${}-templated; relative = workspace root). */
  cwd: string | null;
  env: Record<string, string>;
  /** Group kind: "build", "test", … */
  group: string | null;
  /** group: { kind: "build", isDefault: true } — ⌘⇧B runs it without asking. */
  isDefaultBuild: boolean;
  detail: string | null;
  reveal: "always" | "silent" | "never";
  panel: "shared" | "dedicated" | "new";
}

export interface TaskParseDiagnostic {
  index: number;
  label: string | null;
  message: string;
}

export interface TaskDocument {
  tasks: TaskDef[];
  diagnostics: TaskParseDiagnostic[];
}

/**
 * Strip JSONC comments and trailing commas (tasks.json allows both). Each
 * pass matches string literals FIRST so comment markers / commas inside
 * strings are never touched.
 */
const stripJsonc = (s: string): string =>
  s
    .replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) =>
      m[0] === '"' ? m : "",
    )
    .replace(/"(?:[^"\\]|\\.)*"|,(?=\s*[}\]])/g, (m) => (m === "," ? "" : m));

const isNonBlankString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** Validate presence without normalizing the user's authored value. */
const str = (value: unknown): string | null =>
  isNonBlankString(value) ? value : null;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

/** One raw tasks.json entry. Compound tasks may omit command. */
const normalizeTask = (
  raw: unknown,
  index: number,
): { task?: TaskDef; diagnostics: TaskParseDiagnostic[] } => {
  if (!raw || typeof raw !== "object") {
    return { diagnostics: [{ index, label: null, message: "Task must be an object" }] };
  }
  const base = raw as Record<string, unknown>;
  const osx = obj(base.osx);
  const t = { ...base, ...osx };

  const type = str(t.type) ?? "shell";
  const label = str(t.label);
  const command = str(t.command);
  if (!label) {
    return { diagnostics: [{ index, label: null, message: "Task is missing a label" }] };
  }
  const diagnostics: TaskParseDiagnostic[] = [];
  const diagnose = (message: string) => diagnostics.push({ index, label, message });
  if (Object.prototype.hasOwnProperty.call(t, "type") && !str(t.type)) {
    diagnose("type must be a non-empty string");
  }
  if (Object.prototype.hasOwnProperty.call(t, "command") && !str(t.command)) {
    diagnose("command must be a non-empty string");
  }
  let dependsOn: string[] = [];
  if (Object.prototype.hasOwnProperty.call(t, "dependsOn")) {
    if (isNonBlankString(t.dependsOn)) {
      dependsOn = [t.dependsOn];
    } else if (
      Array.isArray(t.dependsOn) &&
      t.dependsOn.length > 0 &&
      t.dependsOn.every(isNonBlankString)
    ) {
      dependsOn = t.dependsOn;
    } else {
      diagnostics.push({
        index,
        label,
        message: "dependsOn must be a non-empty string or an array of non-empty strings",
      });
    }
  }
  const supported = type === "shell" || type === "process";
  if (!command && dependsOn.length === 0) {
    diagnose("Task needs a command or dependency");
  }

  let args: string[] = [];
  if (Object.prototype.hasOwnProperty.call(t, "args")) {
    if (Array.isArray(t.args) && t.args.every((value) => typeof value === "string")) {
      args = t.args;
    } else {
      diagnose("args must be an array of strings");
    }
  }

  if (
    Object.prototype.hasOwnProperty.call(t, "dependsOrder") &&
    t.dependsOrder !== "parallel" &&
    t.dependsOrder !== "sequence"
  ) diagnose("dependsOrder must be parallel or sequence");
  if (Object.prototype.hasOwnProperty.call(t, "isBackground") && typeof t.isBackground !== "boolean") {
    diagnose("isBackground must be a boolean");
  }

  const options = { ...obj(base.options), ...obj(osx.options) };
  if (Object.prototype.hasOwnProperty.call(t, "options") && (!t.options || typeof t.options !== "object" || Array.isArray(t.options))) {
    diagnose("options must be an object");
  }
  const cwd = str(options.cwd);
  if (Object.prototype.hasOwnProperty.call(options, "cwd") && !cwd) {
    diagnose("options.cwd must be a non-empty string");
  }
  // env merges per-KEY across the osx override (VS Code semantics), unlike
  // the per-property options spread above. Keys must be plain identifiers:
  // they're spliced unquoted into `export K=…`, where a key like "MY-VAR"
  // would be a parse error that aborts the whole &&-chained line.
  const env: Record<string, string> = {};
  const rawBaseEnv = obj(base.options).env;
  const rawOsxEnv = obj(osx.options).env;
  if (
    (Object.prototype.hasOwnProperty.call(obj(base.options), "env") &&
      (!rawBaseEnv || typeof rawBaseEnv !== "object" || Array.isArray(rawBaseEnv))) ||
    (Object.prototype.hasOwnProperty.call(obj(osx.options), "env") &&
      (!rawOsxEnv || typeof rawOsxEnv !== "object" || Array.isArray(rawOsxEnv)))
  ) diagnose("options.env must be an object of string values");
  for (const [k, v] of Object.entries({
    ...obj(obj(base.options).env),
    ...obj(obj(osx.options).env),
  })) {
    if (typeof v !== "string") {
      diagnose(`options.env.${k} must be a string`);
    } else if (!/^[A-Za-z_]\w*$/.test(k)) {
      diagnose(`options.env key ${k} is not a valid shell identifier`);
    } else {
      env[k] = v;
    }
  }

  const g = t.group;
  const group =
    typeof g === "string"
      ? g
      : g && typeof g === "object"
        ? str((g as Record<string, unknown>).kind)
        : null;
  const isDefaultBuild =
    group === "build" &&
    !!g &&
    typeof g === "object" &&
    (g as Record<string, unknown>).isDefault === true;

  const pres = (
    t.presentation && typeof t.presentation === "object" ? t.presentation : {}
  ) as Record<string, unknown>;

  return { task: {
    label,
    command,
    taskType: type,
    supported,
    dependsOn,
    dependsOrder: t.dependsOrder === "sequence" ? "sequence" : "parallel",
    isBackground: t.isBackground === true,
    diagnostics: diagnostics.map((diagnostic) => diagnostic.message),
    args,
    cwd,
    env,
    group,
    isDefaultBuild,
    detail: str(t.detail),
    reveal:
      pres.reveal === "silent" || pres.reveal === "never" ? pres.reveal : "always",
    panel:
      pres.panel === "dedicated" || pres.panel === "new" ? pres.panel : "shared",
  }, diagnostics };
};

/**
 * Read + parse <root>/.vscode/tasks.json. A missing file is just "no tasks"
 * ([]); a present but unreadable/unparseable file throws so the picker can
 * surface it instead of claiming the file doesn't exist.
 */
export async function loadTaskDocument(workspaceRoot: string): Promise<TaskDocument> {
  let text: string;
  try {
    const f = await fsReadFile(`${workspaceRoot}/.vscode/tasks.json`);
    if (f.binary || f.truncated)
      throw new Error("Cannot read .vscode/tasks.json: binary or too large");
    text = f.text;
  } catch (e) {
    // Only ENOENT means "no tasks" — fs_read_file gives us io::Error strings,
    // so match the stable "(os error 2)" suffix. Permission errors and the
    // size/encoding throw above propagate to the picker.
    if (/os error 2\b/.test(String(e))) return { tasks: [], diagnostics: [] };
    throw e;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(stripJsonc(text));
  } catch (e) {
    throw new Error(`Cannot parse .vscode/tasks.json: ${String(e)}`);
  }
  const list =
    doc && typeof doc === "object" ? (doc as { tasks?: unknown }).tasks : null;
  if (!Array.isArray(list)) return { tasks: [], diagnostics: [] };
  const normalized = list.map(normalizeTask);
  return {
    tasks: normalized.flatMap((item) => item.task ? [item.task] : []),
    diagnostics: normalized.flatMap((item) => item.diagnostics),
  };
}

export async function loadTasks(workspaceRoot: string): Promise<TaskDef[]> {
  // The legacy ⌘⇧B runner executes one command directly; compound roots and
  // unsupported types belong to the review-pipeline DAG engine.
  return (await loadTaskDocument(workspaceRoot)).tasks.filter(
    (task) => task.supported && !!task.command && task.diagnostics.length === 0,
  );
}

/** Picker order: default build first, then other build tasks, then the rest. */
export const sortForPicker = (tasks: TaskDef[]): TaskDef[] =>
  [...tasks].sort(
    (a, b) =>
      Number(b.isDefaultBuild) - Number(a.isDefaultBuild) ||
      Number(b.group === "build") - Number(a.group === "build"),
  );

/** The ${var} substitution table (file variables come from the active editor
 *  tab). ${env:NAME}/${userHome} are NOT table entries — they become shell
 *  expansions, handled per call site so quoting can keep them expandable. */
const varTable = (ws: Workspace): Record<string, string | null> => {
  const editor = ws.editor.getState();
  const active = editor.tabs.find((t) => t.id === editor.activeTabId);
  const file = active?.kind === "file" ? active.path : null;
  const fileBase = file ? basename(file) : null;
  return {
    workspaceFolder: ws.path,
    workspaceRoot: ws.path, // legacy alias
    workspaceFolderBasename: basename(ws.path),
    cwd: ws.path,
    pathSeparator: "/",
    file,
    relativeFile:
      file && file.startsWith(`${ws.path}/`) ? file.slice(ws.path.length + 1) : file,
    fileBasename: fileBase,
    fileDirname: file ? file.slice(0, file.lastIndexOf("/")) || "/" : null,
    fileExtname: fileBase ? (/\.[^.]+$/.exec(fileBase)?.[0] ?? "") : null,
    fileBasenameNoExtension: fileBase ? fileBase.replace(/\.[^.]+$/, "") : null,
  };
};

const VAR_RE = /\$\{([^}]+)\}/g;

/** ${env:NAME}/${userHome} → the shell variable to defer to (the command
 *  runs through the user's shell, which knows the environment), else null. */
const shellVar = (name: string): string | null =>
  name.startsWith("env:") ? name.slice(4) : name === "userHome" ? "HOME" : null;

/**
 * Resolve VS Code ${variables} into plain text; env:/userHome become bare
 * $NAME expansions, so this is only safe where the result is NOT quoted
 * (the command). Unknown/unavailable variables are left verbatim.
 */
const substitute = (s: string, ws: Workspace): string => {
  const vars = varTable(ws);
  return s.replace(VAR_RE, (whole, name: string) => {
    const sh = shellVar(name);
    return sh ? `$${sh}` : (vars[name] ?? whole);
  });
};

/** Single-quote a shell word unless it's plainly safe as-is. A leading "="
 *  is quoted even though "=" is safe elsewhere — interactive zsh rewrites an
 *  unquoted leading-= word to its $PATH location (EQUALS expansion). */
const quote = (s: string): string =>
  /^[\w./:@%+,-][\w./:=@%+,-]*$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;

/**
 * Resolve ${variables} AND quote the result as ONE shell word. Literal text
 * is quote()d; env:/userHome become double-quoted "$NAME" segments so the
 * shell still expands them — a plain quote(substitute(s)) would single-quote
 * the rewritten $NAME and pass it as literal text.
 */
const substituteWord = (s: string, ws: Workspace): string => {
  const vars = varTable(ws);
  const parts: string[] = [];
  let lit = "";
  let last = 0;
  for (const m of s.matchAll(VAR_RE)) {
    lit += s.slice(last, m.index);
    last = m.index + m[0].length;
    const sh = shellVar(m[1]);
    if (sh) {
      if (lit) parts.push(quote(lit));
      lit = "";
      parts.push(`"$${sh}"`);
    } else {
      lit += vars[m[1]] ?? m[0];
    }
  }
  lit += s.slice(last);
  if (lit || parts.length === 0) parts.push(quote(lit));
  return parts.join("");
};

/** cwd as one quoted word resolving to an absolute path: a leading ~ stays
 *  bare for the shell to expand, ${}-templated paths resolve themselves
 *  (every path variable is absolute), anything else is workspace-relative. */
const cwdWord = (raw: string, ws: Workspace): string => {
  if (raw === "~" || raw.startsWith("~/"))
    return `~${raw === "~" ? "" : substituteWord(raw.slice(1), ws)}`;
  const absolute = raw.startsWith("/") || raw.startsWith("${");
  return substituteWord(absolute ? raw : `${ws.path}/${raw}`, ws);
};

/**
 * The full line typed into the task terminal: ${}-substituted command +
 * quoted args, wrapped in a subshell when env/cwd are set so they don't
 * leak into the (reused) interactive shell. The command itself is never
 * quoted — tasks.json commands are routinely full shell lines ("a && b").
 */
export function shellCommandLine(task: TaskDef, ws: Workspace): string {
  if (!task.command) throw new Error(`Task "${task.label}" has no command`);
  const command = [
    task.taskType === "process"
      ? substituteWord(task.command, ws)
      : substitute(task.command, ws),
    ...task.args.map((a) => substituteWord(a, ws)),
  ].join(" ");
  const setup = [
    ...Object.entries(task.env).map(
      ([k, v]) => `export ${k}=${substituteWord(v, ws)}`,
    ),
    ...(task.cwd ? [`cd ${cwdWord(task.cwd, ws)}`] : []),
  ];
  return setup.length ? `( ${[...setup, command].join(" && ")} )` : command;
}
