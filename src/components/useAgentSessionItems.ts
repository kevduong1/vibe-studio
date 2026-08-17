import { useEffect, useMemo, useState } from "react";
import { agentPaneTitle } from "../lib/agentPaneTitle";
import { basename } from "../lib/path";
import { projectDisplayName } from "../lib/projectNames";
import { useAgentRuntimeStore } from "../stores/agentRuntime";
import { useAgentTasksStore, type AgentInboxItem } from "../stores/agentTasks";
import { useAgentTerminalsStore } from "../stores/agentTerminals";
import { useWorkspacesStore } from "../stores/workspaces";

/** The workspace registry holds each terminal store by reference, so changes
 * inside those nested stores do not update the registry's own snapshot. Keep
 * one cheap version counter while a caller needs live local titles/topics. */
function useWorkspaceTerminalVersion(enabled: boolean): number {
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const [version, bump] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const unsubscribes = workspaces.map((workspace) =>
      workspace.terminal.subscribe(() => bump((value) => value + 1)),
    );
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [enabled, workspaces]);

  return version;
}

/** Join semantic runtime, review ownership, and terminal presentation data
 * across both docks. The result follows runtime registration/Object.values
 * order; callers choose any attention or section projection explicitly. */
export function useAgentSessionItems(
  subscribeTerminals: boolean,
): AgentInboxItem[] {
  const terminalVersion = useWorkspaceTerminalVersion(subscribeTerminals);
  const runtimes = useAgentRuntimeStore((state) => state.states);
  const tasks = useAgentTasksStore((state) => state.tasks);
  const globalTerminals = useAgentTerminalsStore((state) => state.terminals);
  const globalTopics = useAgentTerminalsStore((state) => state.paneTitle);
  const workspaces = useWorkspacesStore((state) => state.workspaces);

  return useMemo(
    () =>
      Object.values(runtimes).map((runtime) => {
        const global = globalTerminals[runtime.terminalId];
        const workspace = workspaces.find(
          (candidate) => candidate.path === runtime.workspacePath,
        );
        const local = workspace?.terminal.getState().terminals[runtime.terminalId];
        const project = projectDisplayName(runtime.workspacePath);
        const rawTopic =
          globalTopics[runtime.terminalId] ??
          workspace?.terminal.getState().paneTitle[runtime.terminalId] ??
          "";

        return {
          runtime,
          task: tasks[runtime.terminalId],
          title: global?.title ?? local?.title ?? runtime.kind,
          project,
          topic: agentPaneTitle(runtime.kind, rawTopic, [
            global?.title,
            local?.title,
            project,
            basename(runtime.workspacePath),
          ]),
        };
      }),
    [
      runtimes,
      tasks,
      globalTerminals,
      globalTopics,
      workspaces,
      terminalVersion,
    ],
  );
}
