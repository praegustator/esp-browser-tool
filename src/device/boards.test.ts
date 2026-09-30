import { describe, expect, it } from 'vitest';
import {
  BOARDS,
  boardById,
  boardForChip,
  canOutput,
  DEFAULT_BOARD,
  hasCapability,
  pinDefinition,
  pinLabel,
  usablePins,
} from './boards';

describe('board catalogue', () => {
  it('maps chip descriptions to the most specific board', () => {
    expect(boardForChip('ESP32-S3 (QFN56) (revision v0.2)').id).toBe('esp32s3');
    expect(boardForChip('ESP32-C3 (revision 3)').id).toBe('esp32c3');
    expect(boardForChip('ESP32-D0WD-V3 (revision 3)').id).toBe('esp32');
    expect(boardForChip(undefined)).toBe(DEFAULT_BOARD);
    expect(boardForChip('RP2040')).toBe(DEFAULT_BOARD);
  });

  it('looks pins up by number', () => {
    expect(pinDefinition(DEFAULT_BOARD, 34)?.capabilities).toContain('input-only');
    expect(pinDefinition(DEFAULT_BOARD, 99)).toBeUndefined();
  });

  it('hides flash and console pins from the usable set', () => {
    const usable = usablePins(DEFAULT_BOARD).map((pin) => pin.gpio);
    for (const flashPin of [6, 7, 8, 9, 10, 11, 1, 3]) {
      expect(usable).not.toContain(flashPin);
    }
    expect(usable).toContain(2);
  });

  it('knows which pins cannot drive a load', () => {
    expect(canOutput(pinDefinition(DEFAULT_BOARD, 34)!)).toBe(false);
    expect(canOutput(pinDefinition(DEFAULT_BOARD, 2)!)).toBe(true);
  });

  it('exposes capabilities and labels', () => {
    expect(hasCapability(pinDefinition(DEFAULT_BOARD, 4)!, 'touch')).toBe(true);
    expect(hasCapability(pinDefinition(DEFAULT_BOARD, 16)!, 'adc')).toBe(false);
    expect(pinLabel(pinDefinition(DEFAULT_BOARD, 36)!)).toBe('VP / GPIO36');
    expect(pinLabel(pinDefinition(DEFAULT_BOARD, 16)!)).toBe('GPIO16');
  });

  it('resolves boards by id', () => {
    expect(boardById('esp32c3')?.chip).toBe('ESP32-C3');
    expect(boardById('nope')).toBeUndefined();
  });

  it('never declares an input-only pin as an output capable one', () => {
    for (const board of BOARDS) {
      for (const pin of board.pins) {
        if (pin.capabilities.includes('input-only')) {
          expect(pin.capabilities).not.toContain('digital');
        }
      }
    }
  });

  it('has unique gpio numbers per board', () => {
    for (const board of BOARDS) {
      const gpios = board.pins.map((pin) => pin.gpio);
      expect(new Set(gpios).size).toBe(gpios.length);
    }
  });
});
