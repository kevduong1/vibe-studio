import type { RefLabel } from "./ipc";

const MAX_PILLS = 2;
const KIND_ORDER: Record<RefLabel["kind"], number> = {
  local: 0,
  remote: 1,
  tag: 2,
};

/**
 * Keep the exact checked-out branch visible and identify it as the filled
 * pill. Several local refs can point at HEAD, so "first local ref" is not a
 * meaningful proxy for the branch this workspace has checked out.
 */
export function graphRefPillPresentation(
  refs: RefLabel[],
  isHead: boolean,
  currentBranch: string | undefined,
): { shown: RefLabel[]; extra: number; headIdx: number } {
  const activeBranch = isHead ? currentBranch : undefined;
  const sorted =
    refs.length > 1
      ? refs.slice().sort((a, b) => {
          const kindOrder = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
          if (kindOrder !== 0) return kindOrder;
          if (!activeBranch || a.kind !== "local" || b.kind !== "local") {
            return 0;
          }
          return Number(b.name === activeBranch) - Number(a.name === activeBranch);
        })
      : refs;
  const shown = sorted.slice(0, MAX_PILLS);
  return {
    shown,
    extra: sorted.length - shown.length,
    headIdx: activeBranch
      ? shown.findIndex(
          (ref) => ref.kind === "local" && ref.name === activeBranch,
        )
      : -1,
  };
}
