import type { TracePoint } from '../device/pinStateStore';

/**
 * Serialise a trace as CSV: one row per point with the millisecond timestamp
 * (relative to the first point) and whichever measurements the points carry.
 */
export function traceToCsv(points: readonly TracePoint[]): string {
  const rows: string[] = ['time_ms,value,millivolts,level,touch'];
  const start = points[0]?.t ?? 0;
  for (const point of points) {
    rows.push(
      [
        (point.t - start).toFixed(3),
        point.v.toFixed(4),
        point.mv === undefined ? '' : String(point.mv),
        point.d === undefined ? '' : String(point.d),
        point.touch === undefined ? '' : String(point.touch),
      ].join(','),
    );
  }
  return `${rows.join('\n')}\n`;
}

/** Offer `text` as a file download. No-op in environments without Blob URLs. */
export function downloadTextFile(name: string, text: string, type = 'text/csv'): void {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}
