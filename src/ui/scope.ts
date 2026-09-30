import type { TracePoint } from '../device/pinStateStore';

export interface ScopeGeometry {
  width: number;
  height: number;
  /** Visible time span in milliseconds, ending at the newest sample. */
  windowMs: number;
  /** Padding kept free at the top and bottom, in pixels. */
  padding?: number;
}

export interface ScopePoint {
  x: number;
  y: number;
  /** Digital level when the source point carried one. */
  d?: 0 | 1;
}

/**
 * Project trace points onto canvas coordinates.
 *
 * Kept pure (and separate from any canvas call) so the scope maths can be unit
 * tested headlessly — the drawing code below is then a thin shell.
 */
export function projectTrace(points: readonly TracePoint[], geometry: ScopeGeometry): ScopePoint[] {
  if (points.length === 0) return [];
  const padding = geometry.padding ?? 2;
  const usableHeight = Math.max(1, geometry.height - padding * 2);
  const end = points[points.length - 1]!.t;
  const start = end - geometry.windowMs;
  const span = Math.max(1, geometry.windowMs);
  const projected: ScopePoint[] = [];
  for (const point of points) {
    if (point.t < start) continue;
    const x = ((point.t - start) / span) * geometry.width;
    const y = padding + (1 - clamp01(point.v)) * usableHeight;
    projected.push(point.d === undefined ? { x, y } : { x, y, d: point.d });
  }
  return projected;
}

/**
 * Insert the extra vertices that turn a digital sample sequence into the
 * square wave an oscilloscope would show.
 */
export function squareWave(points: readonly ScopePoint[]): ScopePoint[] {
  const result: ScopePoint[] = [];
  let previous: ScopePoint | undefined;
  for (const point of points) {
    if (previous && previous.y !== point.y) {
      result.push({ x: point.x, y: previous.y });
    }
    result.push(point);
    previous = point;
  }
  return result;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export interface ScopeStyle {
  stroke: string;
  fill?: string;
  grid: string;
  background: string;
  /** Draw the trace as a square wave (digital) instead of a smooth line. */
  digital: boolean;
}

/**
 * Render one trace into a canvas 2D context.
 *
 * The canvas is expected to already be sized in device pixels; `width` and
 * `height` are the CSS pixel dimensions the caller scaled the context to.
 */
export function drawScope(
  ctx: CanvasRenderingContext2D,
  points: readonly TracePoint[],
  geometry: ScopeGeometry,
  style: ScopeStyle,
): void {
  const { width, height } = geometry;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = style.background;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = style.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let index = 1; index < 4; index++) {
    const y = Math.round((height / 4) * index) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  const projected = projectTrace(points, geometry);
  if (projected.length === 0) return;
  const shaped = style.digital ? squareWave(projected) : projected;

  if (style.fill) {
    ctx.beginPath();
    ctx.moveTo(shaped[0]!.x, height);
    for (const point of shaped) ctx.lineTo(point.x, point.y);
    ctx.lineTo(shaped[shaped.length - 1]!.x, height);
    ctx.closePath();
    ctx.fillStyle = style.fill;
    ctx.fill();
  }

  ctx.beginPath();
  ctx.moveTo(shaped[0]!.x, shaped[0]!.y);
  for (const point of shaped.slice(1)) ctx.lineTo(point.x, point.y);
  ctx.strokeStyle = style.stroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

/** Resize a canvas for the current device pixel ratio and return its context. */
export function prepareCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): CanvasRenderingContext2D | null {
  const ratio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    // Environments without a 2D canvas implementation (jsdom, some kiosk
    // browsers) simply do not get a scope.
    return null;
  }
  if (!ctx) return null;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return ctx;
}
