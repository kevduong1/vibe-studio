/**
 * Pure lane-layout for the commit graph (VSCode "Git Graph" style).
 *
 * Input: commits in topological order, newest first, possibly containing
 * multiple disconnected tips and parents that fall outside the loaded window.
 *
 * Algorithm (standard straight-branch): keep an ordered list of active lanes;
 * each lane records the oid it expects to see next plus the CSS color it was
 * given when it opened (rotating `--graph-N` palette by default; the caller's
 * `LaneColorFn` can pin a tip to a project color instead)
 * that it keeps for its whole lifetime. Per commit:
 *   1. The commit's lane is the first lane expecting its oid (else a new lane
 *      is appended with a fresh color).
 *   2. Every OTHER lane expecting the same oid is a merge source: it curves
 *      into the dot ("merge-in") and closes; lanes to its right shift left
 *      (recorded as "shift" connectors so lines render continuously).
 *   3. The lane's expectation becomes the first parent (no parents closes the
 *      lane). Each additional parent either joins an existing lane or opens a
 *      new lane at the end; both are recorded as "branch-out" connectors.
 *
 * Parents missing from the loaded window simply keep their lane flowing
 * downward to the end of the list — no special casing, no crash.
 */
import type { CommitInfo } from "./ipc";

export type ConnectorKind = "merge-in" | "branch-out" | "shift";

export interface GraphConnector {
  /** merge-in: top-edge lane. branch-out: the commit's lane. shift: old lane. */
  fromLane: number;
  /** merge-in: the commit's lane. branch-out: bottom-edge lane. shift: new lane. */
  toLane: number;
  /** Resolved CSS color of the line. */
  color: string;
  kind: ConnectorKind;
}

export interface GraphRow {
  commit: CommitInfo;
  /** Column of the commit dot. */
  lane: number;
  /** Resolved CSS color of the commit's lane. */
  color: string;
  /** True when a child above flows into the dot (line from top edge to dot). */
  linkUp: boolean;
  /** True when the lane continues below the dot (commit has a first parent). */
  linkDown: boolean;
  /** Lanes passing straight through this row (excludes the commit's lane). */
  passLanes: { lane: number; color: string }[];
  connectors: GraphConnector[];
}

interface Lane {
  /** The oid this lane expects to encounter next. */
  oid: string;
  color: string;
}

const PALETTE_SIZE = 8;

/**
 * Color for a lane opening at `oid`, given the next rotating palette slot.
 * Lanes are colored where they OPEN (at a tip), so an override only lands on a
 * commit that actually starts a lane — an oid that merely sits inside another
 * branch's lane keeps that lane's color.
 */
export type LaneColorFn = (oid: string, paletteIndex: number) => string;

const defaultLaneColor: LaneColorFn = (_oid, index) => `var(--graph-${index})`;

export function computeGraph(
  commits: CommitInfo[],
  laneColorFor: LaneColorFn = defaultLaneColor,
): GraphRow[] {
  const rows: GraphRow[] = [];
  const lanes: Lane[] = [];
  let nextColor = 0;

  for (const commit of commits) {
    const connectors: GraphConnector[] = [];

    // 1. Locate the commit's lane: first lane expecting this oid.
    let laneIdx = -1;
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i].oid === commit.oid) {
        laneIdx = i;
        break;
      }
    }
    let linkUp = true;
    if (laneIdx === -1) {
      // New tip (or disconnected root chain): open a lane with a fresh color.
      laneIdx = lanes.length;
      lanes.push({
        oid: commit.oid,
        color: laneColorFor(commit.oid, nextColor++ % PALETTE_SIZE),
      });
      linkUp = false;
    }
    const lane = lanes[laneIdx];

    // Snapshot pre-row lanes (object identity tracks survivors through
    // splices) so pass-through lines and shifts can be derived afterwards.
    const pre = lanes.slice();

    // 2. Merge sources: all OTHER lanes expecting this oid. They are strictly
    //    to the right of laneIdx (it was the first match). Closing them makes
    //    lanes to their right shift left (recorded below as "shift").
    for (let j = lanes.length - 1; j > laneIdx; j--) {
      if (lanes[j].oid === commit.oid) {
        connectors.push({
          fromLane: j,
          toLane: laneIdx,
          color: lanes[j].color,
          kind: "merge-in",
        });
        lanes.splice(j, 1);
      }
    }

    // 3. Parents. First parent keeps the lane flowing; none closes it.
    //    (After this point lanes only get appended, so indices recorded for
    //    branch-out targets are final bottom-edge positions for this row.)
    const parents = commit.parents;
    let linkDown = true;
    if (parents.length === 0) {
      linkDown = false;
      lanes.splice(laneIdx, 1);
    } else {
      lane.oid = parents[0];
      for (let p = 1; p < parents.length; p++) {
        const parentOid = parents[p];
        let target = -1;
        for (let i = 0; i < lanes.length; i++) {
          if (lanes[i].oid === parentOid) {
            target = i;
            break;
          }
        }
        if (target === -1) {
          target = lanes.length;
          lanes.push({
            oid: parentOid,
            color: laneColorFor(parentOid, nextColor++ % PALETTE_SIZE),
          });
        }
        if (target !== laneIdx) {
          connectors.push({
            fromLane: laneIdx,
            toLane: target,
            color: lanes[target].color,
            kind: "branch-out",
          });
        }
      }
    }

    // 4. Pass-through lanes vs. shifted lanes: every pre-row lane other than
    //    the commit's own either continues straight, moved left ("shift"), or
    //    closed via a merge-in (already recorded).
    const passLanes: { lane: number; color: string }[] = [];
    for (let i = 0; i < pre.length; i++) {
      const l = pre[i];
      if (l === lane) continue; // the commit's own lane (dot column)
      const post = lanes.indexOf(l);
      if (post === -1) continue; // closed by a merge-in this row
      if (post === i) {
        passLanes.push({ lane: i, color: l.color });
      } else {
        connectors.push({
          fromLane: i,
          toLane: post,
          color: l.color,
          kind: "shift",
        });
      }
    }

    rows.push({
      commit,
      lane: laneIdx,
      color: lane.color,
      linkUp,
      linkDown,
      passLanes,
      connectors,
    });
  }

  return rows;
}
