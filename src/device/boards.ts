/**
 * Static knowledge about the ESP32 family: which GPIO can do what, which ones
 * are risky to drive, and how they are labelled on common dev boards. The tool
 * uses this to guide the user away from strapping/flash pins before they brick
 * a boot, and to pre-select sensible defaults.
 */

export type PinCapability = 'digital' | 'input-only' | 'adc' | 'dac' | 'touch' | 'i2c' | 'spi' | 'uart';

export interface PinDefinition {
  gpio: number;
  /** Silkscreen label, when it differs from `GPIOn`. */
  label?: string;
  capabilities: PinCapability[];
  /** Short explanation shown when the pin needs care. */
  warning?: string;
  /** Pins that are unsafe to touch at all while the board is running. */
  reserved?: boolean;
  /** ADC unit/channel, e.g. `ADC1_CH0`. */
  adc?: string;
  /** Touch channel name, e.g. `T0`. */
  touch?: string;
  /** Default function on most dev boards (LED, BOOT button...). */
  note?: string;
}

export interface BoardDefinition {
  id: string;
  name: string;
  chip: string;
  /** Chip families reported by esptool that map to this board. */
  chipMatches: string[];
  /** Onboard LED GPIO, when there is one. */
  ledPin?: number;
  defaultI2c?: { sda: number; scl: number };
  pins: PinDefinition[];
}

const esp32Pins: PinDefinition[] = [
  {
    gpio: 0,
    capabilities: ['digital', 'adc', 'touch'],
    adc: 'ADC2_CH1',
    touch: 'T1',
    warning: 'Strapping pin (BOOT). Pulling it low at reset enters the bootloader.',
    note: 'BOOT button on most dev boards',
  },
  { gpio: 1, capabilities: ['digital', 'uart'], warning: 'UART0 TX — used by the USB console.', reserved: true, label: 'TX0' },
  { gpio: 2, capabilities: ['digital', 'adc', 'touch'], adc: 'ADC2_CH2', touch: 'T2', note: 'Onboard LED on many boards' },
  { gpio: 3, capabilities: ['digital', 'uart'], warning: 'UART0 RX — used by the USB console.', reserved: true, label: 'RX0' },
  { gpio: 4, capabilities: ['digital', 'adc', 'touch'], adc: 'ADC2_CH0', touch: 'T0' },
  { gpio: 5, capabilities: ['digital', 'spi'], warning: 'Strapping pin, outputs a PWM signal at boot.' },
  { gpio: 6, capabilities: ['digital'], reserved: true, warning: 'Connected to the SPI flash (SCK).' },
  { gpio: 7, capabilities: ['digital'], reserved: true, warning: 'Connected to the SPI flash (SDO).' },
  { gpio: 8, capabilities: ['digital'], reserved: true, warning: 'Connected to the SPI flash (SDI).' },
  { gpio: 9, capabilities: ['digital'], reserved: true, warning: 'Connected to the SPI flash (SHD).' },
  { gpio: 10, capabilities: ['digital'], reserved: true, warning: 'Connected to the SPI flash (SWP).' },
  { gpio: 11, capabilities: ['digital'], reserved: true, warning: 'Connected to the SPI flash (CSC).' },
  {
    gpio: 12,
    capabilities: ['digital', 'adc', 'touch'],
    adc: 'ADC2_CH5',
    touch: 'T5',
    warning: 'Strapping pin (MTDI). Must be low at reset or the flash voltage changes.',
  },
  { gpio: 13, capabilities: ['digital', 'adc', 'touch'], adc: 'ADC2_CH4', touch: 'T4' },
  { gpio: 14, capabilities: ['digital', 'adc', 'touch'], adc: 'ADC2_CH6', touch: 'T6', warning: 'Outputs a PWM signal at boot.' },
  { gpio: 15, capabilities: ['digital', 'adc', 'touch'], adc: 'ADC2_CH3', touch: 'T3', warning: 'Strapping pin, silences the boot log when low.' },
  { gpio: 16, capabilities: ['digital'] },
  { gpio: 17, capabilities: ['digital'] },
  { gpio: 18, capabilities: ['digital', 'spi'], note: 'VSPI SCK' },
  { gpio: 19, capabilities: ['digital', 'spi'], note: 'VSPI MISO' },
  { gpio: 21, capabilities: ['digital', 'i2c'], note: 'Default I²C SDA' },
  { gpio: 22, capabilities: ['digital', 'i2c'], note: 'Default I²C SCL' },
  { gpio: 23, capabilities: ['digital', 'spi'], note: 'VSPI MOSI' },
  { gpio: 25, capabilities: ['digital', 'adc', 'dac'], adc: 'ADC2_CH8', note: 'DAC1' },
  { gpio: 26, capabilities: ['digital', 'adc', 'dac'], adc: 'ADC2_CH9', note: 'DAC2' },
  { gpio: 27, capabilities: ['digital', 'adc', 'touch'], adc: 'ADC2_CH7', touch: 'T7' },
  { gpio: 32, capabilities: ['digital', 'adc', 'touch'], adc: 'ADC1_CH4', touch: 'T9' },
  { gpio: 33, capabilities: ['digital', 'adc', 'touch'], adc: 'ADC1_CH5', touch: 'T8' },
  { gpio: 34, capabilities: ['input-only', 'adc'], adc: 'ADC1_CH6', warning: 'Input only, no internal pull-up/pull-down.' },
  { gpio: 35, capabilities: ['input-only', 'adc'], adc: 'ADC1_CH7', warning: 'Input only, no internal pull-up/pull-down.' },
  { gpio: 36, capabilities: ['input-only', 'adc'], adc: 'ADC1_CH0', label: 'VP', warning: 'Input only, no internal pull-up/pull-down.' },
  { gpio: 39, capabilities: ['input-only', 'adc'], adc: 'ADC1_CH3', label: 'VN', warning: 'Input only, no internal pull-up/pull-down.' },
];

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function simplePins(
  gpios: number[],
  overrides: Record<number, Partial<PinDefinition>> = {},
): PinDefinition[] {
  return gpios.map((gpio) => ({
    gpio,
    capabilities: ['digital'] as PinCapability[],
    ...overrides[gpio],
  }));
}

const esp32s3Pins: PinDefinition[] = simplePins(
  [...range(0, 21), ...range(35, 48)],
  {
    0: {
      capabilities: ['digital'],
      warning: 'Strapping pin (BOOT button).',
      note: 'BOOT button',
    },
    3: { capabilities: ['digital', 'adc'], adc: 'ADC1_CH2', warning: 'Strapping pin (JTAG source select).' },
    1: { capabilities: ['digital', 'adc', 'touch'], adc: 'ADC1_CH0', touch: 'T1' },
    2: { capabilities: ['digital', 'adc', 'touch'], adc: 'ADC1_CH1', touch: 'T2' },
    4: { capabilities: ['digital', 'adc', 'touch'], adc: 'ADC1_CH3', touch: 'T4' },
    5: { capabilities: ['digital', 'adc', 'touch'], adc: 'ADC1_CH4', touch: 'T5' },
    6: { capabilities: ['digital', 'adc', 'touch'], adc: 'ADC1_CH5', touch: 'T6' },
    7: { capabilities: ['digital', 'adc', 'touch'], adc: 'ADC1_CH6', touch: 'T7' },
    8: { capabilities: ['digital', 'adc', 'touch', 'i2c'], adc: 'ADC1_CH7', touch: 'T8', note: 'Default I²C SDA' },
    9: { capabilities: ['digital', 'adc', 'touch', 'i2c'], adc: 'ADC1_CH8', touch: 'T9', note: 'Default I²C SCL' },
    10: { capabilities: ['digital', 'adc', 'touch', 'spi'], adc: 'ADC1_CH9', touch: 'T10' },
    11: { capabilities: ['digital', 'adc', 'touch', 'spi'], adc: 'ADC2_CH0', touch: 'T11' },
    12: { capabilities: ['digital', 'adc', 'touch', 'spi'], adc: 'ADC2_CH1', touch: 'T12' },
    13: { capabilities: ['digital', 'adc', 'touch'], adc: 'ADC2_CH2', touch: 'T13' },
    14: { capabilities: ['digital', 'adc', 'touch'], adc: 'ADC2_CH3', touch: 'T14' },
    19: { capabilities: ['digital'], warning: 'USB D- on boards using native USB.', note: 'USB D-' },
    20: { capabilities: ['digital'], warning: 'USB D+ on boards using native USB.', note: 'USB D+' },
    43: { capabilities: ['digital', 'uart'], label: 'TX0', warning: 'UART0 TX — used by the USB console.', reserved: true },
    44: { capabilities: ['digital', 'uart'], label: 'RX0', warning: 'UART0 RX — used by the USB console.', reserved: true },
    45: { capabilities: ['digital'], warning: 'Strapping pin (VDD_SPI voltage).' },
    46: { capabilities: ['digital'], warning: 'Strapping pin, input only on some revisions.' },
    48: { capabilities: ['digital'], note: 'Onboard RGB LED on many S3 boards' },
  },
);

const esp32c3Pins: PinDefinition[] = simplePins([...range(0, 10), ...range(18, 21)], {
  0: { capabilities: ['digital', 'adc'], adc: 'ADC1_CH0' },
  1: { capabilities: ['digital', 'adc'], adc: 'ADC1_CH1' },
  2: { capabilities: ['digital', 'adc'], adc: 'ADC1_CH2', warning: 'Strapping pin.' },
  3: { capabilities: ['digital', 'adc'], adc: 'ADC1_CH3' },
  4: { capabilities: ['digital', 'adc'], adc: 'ADC1_CH4' },
  5: { capabilities: ['digital', 'adc'], adc: 'ADC2_CH0' },
  8: { capabilities: ['digital', 'i2c'], warning: 'Strapping pin.', note: 'Default I²C SDA / onboard LED' },
  9: { capabilities: ['digital', 'i2c'], warning: 'Strapping pin (BOOT button).', note: 'Default I²C SCL / BOOT' },
  18: { capabilities: ['digital'], note: 'USB D-' },
  19: { capabilities: ['digital'], note: 'USB D+' },
  20: { capabilities: ['digital', 'uart'], label: 'RX0', reserved: true, warning: 'UART0 RX — used by the USB console.' },
  21: { capabilities: ['digital', 'uart'], label: 'TX0', reserved: true, warning: 'UART0 TX — used by the USB console.' },
});

export const BOARDS: BoardDefinition[] = [
  {
    id: 'esp32',
    name: 'ESP32 DevKit (WROOM/WROVER)',
    chip: 'ESP32',
    chipMatches: ['ESP32', 'ESP32-D0WD', 'ESP32-D0WDQ6', 'ESP32-PICO'],
    ledPin: 2,
    defaultI2c: { sda: 21, scl: 22 },
    pins: esp32Pins,
  },
  {
    id: 'esp32s3',
    name: 'ESP32-S3 DevKit',
    chip: 'ESP32-S3',
    chipMatches: ['ESP32-S3'],
    ledPin: 48,
    defaultI2c: { sda: 8, scl: 9 },
    pins: esp32s3Pins,
  },
  {
    id: 'esp32c3',
    name: 'ESP32-C3 DevKit',
    chip: 'ESP32-C3',
    chipMatches: ['ESP32-C3'],
    ledPin: 8,
    defaultI2c: { sda: 8, scl: 9 },
    pins: esp32c3Pins,
  },
];

export const DEFAULT_BOARD = BOARDS[0]!;

/** Best effort mapping from a chip description to a known board layout. */
export function boardForChip(chip: string | undefined): BoardDefinition {
  if (!chip) return DEFAULT_BOARD;
  const needle = chip.toUpperCase();
  // Longest match first so "ESP32-S3" never falls back to plain "ESP32".
  const candidates = BOARDS.flatMap((board) =>
    board.chipMatches.map((match) => ({ board, match: match.toUpperCase() })),
  ).sort((a, b) => b.match.length - a.match.length);
  return candidates.find(({ match }) => needle.includes(match))?.board ?? DEFAULT_BOARD;
}

export function boardById(id: string): BoardDefinition | undefined {
  return BOARDS.find((board) => board.id === id);
}

export function pinDefinition(board: BoardDefinition, gpio: number): PinDefinition | undefined {
  return board.pins.find((pin) => pin.gpio === gpio);
}

/** Pins the tool is willing to expose by default (reserved ones hidden). */
export function usablePins(board: BoardDefinition): PinDefinition[] {
  return board.pins.filter((pin) => !pin.reserved);
}

export function canOutput(pin: PinDefinition): boolean {
  return !pin.capabilities.includes('input-only');
}

export function hasCapability(pin: PinDefinition, capability: PinCapability): boolean {
  return pin.capabilities.includes(capability);
}

export function pinLabel(pin: PinDefinition): string {
  return pin.label ? `${pin.label} / GPIO${pin.gpio}` : `GPIO${pin.gpio}`;
}
