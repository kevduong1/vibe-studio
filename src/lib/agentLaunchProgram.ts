/** Keep launch-scoped exports in the interactive shell that execs the agent.
 * Setup commands run separately through the tracked-command subshell. */
export const agentLaunchProgram = (
  command: string,
  environmentPrelude?: string,
): string => environmentPrelude ? `${environmentPrelude} && ${command}` : command;

export const quoteShellArgument = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

export const isolatedTaskAgentPrelude = (taskId: string, previewPort: number): string =>
  `export TALOS_TASK_ID=${quoteShellArgument(taskId)} PORT=${previewPort}`;

export const combineAgentPreludes = (
  ...preludes: Array<string | null | undefined>
): string | undefined => {
  const commands = preludes.filter((value): value is string => Boolean(value));
  return commands.length > 0 ? commands.join(" && ") : undefined;
};
