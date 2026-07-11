/**
 * Shared icon set — every static UI glyph, defined exactly once.
 *
 * `Svg` provides the common 16x16 stroked frame; icon components forward all
 * SVG props, so callers can pass className / style / width etc. Sizing is
 * intentionally NOT hardcoded here — it comes from CSS at the call sites.
 *
 * Optical size: glyph ink should span ~10-13 of the 16 viewBox units (like
 * VS Code's codicons) — under-filled artwork reads as a mismatched, tiny
 * icon next to its siblings. Exceptions: inherently narrow glyphs keep
 * their natural aspect (chevrons, IcFile) and IcDot is small by design.
 */
import type { ReactNode, SVGProps } from "react";

export type IconProps = SVGProps<SVGSVGElement>;

export function Svg(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    />
  );
}

/* ------------------------------------------------------------------------- */
/* Git                                                                        */
/* ------------------------------------------------------------------------- */

export const IcBranch = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="4.5" cy="3.5" r="1.7" />
    <circle cx="4.5" cy="12.5" r="1.7" />
    <circle cx="11.5" cy="5.5" r="1.7" />
    <path d="M4.5 5.2v5.6" />
    <path d="M11.5 7.2c0 2.3-2.8 2.4-4.6 3.2" />
  </Svg>
);
export const IcRemote = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4.6 12.5h7a2.6 2.6 0 0 0 .4-5.17 4 4 0 0 0-7.83-.55A2.9 2.9 0 0 0 4.6 12.5z" />
  </Svg>
);
export const IcTag = (props: IconProps) => (
  <Svg {...props}>
    <path d="M8.7 2.5h4.8v4.8l-6.4 6.4a1 1 0 0 1-1.4 0L2.3 10.3a1 1 0 0 1 0-1.4z" />
    <circle cx="10.8" cy="5.2" r="1" />
  </Svg>
);
export const IcRefresh = (props: IconProps) => (
  <Svg {...props}>
    <path d="M13.2 5.3A5.5 5.5 0 1 0 13.5 8" />
    <path d="M13.5 2v3.3h-3.3" />
  </Svg>
);
export const IcSync = (props: IconProps) => (
  <Svg {...props}>
    <path d="M13.5 6.5a5.5 5.5 0 0 0-10-2" />
    <path d="M3.5 1.5v3h3" />
    <path d="M2.5 9.5a5.5 5.5 0 0 0 10 2" />
    <path d="M12.5 14.5v-3h-3" />
  </Svg>
);
export const IcPull = (props: IconProps) => (
  <Svg {...props}>
    <path d="M8 1.75v11.5" />
    <path d="M2.75 8.5 8 13.75l5.25-5.25" />
  </Svg>
);
export const IcPush = (props: IconProps) => (
  <Svg {...props}>
    <path d="M8 14.25v-11.5" />
    <path d="M2.75 7.5 8 2.25l5.25 5.25" />
  </Svg>
);
export const IcCheck = (props: IconProps) => (
  <Svg {...props}>
    <path d="M2.5 8.5 6 12l7.5-7.5" />
  </Svg>
);
export const IcDiscard = (props: IconProps) => (
  <Svg {...props}>
    <path d="M2.5 6h7.75a3.75 3.75 0 0 1 0 7.5H6.5" />
    <path d="M5.25 3.25 2.5 6l2.75 2.75" />
  </Svg>
);
export const IcBox = (props: IconProps) => (
  <Svg {...props}>
    <rect x="1.5" y="2.5" width="13" height="3" rx="0.5" />
    <path d="M2.5 5.5v7a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-7" />
    <path d="M6.5 8.5h3" />
  </Svg>
);
export const IcApply = (props: IconProps) => (
  <Svg {...props}>
    <path d="M8 2v7" />
    <path d="M5 6.5 8 9.5l3-3" />
    <path d="M2.5 11v2.5h11V11" />
  </Svg>
);
export const IcPop = (props: IconProps) => (
  <Svg {...props}>
    <path d="M8 9.5v-7" />
    <path d="M5 5 8 2l3 3" />
    <path d="M2.5 11v2.5h11V11" />
  </Svg>
);
export const IcDiff = (props: IconProps) => (
  <Svg {...props}>
    <rect x="1.5" y="2.5" width="5.2" height="11" rx="1" />
    <rect x="9.3" y="2.5" width="5.2" height="11" rx="1" />
  </Svg>
);
/** Funnel — commit-graph branch filter. */
export const IcFilter = (props: IconProps) => (
  <Svg {...props}>
    <path d="M2.5 3.5h11L9.5 8.5v4.5l-3-1.8V8.5z" />
  </Svg>
);

/* ------------------------------------------------------------------------- */
/* Files & folders                                                            */
/* ------------------------------------------------------------------------- */

export const IcFile = (props: IconProps) => (
  <Svg {...props}>
    <path d="M9.5 1.5h-5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.5z" />
    <path d="M9.5 1.5v3h3" />
  </Svg>
);
export const IcFolder = (props: IconProps) => (
  <Svg {...props}>
    <path d="M1.5 4a1 1 0 0 1 1-1h3.2l1.6 1.8h6.2a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4z" />
  </Svg>
);
export const IcFolderOpen = (props: IconProps) => (
  <Svg {...props}>
    <path d="M8.5 13H2.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h3.2l1.6 1.8h6.2a1 1 0 0 1 1 1V8" />
    <path d="M11 13.5h4M13 11.5l2 2-2 2" />
  </Svg>
);
export const IcCollapseAll = (props: IconProps) => (
  <Svg {...props}>
    <rect x="5.5" y="5.5" width="9" height="9" rx="1" />
    <path d="M7.5 10h5" />
    <path d="M2.5 10.5v-7a1 1 0 0 1 1-1h7" />
  </Svg>
);

/* ------------------------------------------------------------------------- */
/* Search                                                                     */
/* ------------------------------------------------------------------------- */

export const IcSearch = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.3 10.3 14 14" />
  </Svg>
);
/** "Aa" — case-sensitive search toggle. */
export const IcCaseSensitive = (props: IconProps) => (
  <Svg {...props}>
    <path d="M1.5 12 4.5 4l3 8" />
    <path d="M2.6 9.4h3.8" />
    <path d="M13.5 12V7.7a2 2 0 0 0-3.9-.6" />
    <path d="M13.5 9.8a2.4 2.4 0 1 1-2.4-2.3 2.4 2.4 0 0 1 2.4 2.3z" />
  </Svg>
);
/** "ab" with underline — whole-word search toggle. */
export const IcWholeWord = (props: IconProps) => (
  <Svg {...props}>
    <path d="M6 10.5V7.6a1.8 1.8 0 0 0-3.5-.5" />
    <path d="M6 8.7a2.1 2.1 0 1 1-2.1-2 2.1 2.1 0 0 1 2.1 2z" />
    <path d="M9.8 3.5v7" />
    <path d="M9.8 8.7a1.9 1.9 0 1 0 1.9-2 1.9 1.9 0 0 0-1.9 2z" />
    <path d="M2 13.5h12" />
  </Svg>
);
/** ".*" — regex search toggle. */
export const IcRegex = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="4" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <path d="M10.5 3.5v6" />
    <path d="M7.9 5 13.1 8" />
    <path d="M7.9 8 13.1 5" />
  </Svg>
);
/** Box swapped out via a return arrow — replace next match. */
export const IcReplace = (props: IconProps) => (
  <Svg {...props}>
    <rect x="2" y="2" width="6" height="6" rx="1" />
    <path d="M13.5 4.5v5a2 2 0 0 1-2 2H5.5" />
    <path d="M7.5 9.5 5.5 11.5l2 2" />
  </Svg>
);
/** Two boxes + return arrow — replace all matches. */
export const IcReplaceAll = (props: IconProps) => (
  <Svg {...props}>
    <rect x="1.5" y="1.5" width="5" height="5" rx="1" />
    <rect x="8.5" y="1.5" width="5" height="5" rx="1" />
    <path d="M13.5 8.5v1a2 2 0 0 1-2 2H5.5" />
    <path d="M7.5 9.5 5.5 11.5l2 2" />
  </Svg>
);

/* ------------------------------------------------------------------------- */
/* Chrome & generic actions                                                   */
/* ------------------------------------------------------------------------- */

export const IcClose = (props: IconProps) => (
  <Svg {...props}>
    <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
  </Svg>
);
export const IcGear = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="8" cy="8" r="2.4" />
    <path d="M8 1.9v2M8 12.1v2M14.1 8h-2M3.9 8h-2M12.3 3.7l-1.4 1.4M5.1 10.9l-1.4 1.4M12.3 12.3l-1.4-1.4M5.1 5.1L3.7 3.7" />
  </Svg>
);
export const IcEye = (props: IconProps) => (
  <Svg {...props}>
    <path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8 11.9 12.2 8 12.2 1.8 8 1.8 8Z" />
    <circle cx="8" cy="8" r="2" />
  </Svg>
);
/** Claude's radiating mark, simplified for the 16px status-bar grid. */
export const IcClaude = (props: IconProps) => (
  <Svg {...props}>
    <path d="M8 1.5v4M8 10.5v4M1.5 8h4M10.5 8h4" />
    <path d="m3.4 3.4 2.8 2.8M9.8 9.8l2.8 2.8M12.6 3.4 9.8 6.2M6.2 9.8l-2.8 2.8" />
    <circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none" />
  </Svg>
);
/** Codex terminal-prompt mark — the crisp center of the app icon at 16px. */
export const IcCodex = (props: IconProps) => (
  <Svg {...props}>
    <path d="m3 4.3 3.7 3.7L3 11.7" strokeWidth={1.7} />
    <path d="M8.5 11.7H13" strokeWidth={1.7} />
  </Svg>
);
/** Brain — project memories (Claude + Codex per-project auto-memories). */
export const IcBrain = (props: IconProps) => (
  <Svg {...props}>
    <path d="M8 3.2v9.6" />
    <path d="M8 4c-.7-1.3-2.9-1.2-3.5.2-1.3-.2-2.1 1.1-1.4 2.2-1 .8-.5 2.4.8 2.5-.2 1.5 1.9 2.2 2.9 1.1" />
    <path d="M8 4c.7-1.3 2.9-1.2 3.5.2 1.3-.2 2.1 1.1 1.4 2.2 1 .8.5 2.4-.8 2.5.2 1.5-1.9 2.2-2.9 1.1" />
  </Svg>
);
export const IcChevronRight = (props: IconProps) => (
  <Svg {...props}>
    <path d="m5.7 3 5 5-5 5" />
  </Svg>
);
export const IcChevronDown = (props: IconProps) => (
  <Svg {...props}>
    <path d="m3 5.7 5 5 5-5" />
  </Svg>
);
/* double chevrons: bottom-panel maximize / restore */
export const IcChevronsUp = (props: IconProps) => (
  <Svg {...props}>
    <path d="m3 8.4 5-5 5 5" />
    <path d="m3 13.4 5-5 5 5" />
  </Svg>
);
export const IcChevronsDown = (props: IconProps) => (
  <Svg {...props}>
    <path d="m3 2.6 5 5 5-5" />
    <path d="m3 7.6 5 5 5-5" />
  </Svg>
);
/* play triangle: settings-modal sound preview */
export const IcPlay = (props: IconProps) => (
  <Svg {...props}>
    <path d="M5.5 3.2v9.6L13 8z" />
  </Svg>
);
export const IcPlus = (props: IconProps) => (
  <Svg {...props}>
    <path d="M8 2.5v11M2.5 8h11" />
  </Svg>
);
export const IcMinus = (props: IconProps) => (
  <Svg {...props}>
    <path d="M2.5 8h11" />
  </Svg>
);
export const IcTrash = (props: IconProps) => (
  <Svg {...props}>
    <path d="M2.5 4.5h11" />
    <path d="M5.5 4.5v-1a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1" />
    <path d="M3.5 4.5l.7 8.6a1 1 0 0 0 1 .9h5.6a1 1 0 0 0 1-.9l.7-8.6" />
    <path d="M6.5 7v4M9.5 7v4" />
  </Svg>
);
export const IcTerminal = (props: IconProps) => (
  <Svg {...props}>
    <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
    <path d="M4 6l2.5 2L4 10" />
    <path d="M8 10.5h4" />
  </Svg>
);
/** Four-pointed sparkle — agent terminal (activity-tracked). */
export const IcSparkle = (props: IconProps) => (
  <Svg {...props}>
    <path d="M8 1.5L9.7 6.3L14.5 8L9.7 9.7L8 14.5L6.3 9.7L1.5 8L6.3 6.3Z" />
  </Svg>
);
/** Circle-slash — agent terminal whose project isn't open as a workspace. */
export const IcDisconnected = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M4.2 11.8 11.8 4.2" />
  </Svg>
);
/** Bell — agent terminal with attention notifications enabled. */
export const IcBell = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 5.3a4 4 0 0 0-8 0c0 4.7-2 6-2 6h12s-2-1.3-2-6" />
    <path d="M9.2 13.5a1.3 1.3 0 0 1-2.4 0" />
  </Svg>
);
/** Panel split into two columns at the midline (split-editor / split-terminal). */
export const IcSplit = (props: IconProps) => (
  <Svg {...props}>
    <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
    <path d="M8 2.5v11" />
  </Svg>
);
/** Panel with a left sidebar (divider off-center) — NOT the same as IcSplit. */
export const IcSidebar = (props: IconProps) => (
  <Svg {...props}>
    <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
    <path d="M6 2.5v11" />
  </Svg>
);
/** Panel split into two rows (unified diff view). */
export const IcRows = (props: IconProps) => (
  <Svg {...props}>
    <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
    <path d="M1.5 8h13" />
  </Svg>
);

/* ------------------------------------------------------------------------- */
/* Terminal activity                                                          */
/* ------------------------------------------------------------------------- */

/** 270° arc — spun by the .activity-busy CSS animation. */
export const IcSpinner = (props: IconProps) => (
  <Svg {...props}>
    <path d="M14.5 8A6.5 6.5 0 1 1 8 1.5" />
  </Svg>
);
export const IcDot = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="8" cy="8" r="4" fill="currentColor" stroke="none" />
  </Svg>
);

/**
 * Tab activity indicator (terminal tab strip + titlebar workspace tabs):
 * spinner while busy, pulsing dot when waiting on the user, otherwise the
 * caller's idle glyph. Project-bound tabs pass `color` (their project's
 * color) to tint the spinner and dot — the class defaults (`--accent`,
 * `--warning`) are project-independent, and `--accent` in particular is the
 * ACTIVE project's color, wrong on every other project's tab. The pulse/spin
 * animations live on the classes and animate opacity/transform, so the
 * inline color doesn't disturb them.
 */
export function ActivityGlyph({
  activity,
  idle,
  color,
}: {
  activity: "idle" | "busy" | "attention";
  idle: ReactNode;
  color?: string;
}) {
  const style = color ? { color } : undefined;
  if (activity === "attention")
    return <IcDot className="activity-attention" style={style} />;
  if (activity === "busy")
    return <IcSpinner className="activity-busy" style={style} />;
  return <>{idle}</>;
}
