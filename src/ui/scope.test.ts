import { describe, expect, it } from 'vitest';
import { projectTrace, squareWave } from './scope';
import type { TracePoint } from '../device/pinStateStore';

const geometry = { width: 100, height: 50, windowMs: 1000, padding: 0 };

describe('projectTrace', () => {
  it('maps the newest sample to the right edge', () => {
    const points: TracePoint[] = [
      { t: 0, v: 0 },
      { t: 1000, v: 1 },
    ];
    const projected = projectTrace(points, geometry);
    expect(projected[0]).toMatchObject({ x: 0, y: 50 });
    expect(projected[1]).toMatchObject({ x: 100, y: 0 });
  });

  it('drops samples older than the visible window', () => {
    const points: TracePoint[] = [
      { t: 0, v: 0 },
      { t: 5000, v: 0.5 },
      { t: 5500, v: 1 },
    ];
    expect(projectTrace(points, geometry)).toHaveLength(2);
  });

  it('honours padding and clamps out of range values', () => {
    const projected = projectTrace([{ t: 0, v: 5 }], { ...geometry, padding: 4 });
    expect(projected[0]!.y).toBe(4);
    const low = projectTrace([{ t: 0, v: -3 }], { ...geometry, padding: 4 });
    expect(low[0]!.y).toBe(46);
  });

  it('keeps the digital level on projected points', () => {
    const projected = projectTrace([{ t: 0, v: 1, d: 1 }], geometry);
    expect(projected[0]!.d).toBe(1);
  });

  it('returns nothing for an empty trace', () => {
    expect(projectTrace([], geometry)).toEqual([]);
  });
});

describe('squareWave', () => {
  it('inserts a vertical edge between differing levels', () => {
    const shaped = squareWave([
      { x: 0, y: 10, d: 0 },
      { x: 10, y: 0, d: 1 },
    ]);
    expect(shaped).toEqual([
      { x: 0, y: 10, d: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 0, d: 1 },
    ]);
  });

  it('leaves a constant level untouched', () => {
    const points = [
      { x: 0, y: 5 },
      { x: 5, y: 5 },
    ];
    expect(squareWave(points)).toEqual(points);
  });
});
