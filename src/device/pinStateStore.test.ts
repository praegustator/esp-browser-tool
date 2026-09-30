import { describe, expect, it } from 'vitest';
import { PinStateStore, formatValue } from './pinStateStore';

describe('PinStateStore', () => {
  it('ingests sample events into per-pin traces', () => {
    const store = new PinStateStore({ capacity: 10 });
    store.ingest({ ev: 'sample', t: 0, pins: { '2': { d: 0 }, '34': { a: 2048, mv: 1650 } } });
    store.ingest({ ev: 'sample', t: 100, pins: { '2': { d: 1 }, '34': { a: 4095, mv: 3300 } } });
    expect(store.get(2).trace.length).toBe(2);
    expect(store.get(2).last?.d).toBe(1);
    expect(store.get(34).last?.v).toBeCloseTo(1, 3);
    expect(store.get(34).stats.minMv).toBe(1650);
    expect(store.get(34).stats.maxMv).toBe(3300);
  });

  it('counts digital transitions and estimates frequency', () => {
    const store = new PinStateStore();
    for (let index = 0; index <= 10; index++) {
      store.record(5, index * 100, { d: (index % 2) as 0 | 1 });
    }
    const stats = store.get(5).stats;
    expect(stats.transitions).toBe(10);
    // 10 transitions => 5 full cycles over 1 second.
    expect(stats.frequencyHz).toBeCloseTo(5, 5);
    expect(stats.dutyCycle).toBeCloseTo(5 / 11, 5);
  });

  it('derives millivolts from raw ADC counts when absent', () => {
    const store = new PinStateStore({ adcMax: 4095 });
    const point = store.record(32, 0, { a: 2048 });
    expect(point.mv).toBe(1650);
    expect(point.v).toBeCloseTo(0.5, 2);
  });

  it('inverts touch readings for plotting', () => {
    const store = new PinStateStore();
    const idle = store.record(4, 0, { t: 72 });
    const pressed = store.record(4, 10, { t: 20 });
    expect(pressed.v).toBeGreaterThan(idle.v);
  });

  it('clears the trace when the mode changes', () => {
    const store = new PinStateStore();
    store.setMode(2, 'output');
    store.record(2, 0, { d: 1 });
    store.setMode(2, 'input');
    expect(store.get(2).trace.length).toBe(0);
    expect(store.get(2).stats.transitions).toBe(0);
  });

  it('tracks watched pins and pwm/blink metadata', () => {
    const store = new PinStateStore();
    store.setWatched(2, true);
    store.setWatched(4, false);
    expect(store.watchedPins()).toEqual([2]);
    store.setPwm(2, 1000, 0.25);
    expect(store.get(2).pwm).toEqual({ freq: 1000, duty: 0.25 });
    store.setBlink(2, 500);
    expect(store.get(2).blink).toBe(500);
    expect(store.get(2).pwm).toBeUndefined();
    store.setBlink(2, 0);
    expect(store.get(2).blink).toBeUndefined();
  });

  it('keeps only the most recent points', () => {
    const store = new PinStateStore({ capacity: 3 });
    for (let index = 0; index < 6; index++) store.record(2, index, { d: 1 });
    expect(store.get(2).trace.length).toBe(3);
    expect(store.get(2).trace.at(0)?.t).toBe(3);
  });
});

describe('PinStateStore duty cycle', () => {
  it('only counts samples still inside the trace window', () => {
    const store = new PinStateStore({ capacity: 4 });
    for (let index = 0; index < 4; index++) store.record(2, index * 10, { d: 1 });
    expect(store.get(2).stats.dutyCycle).toBe(1);
    for (let index = 4; index < 8; index++) store.record(2, index * 10, { d: 0 });
    expect(store.get(2).stats.dutyCycle).toBe(0);
  });

  it('resets the counters when the trace is cleared', () => {
    const store = new PinStateStore({ capacity: 4 });
    store.record(2, 0, { d: 1 });
    store.clearTrace(2);
    expect(store.get(2).stats.dutyCycle).toBeUndefined();
    store.record(2, 10, { d: 0 });
    expect(store.get(2).stats.dutyCycle).toBe(0);
  });
});

describe('formatValue', () => {
  it('formats according to the pin mode', () => {
    const store = new PinStateStore();
    store.setMode(2, 'output');
    store.record(2, 0, { d: 1 });
    expect(formatValue(store.get(2))).toBe('HIGH');

    store.setMode(34, 'analog');
    store.record(34, 0, { a: 2048, mv: 1650 });
    expect(formatValue(store.get(34))).toBe('1.650 V');

    store.setMode(4, 'touch');
    store.record(4, 0, { t: 42 });
    expect(formatValue(store.get(4))).toBe('42');

    expect(formatValue(store.get(99))).toBe('—');
  });
});
