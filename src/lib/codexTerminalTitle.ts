/** Terminal-title fields Talos can present as a useful conversation topic.
 * `activity` remains enabled because its OSC churn is fallback lifecycle
 * evidence; presentation strips the spinner/action-required phases. */
export const CODEX_TERMINAL_TITLE_ITEMS = [
  "activity",
  "thread-title",
  "task-progress",
] as const;

export const CODEX_TERMINAL_TITLE_CONFIG =
  `tui.terminal_title=${JSON.stringify(CODEX_TERMINAL_TITLE_ITEMS)}`;

export const codexTerminalTitleArguments = (): string[] => [
  "-c",
  CODEX_TERMINAL_TITLE_CONFIG,
];

const quoteShellArgument = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

/** Build an app-owned Codex CLI invocation with the title configuration ahead
 * of subcommands/positional prompts so clap always treats it as a global flag. */
export const codexCliCommand = (...args: string[]): string =>
  ["codex", ...codexTerminalTitleArguments(), ...args]
    .map(quoteShellArgument)
    .join(" ");
