import { findGroup } from "./dockTree";
import { getSession } from "./termSessions";
import { queueAgentPrompt } from "./agentPromptQueue";
import { useAgentRuntimeStore } from "../stores/agentRuntime";
import { useAgentTerminalsStore } from "../stores/agentTerminals";
import { useWorkspacesStore } from "../stores/workspaces";
import {
  formatAgentEditorContext,
  type AgentEditorContext,
  type EditorSelectionContext,
} from "./editorAgentContextFormat";

export type { AgentEditorContext, EditorSelectionContext } from "./editorAgentContextFormat";

const selections = new Map<string, () => EditorSelectionContext | null>();
const selectionKey = (workspacePath: string, tabId: string) =>
  `${workspacePath}\0${tabId}`;

/** Register a live, read-only selection getter for the mounted file editor. */
export function registerEditorSelection(
  workspacePath: string,
  tabId: string,
  getSelection: () => EditorSelectionContext | null,
): () => void {
  const key = selectionKey(workspacePath, tabId);
  selections.set(key, getSelection);
  return () => {
    if (selections.get(key) === getSelection) selections.delete(key);
  };
}

export const currentEditorSelection = (
  workspacePath: string,
  tabId: string,
): EditorSelectionContext | null => selections.get(selectionKey(workspacePath, tabId))?.() ?? null;

const activeWorkspaceTerminal = (workspacePath: string): string | null => {
  const workspace = useWorkspacesStore.getState().workspaces.find((item) => item.path === workspacePath);
  if (!workspace) return null;
  const state = workspace.terminal.getState();
  return findGroup(state.root, state.activeGroupId)?.activeTerminalId ?? null;
};

const activeGlobalTerminal = (): string | null => {
  const state = useAgentTerminalsStore.getState();
  const grouping = state.groupings.find((item) => item.id === state.activeGroupingId);
  return grouping
    ? findGroup(grouping.root, grouping.activeGroupId)?.activeTerminalId ?? null
    : null;
};

const hasLiveSession = (terminalId: string): boolean => {
  const session = getSession(terminalId);
  return Boolean(session && !session.exited);
};

/** Choose a visible/current safe prompt first, then the most-recent safe
 * occupant in the project. Working and permission-blocked agents are never
 * steered implicitly. */
export function editorContextTarget(workspacePath: string): string | null {
  const states = Object.values(useAgentRuntimeStore.getState().states)
    .filter((runtime) =>
      runtime.workspacePath === workspacePath &&
      runtime.occupancy === "present" &&
      (runtime.lifecycle === "idle" ||
        (runtime.lifecycle === "blocked" && runtime.reason === "question")) &&
      hasLiveSession(runtime.terminalId),
    )
    .sort((a, b) => b.changedAt - a.changedAt);
  const preferred = [activeWorkspaceTerminal(workspacePath), activeGlobalTerminal()];
  return preferred.find((id) => id && states.some((runtime) => runtime.terminalId === id))
    ?? states[0]?.terminalId
    ?? null;
}

export async function sendEditorContextToAgent(
  workspacePath: string,
  context: AgentEditorContext,
): Promise<string> {
  const terminalId = editorContextTarget(workspacePath);
  if (!terminalId) {
    const live = Object.values(useAgentRuntimeStore.getState().states).some(
      (runtime) => runtime.workspacePath === workspacePath && runtime.occupancy === "present",
    );
    throw new Error(live
      ? "No agent in this project is at a safe input prompt. Wait for it to finish or answer its permission prompt first."
      : "No live Claude or Codex agent was found for this project.");
  }
  await queueAgentPrompt(terminalId, formatAgentEditorContext(context));
  return terminalId;
}
