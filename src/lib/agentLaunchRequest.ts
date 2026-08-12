import type { AgentKind } from "./agentState";

export interface AgentLaunchRequest {
  workspacePath: string;
  scope: "global" | "workspace";
  kind: AgentKind;
}

export const requestAgentLaunch = (request: AgentLaunchRequest): void => {
  window.dispatchEvent(new CustomEvent("vibe:launch-agent", { detail: request }));
};
