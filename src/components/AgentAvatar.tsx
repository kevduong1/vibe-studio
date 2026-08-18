import { useEffect, useRef, useState, type RefObject } from "react";
import {
  AGENT_AVATAR_DEITIES,
  AGENT_AVATAR_GRID,
  AGENT_AVATAR_STATIC_FRAME,
  agentAvatarFrameAt,
  agentAvatarPaletteVars,
  composeAgentAvatarEmpty,
  composeAgentAvatarFrame,
  type AgentAvatarDeity,
  type AgentAvatarLayer,
  type AgentAvatarPaletteKey,
  type AgentAvatarSelection,
  type AgentAvatarState,
} from "../lib/agentAvatars";
import { useAppTheme } from "../lib/appTheme";

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

type SpritePalette = Partial<Record<AgentAvatarPaletteKey, string>>;

/** Theme tokens are read once per effect run (deity/project/theme are effect
 * deps), never per animation frame. */
function resolvePalette(
  canvas: HTMLCanvasElement,
  deity: AgentAvatarDeity,
  projectColorIndex: number,
): SpritePalette {
  const style = getComputedStyle(canvas);
  const palette: SpritePalette = {};
  const vars = agentAvatarPaletteVars(deity, projectColorIndex);
  for (const [key, name] of Object.entries(vars)) {
    const color = style.getPropertyValue(name).trim();
    if (color) palette[key as AgentAvatarPaletteKey] = color;
  }
  return palette;
}

/** Blits one layer, merging same-color runs inside a row into one fillRect. */
function drawLayer(
  context: CanvasRenderingContext2D,
  palette: SpritePalette,
  layer: AgentAvatarLayer,
): void {
  context.globalAlpha = layer.alpha;
  layer.rows.forEach((row, rowIndex) => {
    const y = layer.y + rowIndex;
    if (y < 0 || y >= AGENT_AVATAR_GRID) return;
    let runColor: string | undefined;
    let runStart = 0;
    let runLength = 0;

    const flush = () => {
      if (runColor && runLength > 0) {
        context.fillStyle = runColor;
        context.fillRect(layer.x + runStart, y, runLength, 1);
      }
      runColor = undefined;
      runLength = 0;
    };

    for (let column = 0; column < row.length; column++) {
      const x = layer.x + column;
      const color =
        x < 0 || x >= AGENT_AVATAR_GRID
          ? undefined
          : palette[row[column] as AgentAvatarPaletteKey];
      if (color && color === runColor) {
        runLength += 1;
        continue;
      }
      flush();
      if (color) {
        runColor = color;
        runStart = column;
        runLength = 1;
      }
    }
    flush();
  });
  context.globalAlpha = 1;
}

function drawFrame(
  canvas: HTMLCanvasElement,
  palette: SpritePalette,
  layers: readonly AgentAvatarLayer[],
): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, AGENT_AVATAR_GRID, AGENT_AVATAR_GRID);
  for (const layer of layers) drawLayer(context, palette, layer);
}

function framesFor(
  deity: AgentAvatarDeity,
  state: AgentAvatarState,
  subdued: boolean,
  frame: number,
): AgentAvatarLayer[] {
  return subdued
    ? composeAgentAvatarEmpty()
    : composeAgentAvatarFrame(deity, state, frame);
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
    const palette = resolvePalette(canvas, avatar.deity, projectColorIndex);

    if (reducedMotion || avatar.subdued || !visible) {
      drawFrame(
        canvas,
        palette,
        framesFor(
          avatar.deity,
          avatar.state,
          avatar.subdued,
          AGENT_AVATAR_STATIC_FRAME[avatar.state],
        ),
      );
      return;
    }

    let renderedFrame = -1;
    return subscribeToFrames((time) => {
      const frame = agentAvatarFrameAt(avatar.state, time + deityOffset);
      if (frame === renderedFrame) return;
      renderedFrame = frame;
      drawFrame(
        canvas,
        palette,
        framesFor(avatar.deity, avatar.state, false, frame),
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
      width={AGENT_AVATAR_GRID}
      height={AGENT_AVATAR_GRID}
      aria-hidden="true"
    />
  );
}
