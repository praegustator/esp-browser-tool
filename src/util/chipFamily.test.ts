import { describe, expect, it } from 'vitest';
import { chipFamilyOf, sameChipFamily } from './chipFamily';

describe('chipFamilyOf', () => {
  it('extracts the family token from an esptool chip description', () => {
    expect(chipFamilyOf('ESP32-S3 (QFN56) (revision v0.2)')).toBe('ESP32-S3');
    expect(chipFamilyOf('ESP32-D0WD-V3 (revision v3.0)')).toBe('ESP32');
    expect(chipFamilyOf('ESP32-C6 (revision v0.0)')).toBe('ESP32-C6');
    expect(chipFamilyOf('ESP32-C61')).toBe('ESP32-C61');
    expect(chipFamilyOf('ESP8266EX')).toBe('ESP8266');
  });

  it('never mistakes a newer family for a plain ESP32', () => {
    expect(sameChipFamily('ESP32-C6', 'ESP32')).toBe(false);
    expect(sameChipFamily('ESP32-S3', 'ESP32')).toBe(false);
    expect(sameChipFamily('ESP32-D0WDQ6', 'ESP32')).toBe(true);
  });

  it('falls back to the normalised description for unknown chips', () => {
    expect(chipFamilyOf('RP 2040')).toBe('RP2040');
  });
});
