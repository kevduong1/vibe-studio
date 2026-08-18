import { useEffect, useMemo, useState } from "react";
import { agentPaneTitle } from "../lib/agentPaneTitle";
import {
  repositoryNameFromGroupId,
  type AgentSessionItem,
} from "../lib/agentSessionsView";
import { basename } from "../lib/path";
import { useProjectDisplayNames } from "../lib/projectNames";
import { useAgentRuntimeStore } from "../stores/agentRuntime";
import { useAgentTasksStore } from "../stores/agentTasks";
import { useAgentTerminalsStore } from "../stores/agentTerminals";
import { useIsolatedTasksStore } from "../stores/isolatedTasks";
import { useWorkspacesStore } from "../stores/workspaces";

/** The workspace registry holds each terminal/repo store by reference, so
 * changes inside those nested stores do not update the registry's snapshot.
 * Keep one cheap version counter while a caller needs live title/branch data. */
function useWorkspacePresentationVersion(enabled: boolean): number {
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const [version, bump] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const unsubscribes = workspaces.flatMap((workspace) => [
      workspace.terminal.subscribe(() => bump((value) => value + 1)),
      workspace.repo.subscribe(() => bump((value) => value + 1)),
    ]);
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [enabled, workspaces]);

  return version;
}

/** Join semantic runtime, review ownership, and terminal presentation data
 * across both docks. The result follows runtime registration/Object.values
 * order; callers choose any attention or section projection explicitly. */
export function useAgentSessionItems(
  subscribeTerminals: boolean,
): AgentSessionItem[] {
  const presentationVersion = useWorkspacePresentationVersion(subscribeTerminals);
  const runtimes = useAgentRuntimeStore((state) => state.states);
  const reviewTasks = useAgentTasksStore((state) => state.tasks);
  const globalTerminals = useAgentTerminalsStore((state) => state.terminals);
  const globalTopics = useAgentTerminalsStore((state) => state.paneTitle);
  const isolatedTasks = useIsolatedTasksStore((state) => state.tasks);
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const displayName = useProjectDisplayNames();

  return useMemo(
    () => {
      const workspacesByPath = new Map(
        workspaces.map((workspace) => [workspace.path, workspace]),
      );
      const isolatedByPath = new Map(
        Object.values(isolatedTasks)
          .filter((task) => task.outcome !== "discarded")
          .map((task) => [task.worktreePath, task]),
      );

      return Object.values(runtimes).map((runtime) => {
        const global = globalTerminals[runtime.terminalId];
        const workspace = workspacesByPath.get(runtime.workspacePath);
        const isolated = isolatedByPath.get(runtime.workspacePath);
        const parentWorkspace = isolated
          ? workspacesByPath.get(isolated.parentWorkspacePath)
          : undefined;
        const local = workspace?.terminal.getState().terminals[runtime.terminalId];
        const project = displayName(runtime.workspacePath);
        const familyPath = isolated?.parentWorkspacePath ?? runtime.workspacePath;
        const repositoryId =
          workspace?.tabGroupId ??
          global?.repositoryId ??
          parentWorkspace?.tabGroupId ??
          `path:${familyPath}`;
        const rawTopic =
          globalTopics[runtime.terminalId] ??
          workspace?.terminal.getState().paneTitle[runtime.terminalId] ??
          "";

        return {
          runtime,
          task: reviewTasks[runtime.terminalId],
          title: global?.title ?? local?.title ?? runtime.kind,
          project,
          repositoryId,
          repository:
            global?.repository ??
            repositoryNameFromGroupId(repositoryId, familyPath),
          checkout: project,
          branch:
            workspace?.repo.getState().status?.branch.name ??
            isolated?.branch ??
            null,
          topic: agentPaneTitle(runtime.kind, rawTopic, [
            global?.title,
            local?.title,
            project,
            basename(runtime.workspacePath),
          ]),
        };
      });
    },
    [
      runtimes,
      reviewTasks,
      globalTerminals,
      globalTopics,
      isolatedTasks,
      workspaces,
      presentationVersion,
      displayName,
    ],
  );
}
