import type { AgentKind, AgentLifecycle, AgentReason } from "./agentState";

interface DetectionRule {
  id: string;
  lifecycle: Exclude<AgentLifecycle, "unknown">;
  pattern: RegExp;
  reason?: AgentReason;
  strong?: boolean;
  tailLines: number;
}

export interface AgentDetectionProfile {
  kind: AgentKind;
  /** Increment whenever authored rules change; shown in the internal
   * diagnostics surface so a reported match is reproducible. */
  version: number;
  authoredFor: string;
  executableNames: readonly string[];
  rules: readonly DetectionRule[];
}

// Authored against Claude Code 2.1.226. Rules intentionally describe only
// stable UI phrases and glyphs, not implementation-specific escape output.
export const CLAUDE_PROFILE: AgentDetectionProfile = {
  kind: "claude",
  version: 1,
  authoredFor: "Claude Code 2.1.226",
  executableNames: ["claude"],
  rules: [
    { id: "claude.permission", lifecycle: "blocked", reason: "permission", strong: true, tailLines: 8, pattern: /(?:Do you want to proceed|Allow this action|Yes, allow|permission (?:is )?required)/i },
    { id: "claude.question", lifecycle: "blocked", reason: "question", strong: true, tailLines: 8, pattern: /(?:Would you like|Please (?:choose|select)|Which (?:option|approach)|Enter to select|Tab\/Arrow keys to navigate|Ready to submit your answers\?|Submit answers|You have not answered all questions)/i },
    { id: "claude.auth", lifecycle: "blocked", reason: "auth", tailLines: 8, pattern: /(?:not logged in|authentication required|run [`']?claude login|sign in to continue)/i },
    { id: "claude.quota", lifecycle: "blocked", reason: "quota", tailLines: 8, pattern: /(?:usage limit|rate limit|quota|resets at)/i },
    { id: "claude.error", lifecycle: "blocked", reason: "error", tailLines: 6, pattern: /(?:API Error|Error:|request failed|connection failed)/i },
    { id: "claude.working", lifecycle: "working", tailLines: 8, pattern: /(?:esc to interrupt|ctrl-c to cancel|(?:Thinking|Working|Reading|Searching|Editing|Running)…|[✻✶✽] .+)/i },
    { id: "claude.idle", lifecycle: "idle", tailLines: 4, pattern: /(?:^|\n)\s*[>❯]\s*(?:$|Try\b|Ask\b)/im },
  ],
};

// Authored independently against Codex CLI 0.147.0.
export const CODEX_PROFILE: AgentDetectionProfile = {
  kind: "codex",
  version: 2,
  authoredFor: "Codex CLI 0.147.0",
  executableNames: ["codex"],
  rules: [
    { id: "codex.permission", lifecycle: "blocked", reason: "permission", strong: true, tailLines: 9, pattern: /(?:Would you like to run|Do you want to run|Approve (?:this|command)|approval required|Press enter to confirm)/i },
    { id: "codex.question", lifecycle: "blocked", reason: "question", strong: true, tailLines: 9, pattern: /(?:Choose an option|Which (?:option|approach)|Please answer|waiting for your response|Question \d+\/\d+(?:\s+\(\d+\s+unanswered\))?|to submit (?:answer|all)|Type your answer(?: \(optional\))?|Submit with unanswered questions\?)/i },
    { id: "codex.auth", lifecycle: "blocked", reason: "auth", tailLines: 8, pattern: /(?:not signed in|login required|authentication required|sign in to continue)/i },
    { id: "codex.quota", lifecycle: "blocked", reason: "quota", tailLines: 8, pattern: /\b(?:you['’]ve hit your usage limit|usage limit (?:has been )?(?:reached|exceeded)|rate limit (?:has been )?(?:reached|exceeded))\b/i },
    { id: "codex.error", lifecycle: "blocked", reason: "error", tailLines: 6, pattern: /(?:Error:|request failed|connection failed|stream disconnected)/i },
    { id: "codex.working", lifecycle: "working", tailLines: 8, pattern: /(?:esc to interrupt|ctrl-c to cancel|•\s*(?:Working|Thinking|Running)|(?:Working|Thinking|Running) \(\d+s\))/i },
    { id: "codex.idle", lifecycle: "idle", tailLines: 4, pattern: /(?:^|\n)\s*[›❯]\s*(?:$|Ask\b|Implement\b)/im },
  ],
};

export const AGENT_PROFILES: Record<AgentKind, AgentDetectionProfile> = {
  claude: CLAUDE_PROFILE,
  codex: CODEX_PROFILE,
};

export interface ScreenClassification {
  lifecycle: AgentLifecycle;
  reason?: AgentReason;
  matchedRule?: string;
  strong: boolean;
}

export const UNKNOWN_SCREEN: ScreenClassification = {
  lifecycle: "unknown",
  strong: false,
};

/** Classify only current tail evidence. A newer idle prompt invalidates old
 * blocked/working text that still happens to be in the bounded snapshot. */
export function classifyAgentScreen(
  kind: AgentKind,
  logicalLines: readonly string[],
): ScreenClassification {
  const lines = logicalLines.slice(-40);
  const profile = AGENT_PROFILES[kind];
  const latestIdleRule = profile.rules.find((rule) => rule.lifecycle === "idle");
  let latestIdle = -1;
  if (latestIdleRule) {
    lines.forEach((line, index) => {
      latestIdleRule.pattern.lastIndex = 0;
      if (latestIdleRule.pattern.test(line)) latestIdle = index;
    });
  }
  for (const rule of profile.rules) {
    const from = Math.max(0, lines.length - rule.tailLines);
    for (let index = lines.length - 1; index >= from; index--) {
      rule.pattern.lastIndex = 0;
      if (!rule.pattern.test(lines[index])) continue;
      if (rule.lifecycle !== "idle" && latestIdle > index) break;
      return {
        lifecycle: rule.lifecycle,
        reason: rule.reason,
        matchedRule: rule.id,
        strong: rule.strong === true,
      };
    }
  }
  return UNKNOWN_SCREEN;
}

export const boundedLogicalTail = (
  logicalLines: readonly string[],
  maxLines = 40,
  maxChars = 16 * 1024,
): string[] => {
  const out: string[] = [];
  let chars = 0;
  for (let i = logicalLines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const line = logicalLines[i];
    if (chars + line.length > maxChars) {
      const room = maxChars - chars;
      if (room > 0) out.unshift(line.slice(-room));
      break;
    }
    out.unshift(line);
    chars += line.length;
  }
  return out;
};
