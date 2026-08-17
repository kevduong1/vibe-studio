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

/**
 * Both CLIs draw their dialogs, composer, and footers inside rounded box
 * frames, so a raw logical line reads as "│ > fix the bug            │".
 * Rules are line-shape anchored, so the frame has to come off first.
 *
 * Pure horizontal rules (╭──╮, ├──┤, ╰──╯) are DROPPED rather than blanked:
 * they carry no evidence and every kept line costs a slot in the small
 * per-rule tailLines windows that decide which evidence is still near-tail.
 * Interior blank lines are kept — dialogs use them for spacing, and removing
 * them would silently widen every window.
 */
const BOX_GLYPHS = "\\u2500-\\u257F\\u2580-\\u259F";
const BOX_RULE_LINE = new RegExp(`^[\\s${BOX_GLYPHS}]+$`);
/** Vertical frame edges and block-drawn gutters, with their padding. */
const LEADING_EDGE = new RegExp(
  "^[\\s\\u2502\\u2503\\u2506\\u2507\\u250A\\u250B\\u2551\\u254E\\u254F\\u2588-\\u2590]+",
);
const TRAILING_EDGE = new RegExp(
  "[\\s\\u2502\\u2503\\u2506\\u2507\\u250A\\u250B\\u2551\\u254E\\u254F\\u2588-\\u2590]+$",
);

/** Strip box chrome and trailing blank rows so rules see the evidence line
 * itself. Idempotent, but a tail preparer that has to bound its output should
 * normalize FIRST and tell `classifyAgentScreen` so — a line dropped here
 * after the bound would have spent one of the bounded window's slots. */
export function normalizeAgentScreenLines(
  logicalLines: readonly string[],
): string[] {
  const out: string[] = [];
  for (const line of logicalLines) {
    if (BOX_RULE_LINE.test(line) && line.trim() !== "") continue;
    out.push(line.replace(LEADING_EDGE, "").replace(TRAILING_EDGE, ""));
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/**
 * Authored against Claude Code 2.1.233, verified against the shipped binary's
 * rendered strings. Claude keeps its composer on screen while it works, so
 * working evidence lives in the footer hint row BELOW the composer and wins on
 * recency; spinner verbs are randomized from a large list and are matched by
 * frame glyph + gerund shape rather than by enumerating them.
 */
export const CLAUDE_PROFILE: AgentDetectionProfile = {
  kind: "claude",
  version: 3,
  authoredFor: "Claude Code 2.1.233",
  executableNames: ["claude"],
  rules: [
    // Permission and plan-approval dialogs. Options are numbered rows whose
    // labels always carry their trailing scope text ("Yes, allow all edits
    // during this session (shift+tab)"), so the label is matched as a prefix.
    { id: "claude.permission", lifecycle: "blocked", reason: "permission", strong: true, tailLines: 12, pattern: /^(?:[>❯›]\s*)?(?:\d+\.\s*)?(?:Yes, allow\b|No, and tell Claude what to do differently\b)|^(?:[>❯›]\s*)?\d+\.\s*Yes, and\b/i },
    { id: "claude.plan", lifecycle: "blocked", reason: "permission", strong: true, tailLines: 12, pattern: /^(?:Ready to code\?|Exit plan mode\?)$/ },
    // The multi-question overlay: its navigation hint is one composite line,
    // and its review step owns three complete phrases.
    { id: "claude.question", lifecycle: "blocked", reason: "question", strong: true, tailLines: 12, pattern: /^(?:(?:←\/→ to switch · )?↑\/↓ to navigate · Enter to select\b|Ready to submit your answers\?$|Submit answers$|You have not answered all questions$)/ },
    // Claude renders the spinner frame set ["·","✢","✳","✶","✻","✽"] followed
    // by a randomized gerund; the footer hint row sits below the composer.
    { id: "claude.working.spinner", lifecycle: "working", tailLines: 10, pattern: /^[✢✳✶✻✽]\s+\S+(?:…|\.\.\.)/ },
    { id: "claude.working.interrupt", lifecycle: "working", tailLines: 6, pattern: /(?:^|·\s*)esc to interrupt(?=$|[\s·)])/i },
    // Non-strong, narrow windows: an agent's own prose about limits or errors
    // must never read as blocked, so only the CLI's own line openers count.
    { id: "claude.auth", lifecycle: "blocked", reason: "auth", tailLines: 4, pattern: /^(?:Not logged in\b|Invalid API key\b|Failed to authenticate\.)/ },
    { id: "claude.quota", lifecycle: "blocked", reason: "quota", tailLines: 4, pattern: /^(?:\[)?(?:Claude )?Usage limit reached\b/ },
    { id: "claude.error", lifecycle: "blocked", reason: "error", tailLines: 4, pattern: /^API Error:\s/ },
    // The composer marker, empty or holding a draft the user has not sent.
    // The same glyph is the selection cursor inside dialogs, so a numbered
    // option row must not read as an empty prompt.
    { id: "claude.idle", lifecycle: "idle", tailLines: 5, pattern: /^[>❯](?:$|\s(?!\s*\d+\.\s))/ },
  ],
};

/**
 * Authored independently against Codex CLI 0.147.0, verified against the
 * shipped binary's rendered strings. Codex runs in the alternate screen, so
 * every classification sees a freshly repainted viewport.
 */
export const CODEX_PROFILE: AgentDetectionProfile = {
  kind: "codex",
  version: 4,
  authoredFor: "Codex CLI 0.147.0",
  executableNames: ["codex"],
  rules: [
    { id: "codex.permission", lifecycle: "blocked", reason: "permission", strong: true, tailLines: 12, pattern: /^(?:Do you want to approve\b|(?:[>›❯]\s*)?(?:\d+\.\s*)?Yes, (?:just this once|proceed|and allow (?:this host|these permissions)\b|and don't ask again)\b)|\bneeds your approval\.$/i },
    { id: "codex.question", lifecycle: "blocked", reason: "question", strong: true, tailLines: 12, pattern: /^(?:Question \d+\/\d+\b|Type your answer\b|Submit with (?:\d+ )?unanswered questions\?$|Answer required fields before submitting\.$)/i },
    { id: "codex.working", lifecycle: "working", tailLines: 8, pattern: /\((?:[^()]{0,24}\s)?(?:esc|ctrl\+c) to interrupt\)/i },
    { id: "codex.auth", lifecycle: "blocked", reason: "auth", tailLines: 4, pattern: /^(?:Not signed in\b|Not logged in\b)/i },
    { id: "codex.quota", lifecycle: "blocked", reason: "quota", tailLines: 4, pattern: /^(?:Usage limit reached\b|You've hit your usage limit\b)/i },
    { id: "codex.idle", lifecycle: "idle", tailLines: 5, pattern: /^[›❯>](?:$|\s(?!\s*\d+\.\s))/ },
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

const UNKNOWN_SCREEN: ScreenClassification = {
  lifecycle: "unknown",
  strong: false,
};

/** Classify only current tail evidence. The scan walks newest line to oldest
 * and stops at the first line any eligible rule matches, so recency wins
 * across rule classes and an old prompt can never outrank newer working or
 * idle UI. Rule priority resolves a same-line tie only: strong evidence
 * first, then profile order.
 *
 * Input is normalized unless the caller states it already did so, so every
 * caller inherits box-frame handling by default and the live session pays for
 * exactly one pass. */
export function classifyAgentScreen(
  kind: AgentKind,
  logicalLines: readonly string[],
  normalized = false,
): ScreenClassification {
  const prepared = normalized
    ? logicalLines
    : normalizeAgentScreenLines(logicalLines);
  const lines = prepared.slice(-40);
  const profile = AGENT_PROFILES[kind];
  for (let index = lines.length - 1; index >= 0; index--) {
    const depth = lines.length - index;
    let best: DetectionRule | undefined;
    for (const rule of profile.rules) {
      if (depth > rule.tailLines) continue;
      rule.pattern.lastIndex = 0;
      if (!rule.pattern.test(lines[index])) continue;
      if (!best || (rule.strong === true && best.strong !== true)) best = rule;
    }
    if (best) {
      return {
        lifecycle: best.lifecycle,
        reason: best.reason,
        matchedRule: best.id,
        strong: best.strong === true,
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
