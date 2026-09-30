/**
 * Wire protocol shared by the browser tool and the ESP32 diagnostic firmware.
 *
 * The link is a newline delimited stream of JSON objects in both directions
 * (see docs/PROTOCOL.md). Every host message is a {@link Request} carrying a
 * monotonically increasing `id`; the firmware answers with exactly one
 * {@link Response} bearing the same `id`. Unsolicited firmware messages are
 * {@link DeviceEvent}s and never carry an `id`.
 */

/** Electrical/functional configuration a pin can be put into. */
export type PinMode =
  | 'disabled'
  | 'input'
  | 'input_pullup'
  | 'input_pulldown'
  | 'output'
  | 'output_open_drain'
  | 'analog'
  | 'touch'
  | 'pwm';

export const PIN_MODES: readonly PinMode[] = [
  'disabled',
  'input',
  'input_pullup',
  'input_pulldown',
  'output',
  'output_open_drain',
  'analog',
  'touch',
  'pwm',
];

export function isPinMode(value: unknown): value is PinMode {
  return typeof value === 'string' && (PIN_MODES as readonly string[]).includes(value);
}

/** Commands understood by the firmware. */
export type CommandName =
  | 'hello'
  | 'sys.info'
  | 'sys.reset'
  | 'sys.baud'
  | 'pin.mode'
  | 'pin.read'
  | 'pin.write'
  | 'pin.toggle'
  | 'pin.pulse'
  | 'pin.pwm'
  | 'pin.blink'
  | 'pin.reset'
  | 'watch.set'
  | 'watch.clear'
  | 'adc.capture'
  | 'scan.i2c'
  | 'scan.pins';

export interface RequestBase {
  /** Correlation id, unique per connection. */
  id: number;
  cmd: CommandName;
}

export interface HelloRequest extends RequestBase {
  cmd: 'hello';
  /** Protocol version the host speaks. */
  protocol: number;
}

export interface SysInfoRequest extends RequestBase {
  cmd: 'sys.info';
}

export interface SysResetRequest extends RequestBase {
  cmd: 'sys.reset';
}

export interface SysBaudRequest extends RequestBase {
  cmd: 'sys.baud';
  /** New link speed; must be one of {@link SUPPORTED_BAUD_RATES}. */
  baud: number;
}

export interface PinModeRequest extends RequestBase {
  cmd: 'pin.mode';
  pin: number;
  mode: PinMode;
}

export interface PinReadRequest extends RequestBase {
  cmd: 'pin.read';
  pin: number;
}

export interface PinWriteRequest extends RequestBase {
  cmd: 'pin.write';
  pin: number;
  /** 0 or 1 for digital pins. */
  value: 0 | 1;
}

export interface PinToggleRequest extends RequestBase {
  cmd: 'pin.toggle';
  pin: number;
}

export interface PinPulseRequest extends RequestBase {
  cmd: 'pin.pulse';
  pin: number;
  /** Level driven for `ms` milliseconds before returning to the inverse. */
  value: 0 | 1;
  ms: number;
}

export interface PinPwmRequest extends RequestBase {
  cmd: 'pin.pwm';
  pin: number;
  /** Hertz, 1..40000. */
  freq: number;
  /** Normalised duty cycle, 0..1. */
  duty: number;
}

export interface PinBlinkRequest extends RequestBase {
  cmd: 'pin.blink';
  pin: number;
  /** Full period in milliseconds; 0 stops blinking. */
  period: number;
}

export interface PinResetRequest extends RequestBase {
  cmd: 'pin.reset';
  /** Omit to release every pin the tool has touched. */
  pin?: number;
}

export interface WatchSetRequest extends RequestBase {
  cmd: 'watch.set';
  pins: number[];
  /** Sampling period in milliseconds. */
  interval: number;
}

export interface WatchClearRequest extends RequestBase {
  cmd: 'watch.clear';
}

/** Edge trigger for a burst capture. */
export interface CaptureTrigger {
  edge: 'rising' | 'falling';
  /** Trigger level in millivolts. */
  mv: number;
  /** Give up waiting for the edge after this long (ms). */
  timeoutMs?: number;
}

export interface AdcCaptureRequest extends RequestBase {
  cmd: 'adc.capture';
  pin: number;
  /** Sampling rate in Hz. */
  rate: number;
  /** Number of samples to record. */
  samples: number;
  /** Fraction (0..0.9) of samples kept from before the trigger instant. */
  pretrigger?: number;
  trigger?: CaptureTrigger;
}

export interface ScanI2cRequest extends RequestBase {
  cmd: 'scan.i2c';
  sda: number;
  scl: number;
  /** Bus speed in Hz; firmware default (100000) when omitted. */
  freq?: number;
}

export interface ScanPinsRequest extends RequestBase {
  cmd: 'scan.pins';
  /** Pins to probe; all safe GPIOs when omitted. */
  pins?: number[];
}

export type Request =
  | HelloRequest
  | SysInfoRequest
  | SysResetRequest
  | SysBaudRequest
  | PinModeRequest
  | PinReadRequest
  | PinWriteRequest
  | PinToggleRequest
  | PinPulseRequest
  | PinPwmRequest
  | PinBlinkRequest
  | PinResetRequest
  | WatchSetRequest
  | WatchClearRequest
  | AdcCaptureRequest
  | ScanI2cRequest
  | ScanPinsRequest;

/** A single pin measurement as reported by the firmware. */
export interface PinSample {
  /** Digital level, 0 or 1. */
  d?: 0 | 1;
  /** Raw ADC counts (12 bit on ESP32 family). */
  a?: number;
  /** Calibrated millivolts, when the firmware can provide them. */
  mv?: number;
  /** Raw touch sensor reading. */
  t?: number;
}

export interface DeviceInfo {
  protocol: number;
  firmware: string;
  chip: string;
  /** Number of CPU cores. */
  cores?: number;
  /** Silicon revision. */
  revision?: number;
  mac?: string;
  flashSize?: number;
  freeHeap?: number;
  /** GPIO numbers the firmware is willing to drive. */
  pins?: number[];
  /** Maximum number of simultaneously watched pins. */
  maxWatch?: number;
  /** ADC full-scale reading, e.g. 4095. */
  adcMax?: number;
  /** Burst capture limits, present when the firmware supports `adc.capture`. */
  capture?: {
    maxSamples: number;
    minRate: number;
    maxRate: number;
  };
  /** Link speeds the firmware accepts for `sys.baud`. */
  bauds?: number[];
}

export interface ProtocolError {
  code: string;
  message: string;
}

export interface OkResponse<T = unknown> {
  id: number;
  ok: true;
  result?: T;
}

export interface ErrResponse {
  id: number;
  ok: false;
  error: ProtocolError;
}

export type Response<T = unknown> = OkResponse<T> | ErrResponse;

export type EventName = 'ready' | 'sample' | 'log' | 'pin' | 'capture' | 'error';

export interface ReadyEvent {
  ev: 'ready';
  info: DeviceInfo;
}

export interface SampleEvent {
  ev: 'sample';
  /** Device uptime in milliseconds when the batch was taken. */
  t: number;
  /** Keyed by GPIO number (JSON object keys are strings). */
  pins: Record<string, PinSample>;
}

export interface LogEvent {
  ev: 'log';
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

/** Edge notification emitted outside of the regular sampling cadence. */
export interface PinEvent {
  ev: 'pin';
  pin: number;
  value: 0 | 1;
  t: number;
}

/** One chunk of a burst capture; `data` is base64 of little-endian uint16 raw ADC counts. */
export interface CaptureChunkEvent {
  ev: 'capture';
  pin: number;
  /** 0-based chunk index. */
  seq: number;
  /** Total number of chunks in this capture. */
  chunks: number;
  /** Samples in this chunk. */
  n: number;
  /** Device uptime (ms) of the first retained sample. */
  t0: number;
  /** Actual sampling rate in Hz. */
  rate: number;
  data: string;
}

export interface ErrorEvent {
  ev: 'error';
  error: ProtocolError;
}

export type DeviceEvent =
  | ReadyEvent
  | SampleEvent
  | LogEvent
  | PinEvent
  | CaptureChunkEvent
  | ErrorEvent;

export type DeviceMessage = Response | DeviceEvent;

/**
 * A request without its correlation id. Written as a distributive conditional
 * so each member of the {@link Request} union keeps its own payload fields
 * (a plain `Omit<Request, 'id'>` would collapse them into an unusable type).
 */
export type RequestBody<T = Request> = T extends { id: number } ? Omit<T, 'id'> : never;

/** Protocol revision implemented by this build. */
export const PROTOCOL_VERSION = 1;

/** Default serial speed used by the firmware and the flasher. */
export const DEFAULT_BAUD_RATE = 115200;

/** Link speeds `sys.baud` may switch to. */
export const SUPPORTED_BAUD_RATES = [115200, 230400, 460800, 921600] as const;

/** Speed the host tries to upgrade the link to after the handshake. */
export const PREFERRED_BAUD_RATE = 921600;

/** Burst capture bounds shared by host validation and the simulator. */
export const CAPTURE_MAX_SAMPLES = 4096;
export const CAPTURE_MIN_RATE = 100;
export const CAPTURE_MAX_RATE = 2_000_000;
/** A capture (samples / rate) may not span more than this many milliseconds. */
export const CAPTURE_MAX_DURATION_MS = 5000;
/** Samples per `capture` chunk event. */
export const CAPTURE_CHUNK_SAMPLES = 512;
