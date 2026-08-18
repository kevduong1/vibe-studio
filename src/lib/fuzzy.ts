/**
 * Hand-rolled fuzzy matcher shared by ⌘P Quick Open and Explorer filename
 * search (no external deps).
 *
 * Two phases, because the caller runs this over the whole workspace file
 * list (up to 50k paths) per keystroke:
 *  1. A cheap O(n) subsequence scan rejects non-matches — the hot path.
 *  2. Survivors only: an O(n·m) DP finds the best-scoring placement with
 *     VS Code-ish heuristics (segment boundaries, camelCase, consecutive
 *     runs, basename matches beat directory matches), and reports the
 *     matched character positions for highlighting.
 */

export interface FuzzyResult {
  /** Higher is better; only comparable across the same query. */
  score: number;
  /** Matched char indices into the target, ascending (for highlighting). */
  positions: number[];
}

const SCORE_MATCH = 16; // every matched char
const BONUS_BOUNDARY = 14; // target start or after / - _ . space
const BONUS_CAMEL = 10; // lower→Upper transition
// Must exceed PENALTY_START_MAX, or a deep basename's bonus is exactly
// cancelled by its late-start penalty and dir matches tie with it.
const BONUS_BASENAME = 12; // any match at/after the last "/"
const BONUS_CONSECUTIVE = 12; // continues the previous matched char
const PENALTY_GAP = -4; // each gap between matches (constant, not per char)
const PENALTY_START_MAX = 8; // late first match, capped
const NEG = -(1 << 29); // "impossible" marker (ints only, so === is safe)

// Reusable scratch (module-level: calls are synchronous, JS is
// single-threaded — no reentrancy). Targets/queries beyond the caps take a
// positions-only fallback; real paths never get close.
const T_CAP = 512;
const Q_CAP = 64;
const M = new Int32Array(Q_CAP * T_CAP); // DP: query i matched AT target j
const BON = new Int32Array(T_CAP); // per-target-position bonus

const isSep = (c: number) =>
  c === 47 /* / */ || c === 45 /* - */ || c === 95 /* _ */ || c === 46 /* . */ || c === 32; /* space */
const isLower = (c: number) => c >= 97 && c <= 122;
const isUpper = (c: number) => c >= 65 && c <= 90;

/**
 * Case-insensitive subsequence match of `queryLower` in `target`; null when
 * it is not a subsequence. The caller pre-lowercases both (the target once
 * per file-list load, the query once per keystroke).
 */
export function fuzzyMatch(
  queryLower: string,
  target: string,
  targetLower: string,
): FuzzyResult | null {
  const m = queryLower.length;
  const n = targetLower.length;
  if (m === 0) return { score: 0, positions: [] };
  if (m > n) return null;

  // Phase 1: subsequence reject.
  let qi = 0;
  for (let ti = 0; ti < n && qi < m; ti++) {
    if (targetLower.charCodeAt(ti) === queryLower.charCodeAt(qi)) qi++;
  }
  if (qi < m) return null;

  // Pathological lengths: greedy first-fit positions, neutral score.
  if (n > T_CAP || m > Q_CAP) {
    const positions: number[] = [];
    let ti = 0;
    for (let i = 0; i < m; i++) {
      while (targetLower.charCodeAt(ti) !== queryLower.charCodeAt(i)) ti++;
      positions.push(ti++);
    }
    return { score: 0, positions };
  }

  // Phase 2: position bonuses, then the DP.
  const basenameStart = target.lastIndexOf("/") + 1;
  for (let j = 0; j < n; j++) {
    let b = 0;
    if (j === 0 || isSep(target.charCodeAt(j - 1))) b = BONUS_BOUNDARY;
    else if (isLower(target.charCodeAt(j - 1)) && isUpper(target.charCodeAt(j))) b = BONUS_CAMEL;
    if (j >= basenameStart) b += BONUS_BASENAME;
    BON[j] = b;
  }

  // M[i*n+j] = best score with query[i] matched exactly at target[j].
  // Predecessor is either the diagonal (consecutive run) or the best
  // earlier match of query[i-1] (gap) — tracked as a running max so each
  // row stays O(n).
  for (let i = 0; i < m; i++) {
    const qc = queryLower.charCodeAt(i);
    const row = i * n;
    const prevRow = row - n;
    let bestPrev = NEG; // max of M[i-1][0..j-2]
    for (let j = 0; j < n; j++) {
      if (i > 0 && j >= 2) bestPrev = Math.max(bestPrev, M[prevRow + j - 2]);
      let v = NEG;
      // Feasibility window: i chars before, m-1-i chars after.
      if (j >= i && j <= n - m + i && targetLower.charCodeAt(j) === qc) {
        if (i === 0) {
          v = SCORE_MATCH + BON[j] - Math.min(j, PENALTY_START_MAX);
        } else {
          const diag = M[prevRow + j - 1];
          const best = Math.max(
            diag > NEG ? diag + BONUS_CONSECUTIVE : NEG,
            bestPrev > NEG ? bestPrev + PENALTY_GAP : NEG,
          );
          if (best > NEG) v = best + SCORE_MATCH + BON[j];
        }
      }
      M[row + j] = v;
    }
  }

  // Best end position, then backtrack (consecutive preferred on ties so
  // highlights form runs).
  const lastRow = (m - 1) * n;
  let score = NEG;
  let j = -1;
  for (let k = m - 1; k < n; k++) {
    if (M[lastRow + k] > score) {
      score = M[lastRow + k];
      j = k;
    }
  }
  if (j < 0) return null; // unreachable after phase 1; defensive

  const positions = new Array<number>(m);
  for (let i = m - 1; i > 0; i--) {
    positions[i] = j;
    const prevRow = (i - 1) * n;
    const diag = M[prevRow + j - 1];
    if (diag > NEG && M[i * n + j] === diag + BONUS_CONSECUTIVE + SCORE_MATCH + BON[j]) {
      j -= 1;
      continue;
    }
    let bk = -1;
    let bv = NEG;
    for (let k = i - 1; k <= j - 2; k++) {
      if (M[prevRow + k] > bv) {
        bv = M[prevRow + k];
        bk = k;
      }
    }
    j = bk;
  }
  positions[0] = j;
  return { score, positions };
}
