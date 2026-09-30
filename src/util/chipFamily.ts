/**
 * Chip family detection.
 *
 * Both the firmware manifest and the board catalogue need to know which member
 * of the ESP family a device belongs to. Substring matching alone is unsafe —
 * "ESP32-C6" contains "ESP32" — so chip descriptions are normalised to one of
 * the known family tokens first.
 */
export const CHIP_FAMILIES = [
  'ESP32-S2',
  'ESP32-S3',
  'ESP32-C2',
  'ESP32-C3',
  'ESP32-C5',
  'ESP32-C61',
  'ESP32-C6',
  'ESP32-H2',
  'ESP32-P4',
  'ESP8266',
  'ESP32',
] as const;

export type ChipFamily = (typeof CHIP_FAMILIES)[number];

const ORDERED = [...CHIP_FAMILIES].sort((a, b) => b.length - a.length);

/**
 * Normalise a chip description (`"ESP32-S3 (QFN56) (revision v0.2)"`) to its
 * family token (`"ESP32-S3"`). Unknown chips are returned upper-cased and
 * stripped of whitespace so comparisons stay predictable.
 */
export function chipFamilyOf(chip: string): string {
  const needle = chip.toUpperCase().replace(/\s+/g, '');
  return ORDERED.find((family) => needle.includes(family)) ?? needle;
}

/** True when two chip descriptions denote the same family. */
export function sameChipFamily(a: string, b: string): boolean {
  return chipFamilyOf(a) === chipFamilyOf(b);
}
