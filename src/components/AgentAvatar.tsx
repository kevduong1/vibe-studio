import { useEffect, useRef, useState, type RefObject } from "react";
import {
  AGENT_AVATAR_DEITIES,
  AGENT_AVATAR_PERSONALITIES,
  AGENT_AVATAR_STATIC_FRAME,
  agentAvatarFrameAt,
  type AgentAvatarActivity,
  type AgentAvatarCostume,
  type AgentAvatarDeity,
  type AgentAvatarSelection,
  type AgentAvatarSignature,
  type AgentAvatarState,
} from "../lib/agentAvatars";
import { useAppTheme } from "../lib/appTheme";

const SCENE_SIZE = 40;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

type FrameListener = (time: number) => void;

const frameListeners = new Set<FrameListener>();
let sharedFrame: number | null = null;

function tick(time: number): void {
  for (const listener of frameListeners) listener(time);
  sharedFrame = frameListeners.size > 0 ? requestAnimationFrame(tick) : null;
}

function subscribeToFrames(listener: FrameListener): () => void {
  frameListeners.add(listener);
  listener(performance.now());
  if (sharedFrame === null) sharedFrame = requestAnimationFrame(tick);
  return () => {
    frameListeners.delete(listener);
    if (frameListeners.size === 0 && sharedFrame !== null) {
      cancelAnimationFrame(sharedFrame);
      sharedFrame = null;
    }
  };
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(REDUCED_MOTION_QUERY);
    const sync = () => setReduced(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  return reduced;
}

function useCanvasVisibility(
  canvasRef: RefObject<HTMLCanvasElement | null>,
): boolean {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(([entry]) => {
      setVisible(entry?.isIntersecting ?? true);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [canvasRef]);

  return visible;
}

interface ScenePalette {
  accent: string;
  background: string;
  wall: string;
  floor: string;
  figure: string;
  effect: string;
  detail: string;
}

interface FigurePose {
  headX: number;
  headY: number;
  shoulderX: number;
  shoulderY: number;
  hipX: number;
  hipY: number;
  leftHandX: number;
  leftHandY: number;
  rightHandX: number;
  rightHandY: number;
  leftFootX: number;
  leftFootY: number;
  rightFootX: number;
  rightFootY: number;
  look: -1 | 0 | 1;
}

function fill(
  context: CanvasRenderingContext2D,
  color: string,
  x: number,
  y: number,
  width = 1,
  height = 1,
): void {
  context.fillStyle = color;
  context.fillRect(
    Math.round(x),
    Math.round(y),
    Math.round(width),
    Math.round(height),
  );
}

function pixelLine(
  context: CanvasRenderingContext2D,
  color: string,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  thickness = 1,
): void {
  let x = Math.round(fromX);
  let y = Math.round(fromY);
  const targetX = Math.round(toX);
  const targetY = Math.round(toY);
  const dx = Math.abs(targetX - x);
  const sx = x < targetX ? 1 : -1;
  const dy = -Math.abs(targetY - y);
  const sy = y < targetY ? 1 : -1;
  let error = dx + dy;

  while (true) {
    fill(context, color, x, y, thickness, thickness);
    if (x === targetX && y === targetY) break;
    const doubled = 2 * error;
    if (doubled >= dy) {
      error += dy;
      x += sx;
    }
    if (doubled <= dx) {
      error += dx;
      y += sy;
    }
  }
}

function withAlpha(
  context: CanvasRenderingContext2D,
  alpha: number,
  draw: () => void,
): void {
  const previous = context.globalAlpha;
  context.globalAlpha = alpha;
  draw();
  context.globalAlpha = previous;
}

function drawGlyph(
  context: CanvasRenderingContext2D,
  color: string,
  rows: readonly string[],
  x: number,
  y: number,
): void {
  rows.forEach((row, rowIndex) => {
    [...row].forEach((cell, columnIndex) => {
      if (cell === "1") fill(context, color, x + columnIndex, y + rowIndex);
    });
  });
}

function drawHeart(
  context: CanvasRenderingContext2D,
  color: string,
  x: number,
  y: number,
): void {
  fill(context, color, x, y, 2, 1);
  fill(context, color, x + 3, y, 2, 1);
  fill(context, color, x, y + 1, 5, 2);
  fill(context, color, x + 1, y + 3, 3, 1);
  fill(context, color, x + 2, y + 4);
}

function drawFlower(
  context: CanvasRenderingContext2D,
  petal: string,
  center: string,
  x: number,
  y: number,
): void {
  fill(context, petal, x + 1, y);
  fill(context, petal, x, y + 1);
  fill(context, center, x + 1, y + 1);
  fill(context, petal, x + 2, y + 1);
  fill(context, petal, x + 1, y + 2);
}

function stateEnergy(state: AgentAvatarState, frame: number): number {
  const beat = [0, 1, 2, 1][frame];
  switch (state) {
    case "done":
      return Math.min(3, beat + 1);
    case "working":
      return beat + 1;
    case "starting":
      return frame;
    case "blocked":
      return frame === 0 ? 1 : 0;
    case "unknown":
      return frame % 2;
    case "idle":
      return frame === 2 ? 1 : 0;
  }
}

function workingPoseFor(
  activity: AgentAvatarActivity,
  frame: number,
): FigurePose {
  const beat = [0, 1, 2, 1][frame] ?? 0;
  const alternate = frame % 2;

  switch (activity) {
    case "rose-garden":
      return {
        headX: 7,
        headY: 11 + (frame === 2 ? 1 : 0),
        shoulderX: 10,
        shoulderY: 17,
        hipX: 13,
        hipY: 26,
        leftHandX: 20 + beat,
        leftHandY: 18 + alternate,
        rightHandX: 23 - alternate,
        rightHandY: 25 - beat,
        leftFootX: 8,
        leftFootY: 33,
        rightFootX: 22,
        rightFootY: 31,
        look: 1,
      };
    case "lyre":
      return {
        headX: 7,
        headY: 10 + (frame === 2 ? 1 : 0),
        shoulderX: 10,
        shoulderY: 16,
        hipX: 11,
        hipY: 25,
        leftHandX: 23,
        leftHandY: 19 + beat,
        rightHandX: 25 - alternate,
        rightHandY: 26 - beat,
        leftFootX: 7,
        leftFootY: 33,
        rightFootX: 17,
        rightFootY: 33,
        look: 1,
      };
    case "sword-drill": {
      const swordHands = [
        [18, 13],
        [22, 10],
        [27, 18],
        [22, 24],
      ] as const;
      return {
        headX: 11 + alternate,
        headY: 10,
        shoulderX: 13,
        shoulderY: 16,
        hipX: 14,
        hipY: 25,
        leftHandX: 7,
        leftHandY: 20,
        rightHandX: swordHands[frame][0],
        rightHandY: swordHands[frame][1],
        leftFootX: 7 - alternate,
        leftFootY: 33,
        rightFootX: 25 + alternate,
        rightFootY: 33,
        look: 1,
      };
    }
    case "archery":
      return {
        headX: 7,
        headY: 11,
        shoulderX: 10,
        shoulderY: 17,
        hipX: 11,
        hipY: 26,
        leftHandX: 26 + (frame === 2 ? 1 : 0),
        leftHandY: 18,
        rightHandX: frame === 2 ? 18 : 15 - beat,
        rightHandY: frame === 2 ? 19 : 17,
        leftFootX: 7,
        leftFootY: 33,
        rightFootX: 21,
        rightFootY: 33,
        look: 1,
      };
    case "weaving":
      return {
        headX: 6,
        headY: 10 + (frame === 3 ? 1 : 0),
        shoulderX: 9,
        shoulderY: 16,
        hipX: 10,
        hipY: 25,
        leftHandX: 21 + alternate,
        leftHandY: 18 + beat,
        rightHandX: 22 - alternate,
        rightHandY: 26 - beat,
        leftFootX: 6,
        leftFootY: 33,
        rightFootX: 17,
        rightFootY: 33,
        look: 1,
      };
    case "harvest":
      return {
        headX: 7 + beat,
        headY: 10 + beat,
        shoulderX: 10 + beat,
        shoulderY: 16 + beat,
        hipX: 14,
        hipY: 26,
        leftHandX: 22,
        leftHandY: 23 + alternate,
        rightHandX: 25 + beat,
        rightHandY: 28 - beat,
        leftFootX: 8,
        leftFootY: 33,
        rightFootX: 22,
        rightFootY: 33,
        look: 1,
      };
    case "summoning":
      return {
        headX: 15,
        headY: 11 - (beat > 1 ? 1 : 0),
        shoulderX: 17,
        shoulderY: 17,
        hipX: 17,
        hipY: 26,
        leftHandX: 7 - alternate,
        leftHandY: 21 - beat * 3,
        rightHandX: 29 + alternate,
        rightHandY: 21 - beat * 3,
        leftFootX: 11,
        leftFootY: 33,
        rightFootX: 25,
        rightFootY: 33,
        look: 0,
      };
    case "smithing": {
      const hammerHands = [
        [20, 22],
        [19, 14],
        [17, 9],
        [20, 16],
      ] as const;
      return {
        headX: 7,
        headY: 11 + (frame === 0 ? 1 : 0),
        shoulderX: 10,
        shoulderY: 17,
        hipX: 12,
        hipY: 26,
        leftHandX: 24,
        leftHandY: 26,
        rightHandX: hammerHands[frame][0],
        rightHandY: hammerHands[frame][1],
        leftFootX: 7,
        leftFootY: 33,
        rightFootX: 20,
        rightFootY: 33,
        look: 1,
      };
    }
    case "royal-audience":
      return {
        headX: 9,
        headY: 10,
        shoulderX: 12,
        shoulderY: 16,
        hipX: 13,
        hipY: 25,
        leftHandX: 7,
        leftHandY: 19 - alternate,
        rightHandX: 23 + beat,
        rightHandY: 21 - beat * 3,
        leftFootX: 9,
        leftFootY: 33,
        rightFootX: 19,
        rightFootY: 33,
        look: 1,
      };
    case "courier": {
      const x = [3, 7, 11, 7][frame];
      return {
        headX: x,
        headY: 10 - (beat > 0 ? 1 : 0),
        shoulderX: x + 2,
        shoulderY: 16,
        hipX: x + 3,
        hipY: 24,
        leftHandX: x - 2 + alternate * 7,
        leftHandY: 21,
        rightHandX: x + 8 - alternate * 7,
        rightHandY: 19,
        leftFootX: x - 2 + alternate * 9,
        leftFootY: 32,
        rightFootX: x + 9 - alternate * 9,
        rightFootY: 33,
        look: 1,
      };
    }
    case "tide-calling":
      return {
        headX: 9,
        headY: 10 + (frame === 2 ? 1 : 0),
        shoulderX: 12,
        shoulderY: 16,
        hipX: 14,
        hipY: 25,
        leftHandX: 22 + alternate,
        leftHandY: 14 + beat,
        rightHandX: 24 - alternate,
        rightHandY: 24 - beat,
        leftFootX: 7,
        leftFootY: 33,
        rightFootX: 23,
        rightFootY: 33,
        look: 1,
      };
    case "storm-calling": {
      const boltHands = [
        [19, 22],
        [22, 15],
        [27, 9],
        [24, 14],
      ] as const;
      return {
        headX: 9,
        headY: 10 - (beat > 1 ? 1 : 0),
        shoulderX: 12,
        shoulderY: 16,
        hipX: 14,
        hipY: 25,
        leftHandX: 7,
        leftHandY: 18 - beat,
        rightHandX: boltHands[frame][0],
        rightHandY: boltHands[frame][1],
        leftFootX: 8,
        leftFootY: 33,
        rightFootX: 22,
        rightFootY: 33,
        look: 1,
      };
    }
  }
}

function poseFor(
  state: AgentAvatarState,
  frame: number,
  activity: AgentAvatarActivity,
): FigurePose {
  if (state === "starting") {
    const x = 2 + frame * 3;
    return {
      headX: x,
      headY: 11,
      shoulderX: x + 2,
      shoulderY: 17,
      hipX: x + 2,
      hipY: 25,
      leftHandX: x - 1,
      leftHandY: 23,
      rightHandX: x + 6,
      rightHandY: 22,
      leftFootX: x + (frame % 2 === 0 ? -1 : 1),
      leftFootY: 33,
      rightFootX: x + (frame % 2 === 0 ? 6 : 4),
      rightFootY: 33,
      look: 1,
    };
  }

  if (state === "working") {
    return workingPoseFor(activity, frame);
  }

  if (state === "blocked") {
    const shrug = frame === 1 || frame === 2 ? 1 : 0;
    return {
      headX: 11,
      headY: 10 + (frame === 3 ? 1 : 0),
      shoulderX: 13,
      shoulderY: 16,
      hipX: 13,
      hipY: 25,
      leftHandX: 6,
      leftHandY: 21 - shrug * 3,
      rightHandX: 21,
      rightHandY: 21 - shrug * 3,
      leftFootX: 9,
      leftFootY: 33,
      rightFootX: 18,
      rightFootY: 33,
      look: 0,
    };
  }

  if (state === "done") {
    const jump = [0, 2, 4, 1][frame];
    return {
      headX: 11,
      headY: 10 - jump,
      shoulderX: 13,
      shoulderY: 16 - jump,
      hipX: 13,
      hipY: 25 - jump,
      leftHandX: 7,
      leftHandY: 10 - jump,
      rightHandX: 20,
      rightHandY: 10 - jump,
      leftFootX: 9 - (frame === 2 ? 2 : 0),
      leftFootY: 33 - jump,
      rightFootX: 18 + (frame === 2 ? 2 : 0),
      rightFootY: 33 - jump,
      look: 0,
    };
  }

  if (state === "idle") {
    const breathe = frame === 2 ? 1 : 0;
    return {
      headX: 5,
      headY: 21 + breathe,
      shoulderX: 11,
      shoulderY: 26 + breathe,
      hipX: 22,
      hipY: 28,
      leftHandX: 13,
      leftHandY: 29,
      rightHandX: 17,
      rightHandY: 26,
      leftFootX: 31,
      leftFootY: 29,
      rightFootX: 32,
      rightFootY: 32,
      look: 1,
    };
  }

  const look = [-1, 0, 1, 0][frame] as -1 | 0 | 1;
  return {
    headX: 10 + look,
    headY: 10,
    shoulderX: 13,
    shoulderY: 16,
    hipX: 13,
    hipY: 25,
    leftHandX: 8,
    leftHandY: 20,
    rightHandX: 20,
    rightHandY: frame % 2 === 0 ? 15 : 23,
    leftFootX: 9,
    leftFootY: 33,
    rightFootX: 18,
    rightFootY: 33,
    look,
  };
}

function drawTerrarium(
  context: CanvasRenderingContext2D,
  palette: ScenePalette,
  state: AgentAvatarState,
  frame: number,
  empty: boolean,
): void {
  fill(context, palette.background, 0, 0, SCENE_SIZE, SCENE_SIZE);
  withAlpha(context, empty ? 0.14 : 0.36, () => {
    fill(context, palette.accent, 1, 1, SCENE_SIZE - 2, 1);
    fill(context, palette.accent, 1, SCENE_SIZE - 2, SCENE_SIZE - 2, 1);
    fill(context, palette.accent, 1, 1, 1, SCENE_SIZE - 2);
    fill(context, palette.accent, SCENE_SIZE - 2, 1, 1, SCENE_SIZE - 2);
  });
  fill(context, palette.wall, 3, 3, 2, 1);
  fill(context, palette.wall, 35, 3, 2, 1);
  fill(context, palette.floor, 3, 34, 34, 1);

  if (empty) {
    fill(context, palette.wall, 15, 31, 10, 1);
    fill(context, palette.wall, 18, 29, 4, 2);
    return;
  }

  if (state === "starting") {
    for (let index = 0; index <= frame; index++) {
      fill(context, palette.accent, 27 + index * 2, 21 - index, 1, 1);
    }
  } else if (state === "blocked") {
    fill(context, palette.wall, 29, 15, 3, 17);
    fill(context, palette.wall, 34, 15, 3, 17);
    fill(context, palette.effect, 29, 15, 8, 2);
    drawGlyph(context, palette.effect, ["111", "001", "011", "000", "010"], 31, 20);
  } else if (state === "done") {
    fill(context, palette.wall, 27, 27, 10, 2);
    fill(context, palette.wall, 30, 29, 4, 5);
    pixelLine(context, palette.detail, 29, 22, 31, 24);
    pixelLine(context, palette.detail, 31, 24, 36, 17);
  } else if (state === "unknown") {
    pixelLine(context, palette.wall, 26, 29, 29, 25);
    pixelLine(context, palette.wall, 29, 25, 33, 28);
    if (frame % 2 === 1) fill(context, palette.effect, 34, 27, 2, 2);
  }
}

function drawWorkingActivity(
  context: CanvasRenderingContext2D,
  palette: ScenePalette,
  activity: AgentAvatarActivity,
  frame: number,
  pose: FigurePose,
): void {
  const beat = [0, 1, 2, 1][frame] ?? 0;

  switch (activity) {
    case "rose-garden": {
      fill(context, palette.wall, 27, 29, 9, 4);
      fill(context, palette.detail, 29, 28, 5, 1);
      pixelLine(context, palette.effect, 30, 28, 30, 17);
      pixelLine(context, palette.effect, 34, 28, 34, 21);
      pixelLine(context, palette.effect, 30, 23, 27, 21);
      drawFlower(context, palette.effect, palette.detail, 28, 14);
      drawFlower(context, palette.detail, palette.effect, 32, 18);
      drawFlower(context, palette.effect, palette.detail, 25, 19 + beat);
      if (frame === 2) fill(context, palette.detail, 36, 16);
      break;
    }
    case "lyre": {
      pixelLine(context, palette.effect, 27, 16, 24, 29, 2);
      pixelLine(context, palette.effect, 33, 16, 36, 29, 2);
      pixelLine(context, palette.effect, 24, 29, 36, 29, 2);
      pixelLine(context, palette.effect, 27, 16, 33, 16, 2);
      for (let x = 27; x <= 33; x += 2) {
        pixelLine(context, palette.detail, x, 18, x, 27);
      }
      fill(context, palette.detail, 29 + (frame % 2) * 2, 20 + beat, 2, 1);
      drawGlyph(context, palette.detail, ["11", "01", "01", "11"], 34, 7 - beat);
      break;
    }
    case "sword-drill": {
      const bladeTips = [
        [21, 5],
        [32, 5],
        [36, 19],
        [29, 31],
      ] as const;
      pixelLine(
        context,
        palette.detail,
        pose.rightHandX,
        pose.rightHandY,
        bladeTips[frame][0],
        bladeTips[frame][1],
        2,
      );
      fill(context, palette.effect, pose.rightHandX - 2, pose.rightHandY - 1, 5, 1);
      fill(context, palette.effect, pose.leftHandX - 2, pose.leftHandY - 3, 4, 7);
      fill(context, palette.wall, 33, 21, 2, 12);
      fill(context, palette.wall, 30, 20, 8, 2);
      if (frame === 2) {
        fill(context, palette.effect, 36, 16);
        fill(context, palette.detail, 37, 19);
        fill(context, palette.effect, 35, 22);
      }
      break;
    }
    case "archery": {
      pixelLine(context, palette.detail, 31, 8, 35, 13);
      pixelLine(context, palette.detail, 35, 13, 36, 19);
      pixelLine(context, palette.detail, 36, 19, 34, 26);
      pixelLine(context, palette.detail, 34, 26, 30, 31);
      if (frame === 2) {
        pixelLine(context, palette.effect, 31, 8, 36, 19);
        pixelLine(context, palette.effect, 36, 19, 30, 31);
        pixelLine(context, palette.detail, 31, 18, 38, 18);
        fill(context, palette.detail, 37, 17, 2, 3);
      } else {
        pixelLine(context, palette.effect, 31, 8, pose.rightHandX, pose.rightHandY);
        pixelLine(context, palette.effect, pose.rightHandX, pose.rightHandY, 30, 31);
        pixelLine(context, palette.detail, pose.rightHandX, 18, 38, 18);
      }
      fill(context, palette.effect, 30, 5, 5, 7);
      fill(context, palette.background, 32, 5, 4, 5);
      break;
    }
    case "weaving": {
      fill(context, palette.wall, 25, 7, 2, 27);
      fill(context, palette.wall, 35, 7, 2, 27);
      fill(context, palette.wall, 25, 7, 12, 2);
      fill(context, palette.wall, 25, 31, 12, 2);
      for (let x = 28; x <= 34; x += 2) {
        pixelLine(context, palette.detail, x, 9, x, 30);
      }
      for (let y = 17; y <= 27; y += 3) {
        fill(context, y % 2 === 0 ? palette.accent : palette.effect, 27, y, 8, 1);
      }
      fill(context, palette.effect, 24 + frame * 2, 18 + beat * 2, 6, 2);
      fill(context, palette.detail, 32, 3, 5, 4);
      fill(context, palette.background, 33, 4);
      fill(context, palette.background, 35, 4);
      break;
    }
    case "harvest": {
      for (let index = 0; index < 3; index++) {
        const x = 28 + index * 4;
        const top = 15 + (index % 2) * 3;
        if (!(frame === 2 && index === 0)) {
          pixelLine(context, palette.effect, x, 32, x, top);
          fill(context, palette.detail, x - 2, top + 1, 2, 1);
          fill(context, palette.detail, x + 1, top + 3, 2, 1);
          fill(context, palette.detail, x - 2, top + 5, 2, 1);
        }
      }
      pixelLine(
        context,
        palette.detail,
        pose.rightHandX,
        pose.rightHandY,
        32,
        26 - beat,
      );
      pixelLine(context, palette.effect, 32, 26 - beat, 36, 23 - beat);
      pixelLine(context, palette.effect, 36, 23 - beat, 38, 25 - beat);
      if (frame === 2) pixelLine(context, palette.detail, 27, 31, 34, 29);
      break;
    }
    case "summoning": {
      withAlpha(context, 0.5 + beat * 0.16, () => {
        fill(context, palette.effect, 3, 17 - beat, 2, 12 + beat * 2);
        fill(context, palette.effect, 5, 14 - beat, 6, 2);
        fill(context, palette.detail, 10, 17 - beat, 2, 12 + beat * 2);
        fill(context, palette.detail, 5, 30 + beat, 6, 2);
        fill(context, palette.effect, 29, 17 - beat, 2, 12 + beat * 2);
        fill(context, palette.detail, 31, 14 - beat, 5, 2);
        fill(context, palette.effect, 31, 30 + beat, 5, 2);
        fill(context, palette.detail, 36, 17 - beat, 2, 12 + beat * 2);
      });
      drawGlyph(context, palette.detail, ["111", "101", "111", "010"], 6, 18 - beat * 2);
      drawGlyph(context, palette.effect, ["111", "101", "111", "010"], 32, 20 - beat * 3);
      break;
    }
    case "smithing": {
      fill(context, palette.detail, 26, 24, 11, 3);
      fill(context, palette.detail, 29, 27, 5, 6);
      const hammerHeads = [
        [24, 23],
        [21, 9],
        [16, 5],
        [23, 12],
      ] as const;
      pixelLine(
        context,
        palette.effect,
        pose.rightHandX,
        pose.rightHandY,
        hammerHeads[frame][0],
        hammerHeads[frame][1],
        2,
      );
      fill(
        context,
        palette.detail,
        hammerHeads[frame][0] - 2,
        hammerHeads[frame][1] - 1,
        5,
        3,
      );
      pixelLine(context, palette.effect, pose.leftHandX, pose.leftHandY, 31, 25);
      if (frame === 0) {
        fill(context, palette.effect, 24, 21);
        fill(context, palette.detail, 26, 19);
        fill(context, palette.effect, 28, 21);
      }
      break;
    }
    case "royal-audience": {
      const spread = 4 + beat * 2;
      for (let index = 0; index < 5; index++) {
        const x = 32 + Math.round((index - 2) * spread / 4);
        const y = 10 + Math.abs(2 - index) * 2 - beat;
        pixelLine(context, palette.effect, 32, 25, x, y, 2);
        fill(context, palette.detail, x, y, 2, 2);
      }
      fill(context, palette.detail, 30, 24, 5, 5);
      fill(context, palette.background, 33, 25);
      pixelLine(context, palette.effect, pose.leftHandX, pose.leftHandY, 5, 8);
      fill(context, palette.detail, 3, 6, 5, 3);
      if (frame === 2) fill(context, palette.detail, 28, 18, 2, 2);
      break;
    }
    case "courier": {
      fill(context, palette.wall, 30, 13, 2, 20);
      fill(context, palette.effect, 30, 12, 7, 5);
      pixelLine(context, palette.detail, 30, 12, 33, 15);
      pixelLine(context, palette.detail, 36, 12, 33, 15);
      fill(context, palette.detail, pose.rightHandX, pose.rightHandY - 2, 5, 4);
      pixelLine(
        context,
        palette.effect,
        pose.rightHandX,
        pose.rightHandY - 2,
        pose.rightHandX + 2,
        pose.rightHandY,
      );
      fill(context, palette.wall, Math.max(3, pose.headX - 6), 14, 4, 1);
      fill(context, palette.wall, Math.max(3, pose.headX - 8), 19, 6, 1);
      fill(context, palette.wall, Math.max(3, pose.headX - 5), 24, 3, 1);
      break;
    }
    case "tide-calling": {
      const wave = frame % 2;
      pixelLine(context, palette.effect, 2, 31 - wave, 7, 28 + wave);
      pixelLine(context, palette.effect, 7, 28 + wave, 13, 31 - wave);
      pixelLine(context, palette.effect, 13, 31 - wave, 19, 28 + wave);
      pixelLine(context, palette.effect, 19, 28 + wave, 26, 31 - wave);
      pixelLine(context, palette.detail, 26, 31 - wave, 37, 26 - beat);
      pixelLine(context, palette.detail, 24, 31, 29, 7, 2);
      pixelLine(context, palette.detail, 25, 10, 29, 6);
      pixelLine(context, palette.detail, 29, 10, 29, 5);
      pixelLine(context, palette.detail, 33, 10, 29, 6);
      if (frame === 2) fill(context, palette.effect, 35, 22, 2, 2);
      break;
    }
    case "storm-calling": {
      fill(context, palette.detail, 27, 5 - (beat > 1 ? 1 : 0), 9, 3);
      fill(context, palette.detail, 29, 3 - (beat > 1 ? 1 : 0), 5, 2);
      if (frame < 2) {
        pixelLine(context, palette.effect, pose.rightHandX, pose.rightHandY, 24, 10, 2);
        pixelLine(context, palette.effect, 24, 10, 27, 11, 2);
      } else {
        pixelLine(context, palette.effect, pose.rightHandX, pose.rightHandY, 31, 13, 2);
        pixelLine(context, palette.effect, 31, 13, 28, 18, 2);
        pixelLine(context, palette.effect, 28, 18, 32, 19, 2);
        pixelLine(context, palette.effect, 32, 19, 29, 25, 2);
      }
      if (frame === 2) {
        fill(context, palette.detail, 36, 10);
        fill(context, palette.effect, 34, 14);
      }
      break;
    }
  }
}

function drawRestingPlace(
  context: CanvasRenderingContext2D,
  palette: ScenePalette,
  signature: AgentAvatarSignature,
  frame: number,
): void {
  const breathe = frame === 2 ? 1 : 0;
  switch (signature) {
    case "lightning":
      fill(context, palette.detail, 3, 29 + breathe, 33, 4);
      fill(context, palette.detail, 7, 27 + breathe, 8, 2);
      fill(context, palette.detail, 22, 26 + breathe, 9, 3);
      pixelLine(context, palette.effect, 34, 7, 31, 12);
      pixelLine(context, palette.effect, 31, 12, 34, 13);
      break;
    case "wave":
      pixelLine(context, palette.effect, 2, 31, 8, 28 + breathe);
      pixelLine(context, palette.effect, 8, 28 + breathe, 14, 31);
      pixelLine(context, palette.effect, 14, 31, 20, 28 + breathe);
      pixelLine(context, palette.effect, 20, 28 + breathe, 27, 31);
      fill(context, palette.detail, 29, 27, 7, 5);
      break;
    case "peacock":
      fill(context, palette.effect, 3, 28, 34, 5);
      for (let index = 0; index < 5; index++) {
        fill(context, palette.detail, 5 + index * 6, 25 - (index % 2), 2, 2);
      }
      break;
    case "owl":
      fill(context, palette.wall, 3, 30, 34, 3);
      fill(context, palette.detail, 28, 26, 8, 2);
      fill(context, palette.detail, 30, 23, 6, 2);
      fill(context, palette.effect, 31, 17, 5, 5);
      fill(context, palette.background, 32, 18);
      fill(context, palette.background, 34, 18);
      break;
    case "sun":
      fill(context, palette.detail, 4, 29, 32, 4);
      fill(context, palette.effect, 30, 5, 5, 5);
      fill(context, palette.effect, 27, 28, 1, 5);
      fill(context, palette.effect, 30, 26, 1, 7);
      fill(context, palette.effect, 33, 28, 1, 5);
      break;
    case "moon":
      fill(context, palette.effect, 3, 29, 34, 4);
      fill(context, palette.detail, 30, 4, 5, 7);
      fill(context, palette.background, 32, 4, 4, 5);
      fill(context, palette.detail, 3, 26, 2, 3);
      fill(context, palette.detail, 35, 25, 2, 4);
      break;
    case "sword":
      fill(context, palette.effect, 3, 26, 34, 7);
      fill(context, palette.detail, 5, 27, 30, 1);
      pixelLine(context, palette.detail, 32, 23, 36, 14);
      break;
    case "hearts":
      fill(context, palette.effect, 3, 28, 34, 5);
      drawHeart(context, palette.detail, 30, 7 - breathe);
      fill(context, palette.detail, 4, 25, 2, 2);
      fill(context, palette.detail, 35, 24, 2, 3);
      break;
    case "message":
      fill(context, palette.wall, 3, 29, 34, 4);
      fill(context, palette.effect, 29, 25, 8, 6);
      pixelLine(context, palette.detail, 29, 25, 33, 28);
      pixelLine(context, palette.detail, 36, 25, 33, 28);
      fill(context, palette.detail, 4, 28, 4, 2);
      break;
    case "forge":
      fill(context, palette.wall, 3, 29, 24, 4);
      fill(context, palette.detail, 29, 25, 8, 3);
      fill(context, palette.detail, 31, 28, 4, 5);
      fill(context, palette.effect, 33, 20 + breathe, 2, 3);
      break;
    case "wheat":
      fill(context, palette.effect, 3, 29, 34, 4);
      for (let index = 0; index < 6; index++) {
        pixelLine(context, palette.detail, 5 + index * 6, 30, 4 + index * 6, 23 - (index % 2));
        fill(context, palette.detail, 3 + index * 6, 23 - (index % 2), 2, 1);
      }
      break;
    case "portal":
      fill(context, palette.wall, 3, 28, 34, 5);
      fill(context, palette.effect, 29, 25, 8, 3);
      fill(context, palette.detail, 30, 23, 2, 2);
      fill(context, palette.detail, 34, 23, 2, 2);
      fill(context, palette.effect, 32, 26, 2, 2);
      break;
  }
}

function drawGreekCostume(
  context: CanvasRenderingContext2D,
  palette: ScenePalette,
  costume: AgentAvatarCostume,
  pose: FigurePose,
): void {
  const x = pose.headX;
  const y = pose.headY;

  switch (costume) {
    case "flower-dress":
      fill(context, palette.effect, x - 1, y + 1, 1, 4);
      fill(context, palette.effect, x + 5, y + 1, 1, 4);
      fill(context, palette.detail, x + 4, y - 1, 2, 2);
      pixelLine(context, palette.effect, pose.shoulderX - 1, pose.shoulderY + 2, pose.hipX - 3, pose.hipY + 3, 2);
      pixelLine(context, palette.effect, pose.shoulderX + 2, pose.shoulderY + 2, pose.hipX + 4, pose.hipY + 3, 2);
      break;
    case "laurel-tunic":
      fill(context, palette.effect, x, y - 1, 2, 1);
      fill(context, palette.effect, x + 3, y - 2, 2, 1);
      fill(context, palette.detail, pose.shoulderX - 1, pose.shoulderY + 2, 5, 1);
      fill(context, palette.detail, pose.hipX - 2, pose.hipY, 6, 2);
      break;
    case "war-helm":
      fill(context, palette.effect, x - 1, y, 7, 2);
      fill(context, palette.effect, x + 1, y - 3, 3, 3);
      fill(context, palette.detail, x + 5, y + 2, 1, 4);
      pixelLine(context, palette.effect, pose.shoulderX - 2, pose.shoulderY, pose.hipX - 4, pose.hipY + 5, 2);
      break;
    case "moon-huntress":
      pixelLine(context, palette.effect, x - 1, y + 1, x - 4, y + 5, 2);
      fill(context, palette.detail, x + 1, y - 1, 3, 1);
      pixelLine(context, palette.effect, pose.shoulderX + 3, pose.shoulderY + 1, pose.hipX + 5, pose.hipY - 1);
      fill(context, palette.detail, pose.hipX - 2, pose.hipY, 6, 2);
      break;
    case "owl-helm":
      fill(context, palette.effect, x - 1, y, 7, 2);
      fill(context, palette.detail, x + 1, y - 3, 1, 3);
      fill(context, palette.detail, x + 3, y - 4, 1, 4);
      fill(context, palette.detail, x + 5, y - 3, 1, 3);
      fill(context, palette.effect, pose.leftHandX - 2, pose.leftHandY - 1, 3, 4);
      break;
    case "harvest-hood":
      fill(context, palette.effect, x - 1, y, 1, 5);
      fill(context, palette.effect, x, y - 1, 5, 1);
      fill(context, palette.effect, x + 5, y, 1, 5);
      pixelLine(context, palette.effect, pose.shoulderX - 1, pose.shoulderY + 2, pose.hipX - 3, pose.hipY + 3, 2);
      pixelLine(context, palette.effect, pose.shoulderX + 2, pose.shoulderY + 2, pose.hipX + 4, pose.hipY + 3, 2);
      break;
    case "underworld-crown":
      fill(context, palette.effect, x, y - 2, 1, 2);
      fill(context, palette.effect, x + 2, y - 3, 1, 3);
      fill(context, palette.effect, x + 4, y - 2, 1, 2);
      fill(context, palette.detail, x, y + 4, 5, 2);
      pixelLine(context, palette.effect, pose.shoulderX - 2, pose.shoulderY, pose.hipX - 4, pose.hipY + 5, 2);
      break;
    case "smith-apron":
      fill(context, palette.detail, x - 1, y + 3, 2, 3);
      fill(context, palette.detail, x + 4, y + 3, 2, 3);
      fill(context, palette.effect, pose.shoulderX - 2, pose.shoulderY, 7, 2);
      pixelLine(context, palette.effect, pose.shoulderX + 1, pose.shoulderY + 2, pose.hipX + 1, pose.hipY + 2, 3);
      break;
    case "queen-crown":
      fill(context, palette.effect, x, y - 2, 1, 2);
      fill(context, palette.effect, x + 2, y - 4, 1, 4);
      fill(context, palette.effect, x + 4, y - 2, 1, 2);
      fill(context, palette.detail, x - 1, y + 1, 1, 5);
      fill(context, palette.detail, x + 5, y + 1, 1, 5);
      pixelLine(context, palette.effect, pose.shoulderX - 1, pose.shoulderY + 2, pose.hipX - 3, pose.hipY + 3, 2);
      pixelLine(context, palette.effect, pose.shoulderX + 2, pose.shoulderY + 2, pose.hipX + 4, pose.hipY + 3, 2);
      break;
    case "winged-helm":
      fill(context, palette.detail, x - 2, y, 2, 1);
      fill(context, palette.detail, x - 1, y - 1, 1, 1);
      fill(context, palette.detail, x + 5, y, 2, 1);
      fill(context, palette.detail, x + 5, y - 1, 1, 1);
      fill(context, palette.effect, pose.leftFootX - 1, pose.leftFootY - 1, 3, 1);
      fill(context, palette.effect, pose.rightFootX - 1, pose.rightFootY - 1, 3, 1);
      fill(context, palette.detail, pose.hipX - 2, pose.hipY, 6, 2);
      break;
    case "sea-king":
      fill(context, palette.detail, x - 1, y, 1, 4);
      fill(context, palette.detail, x + 5, y, 1, 4);
      fill(context, palette.detail, x, y + 4, 5, 2);
      fill(context, palette.effect, x, y - 1, 1, 1);
      fill(context, palette.effect, x + 2, y - 2, 1, 2);
      fill(context, palette.effect, x + 4, y - 1, 1, 1);
      fill(context, palette.effect, pose.hipX - 2, pose.hipY, 6, 2);
      break;
    case "sky-king":
      fill(context, palette.detail, x - 1, y, 1, 4);
      fill(context, palette.detail, x + 5, y, 1, 4);
      fill(context, palette.detail, x, y + 4, 5, 2);
      fill(context, palette.effect, x, y - 1, 2, 1);
      fill(context, palette.effect, x + 3, y - 2, 2, 1);
      pixelLine(context, palette.detail, pose.shoulderX - 1, pose.shoulderY + 2, pose.hipX - 3, pose.hipY + 3, 2);
      break;
  }
}

function drawFigure(
  context: CanvasRenderingContext2D,
  palette: ScenePalette,
  costume: AgentAvatarCostume,
  pose: FigurePose,
): void {
  const { headX: x, headY: y } = pose;
  fill(context, palette.figure, x + 1, y, 3, 1);
  fill(context, palette.figure, x, y + 1, 5, 3);
  fill(context, palette.figure, x + 1, y + 4, 3, 1);
  fill(context, palette.background, x + 2 + pose.look, y + 2);

  pixelLine(
    context,
    palette.accent,
    pose.shoulderX,
    pose.shoulderY,
    pose.hipX,
    pose.hipY,
    2,
  );
  pixelLine(
    context,
    palette.figure,
    pose.shoulderX,
    pose.shoulderY + 1,
    pose.leftHandX,
    pose.leftHandY,
  );
  pixelLine(
    context,
    palette.figure,
    pose.shoulderX + 2,
    pose.shoulderY + 1,
    pose.rightHandX,
    pose.rightHandY,
  );
  pixelLine(
    context,
    palette.figure,
    pose.hipX,
    pose.hipY,
    pose.leftFootX,
    pose.leftFootY,
  );
  pixelLine(
    context,
    palette.figure,
    pose.hipX + 1,
    pose.hipY,
    pose.rightFootX,
    pose.rightFootY,
  );
  fill(context, palette.figure, pose.leftHandX, pose.leftHandY);
  fill(context, palette.figure, pose.rightHandX, pose.rightHandY);
  drawGreekCostume(context, palette, costume, pose);
}

function drawPersonality(
  context: CanvasRenderingContext2D,
  palette: ScenePalette,
  signature: AgentAvatarSignature,
  state: AgentAvatarState,
  frame: number,
): void {
  const energy = stateEnergy(state, frame);

  switch (signature) {
    case "lightning": {
      fill(context, palette.detail, 27, 5, 8, 2);
      fill(context, palette.detail, 29, 4, 4, 1);
      if (energy > 0) {
        pixelLine(context, palette.effect, 32, 7, 29, 11, 2);
        pixelLine(context, palette.effect, 29, 11, 32, 12, 2);
        pixelLine(context, palette.effect, 32, 12, 29, 16, 2);
      }
      break;
    }
    case "wave": {
      pixelLine(context, palette.effect, 3 + frame, 32, 8 + frame, 30);
      pixelLine(context, palette.effect, 8 + frame, 30, 13 + frame, 32);
      pixelLine(context, palette.detail, 4, 15, 4, 29);
      pixelLine(context, palette.detail, 1, 17, 4, 14);
      pixelLine(context, palette.detail, 7, 17, 4, 14);
      break;
    }
    case "peacock": {
      for (let index = 0; index < 5; index++) {
        const lift = energy > 0 ? index % 2 : 0;
        fill(context, palette.effect, 3 + index * 3, 6 + Math.abs(2 - index) - lift, 2, 2);
        fill(context, palette.detail, 4 + index * 3, 7 + Math.abs(2 - index) - lift);
      }
      break;
    }
    case "owl": {
      fill(context, palette.detail, 3, 5, 7, 5);
      fill(context, palette.background, 4, 6, 2, frame === 2 ? 1 : 2);
      fill(context, palette.background, 7, 6, 2, frame === 2 ? 1 : 2);
      fill(context, palette.effect, 6, 8);
      if (energy > 1) pixelLine(context, palette.effect, 7, 11, 11, 14);
      break;
    }
    case "sun": {
      fill(context, palette.effect, 30, 5, 5, 5);
      if (energy > 0) {
        fill(context, palette.detail, 32, 2);
        fill(context, palette.detail, 32, 12);
        fill(context, palette.detail, 27, 7);
        fill(context, palette.detail, 37, 7);
      }
      break;
    }
    case "moon": {
      fill(context, palette.detail, 30, 4, 5, 7);
      fill(context, palette.background, 32, 4, 4, 5);
      pixelLine(context, palette.effect, 4, 27 - energy, 10, 22 - energy);
      pixelLine(context, palette.effect, 4, 27 - energy, 7, 28 - energy);
      break;
    }
    case "sword": {
      pixelLine(context, palette.detail, 4, 28, 10, 16 - energy);
      fill(context, palette.effect, 2, 28, 6, 1);
      if (energy > 1) pixelLine(context, palette.effect, 31, 7, 36, 12);
      break;
    }
    case "hearts": {
      drawHeart(context, palette.effect, 3, 5 - Math.min(2, energy));
      if (energy > 1) drawHeart(context, palette.detail, 31, 7 - energy);
      break;
    }
    case "message": {
      const offset = state === "working" || state === "done" ? frame * 2 : 0;
      fill(context, palette.detail, 3 + offset, 6, 7, 5);
      pixelLine(context, palette.effect, 3 + offset, 6, 6 + offset, 9);
      pixelLine(context, palette.effect, 9 + offset, 6, 6 + offset, 9);
      fill(context, palette.effect, 8, 31, 2, 1);
      fill(context, palette.effect, 19, 31, 2, 1);
      break;
    }
    case "forge": {
      fill(context, palette.detail, 3, 29, 10, 2);
      fill(context, palette.detail, 5, 31, 6, 3);
      pixelLine(context, palette.effect, 5, 18 - energy, 10, 24);
      if (energy > 0) {
        fill(context, palette.effect, 13, 25 - energy);
        fill(context, palette.detail, 15, 23 - energy);
      }
      break;
    }
    case "wheat": {
      pixelLine(context, palette.effect, 5, 33, 5, 18 - energy);
      for (let index = 0; index < 4; index++) {
        fill(context, palette.detail, 3, 20 + index * 3 - energy, 2, 1);
        fill(context, palette.detail, 6, 18 + index * 3 - energy, 2, 1);
      }
      break;
    }
    case "portal": {
      withAlpha(context, 0.45 + energy * 0.12, () => {
        fill(context, palette.effect, 3, 13, 2, 16);
        fill(context, palette.effect, 5, 10, 6, 2);
        fill(context, palette.effect, 5, 30, 6, 2);
        fill(context, palette.detail, 10, 13, 2, 16);
      });
      drawGlyph(context, palette.detail, ["111", "101", "111", "010"], 31, 5);
      break;
    }
  }
}

function drawStateCue(
  context: CanvasRenderingContext2D,
  palette: ScenePalette,
  state: AgentAvatarState,
  frame: number,
): void {
  if (state === "idle") {
    drawGlyph(context, palette.detail, ["111", "001", "010", "100", "111"], 21, 9 - (frame === 2 ? 1 : 0));
  } else if (state === "blocked") {
    drawGlyph(context, palette.effect, ["111", "001", "011", "000", "010"], 18, 5);
  } else if (state === "done") {
    pixelLine(context, palette.detail, 22, 8, 24, 10);
    pixelLine(context, palette.detail, 24, 10, 28, 5);
    if (frame === 2) {
      fill(context, palette.effect, 4, 4);
      fill(context, palette.detail, 36, 4);
      fill(context, palette.effect, 34, 12);
    }
  } else if (state === "unknown") {
    fill(context, palette.effect, 22, 7);
    fill(context, palette.effect, 25, 7);
    if (frame % 2 === 1) fill(context, palette.effect, 28, 7);
  }
}

function resolvePalette(
  canvas: HTMLCanvasElement,
  deity: AgentAvatarDeity,
  projectColorIndex: number,
): ScenePalette {
  const style = getComputedStyle(canvas);
  return {
    accent:
      style.getPropertyValue(`--project-${projectColorIndex}`).trim() ||
      style.getPropertyValue("--project-0").trim(),
    background: style.getPropertyValue("--agent-avatar-background").trim(),
    wall: style.getPropertyValue("--agent-avatar-wall").trim(),
    floor: style.getPropertyValue("--agent-avatar-floor").trim(),
    figure: style.getPropertyValue("--agent-avatar-figure").trim(),
    effect: style
      .getPropertyValue(`--agent-avatar-${deity}-effect`)
      .trim(),
    detail: style
      .getPropertyValue(`--agent-avatar-${deity}-detail`)
      .trim(),
  };
}

function drawScene(
  canvas: HTMLCanvasElement,
  deity: AgentAvatarDeity,
  state: AgentAvatarState,
  frame: number,
  projectColorIndex: number,
  subdued: boolean,
): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  const personality = AGENT_AVATAR_PERSONALITIES[deity];
  const palette = resolvePalette(canvas, deity, projectColorIndex);
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, SCENE_SIZE, SCENE_SIZE);
  drawTerrarium(context, palette, state, frame, subdued);
  if (!subdued) {
    const pose = poseFor(state, frame, personality.activity);
    if (state === "idle") {
      drawRestingPlace(context, palette, personality.signature, frame);
    } else if (state === "working") {
      drawWorkingActivity(
        context,
        palette,
        personality.activity,
        frame,
        pose,
      );
    } else {
      drawPersonality(context, palette, personality.signature, state, frame);
    }
    drawFigure(context, palette, personality.costume, pose);
    drawStateCue(context, palette, state, frame);
  }
}

export function AgentAvatar({
  avatar,
  projectColorIndex,
}: {
  avatar: AgentAvatarSelection;
  projectColorIndex: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = useReducedMotion();
  const visible = useCanvasVisibility(canvasRef);
  const theme = useAppTheme((state) => state.theme);
  const deityOffset = AGENT_AVATAR_DEITIES.indexOf(avatar.deity) * 137;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (reducedMotion || avatar.subdued || !visible) {
      drawScene(
        canvas,
        avatar.deity,
        avatar.state,
        avatar.subdued ? 0 : AGENT_AVATAR_STATIC_FRAME[avatar.state],
        projectColorIndex,
        avatar.subdued,
      );
      return;
    }

    let renderedFrame = -1;
    return subscribeToFrames((time) => {
      const frame = agentAvatarFrameAt(avatar.state, time + deityOffset);
      if (frame === renderedFrame) return;
      renderedFrame = frame;
      drawScene(
        canvas,
        avatar.deity,
        avatar.state,
        frame,
        projectColorIndex,
        false,
      );
    });
  }, [
    avatar.deity,
    avatar.state,
    avatar.subdued,
    deityOffset,
    projectColorIndex,
    reducedMotion,
    theme,
    visible,
  ]);

  return (
    <canvas
      ref={canvasRef}
      className="agent-avatar-canvas"
      width={SCENE_SIZE}
      height={SCENE_SIZE}
      aria-hidden="true"
    />
  );
}
