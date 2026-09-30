import {
  CAPTURE_MAX_DURATION_MS,
  CAPTURE_MAX_RATE,
  CAPTURE_MAX_SAMPLES,
  CAPTURE_MIN_RATE,
  SUPPORTED_BAUD_RATES,
  type DeviceEvent,
  type DeviceInfo,
  type DeviceMessage,
  type PinSample,
  type Request,
  type Response,
  isPinMode,
} from './types';

/** Thrown when a line received from the device cannot be interpreted. */
export class ProtocolParseError extends Error {
  readonly line: string;

  constructor(message: string, line: string) {
    super(message);
    this.name = 'ProtocolParseError';
    this.line = line;
  }
}

/** Serialise a host request into a single wire line (newline included). */
export function encodeRequest(request: Request): string {
  return `${JSON.stringify(request)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseSample(value: unknown): PinSample {
  const sample: PinSample = {};
  if (!isRecord(value)) return sample;
  if (value.d === 0 || value.d === 1) sample.d = value.d;
  const a = asFiniteNumber(value.a);
  if (a !== undefined) sample.a = a;
  const mv = asFiniteNumber(value.mv);
  if (mv !== undefined) sample.mv = mv;
  const t = asFiniteNumber(value.t);
  if (t !== undefined) sample.t = t;
  return sample;
}

function parseCaptureInfo(value: unknown): DeviceInfo['capture'] | undefined {
  if (!isRecord(value)) return undefined;
  const maxSamples = asFiniteNumber(value.maxSamples);
  const minRate = asFiniteNumber(value.minRate);
  const maxRate = asFiniteNumber(value.maxRate);
  if (maxSamples === undefined || minRate === undefined || maxRate === undefined) return undefined;
  return { maxSamples, minRate, maxRate };
}

function parseEvent(raw: Record<string, unknown>, line: string): DeviceEvent {
  switch (raw.ev) {
    case 'ready': {
      const info = isRecord(raw.info) ? raw.info : {};
      return {
        ev: 'ready',
        info: {
          protocol: asFiniteNumber(info.protocol) ?? 0,
          firmware: typeof info.firmware === 'string' ? info.firmware : 'unknown',
          chip: typeof info.chip === 'string' ? info.chip : 'unknown',
          ...(asFiniteNumber(info.cores) !== undefined ? { cores: asFiniteNumber(info.cores) } : {}),
          ...(asFiniteNumber(info.revision) !== undefined
            ? { revision: asFiniteNumber(info.revision) }
            : {}),
          ...(typeof info.mac === 'string' ? { mac: info.mac } : {}),
          ...(asFiniteNumber(info.flashSize) !== undefined
            ? { flashSize: asFiniteNumber(info.flashSize) }
            : {}),
          ...(asFiniteNumber(info.freeHeap) !== undefined
            ? { freeHeap: asFiniteNumber(info.freeHeap) }
            : {}),
          ...(Array.isArray(info.pins)
            ? { pins: info.pins.filter((p): p is number => asFiniteNumber(p) !== undefined) }
            : {}),
          ...(asFiniteNumber(info.maxWatch) !== undefined
            ? { maxWatch: asFiniteNumber(info.maxWatch) }
            : {}),
          ...(asFiniteNumber(info.adcMax) !== undefined
            ? { adcMax: asFiniteNumber(info.adcMax) }
            : {}),
          ...(parseCaptureInfo(info.capture) !== undefined
            ? { capture: parseCaptureInfo(info.capture) }
            : {}),
          ...(Array.isArray(info.bauds)
            ? { bauds: info.bauds.filter((b): b is number => asFiniteNumber(b) !== undefined) }
            : {}),
        },
      };
    }
    case 'sample': {
      const pins: Record<string, PinSample> = {};
      if (isRecord(raw.pins)) {
        for (const [key, value] of Object.entries(raw.pins)) {
          if (!/^\d+$/.test(key)) continue;
          pins[key] = parseSample(value);
        }
      }
      return { ev: 'sample', t: asFiniteNumber(raw.t) ?? 0, pins };
    }
    case 'log': {
      const level = raw.level;
      return {
        ev: 'log',
        level:
          level === 'debug' || level === 'warn' || level === 'error' || level === 'info'
            ? level
            : 'info',
        message: typeof raw.message === 'string' ? raw.message : String(raw.message ?? ''),
      };
    }
    case 'pin': {
      const pin = asFiniteNumber(raw.pin);
      if (pin === undefined || (raw.value !== 0 && raw.value !== 1)) {
        throw new ProtocolParseError('malformed pin event', line);
      }
      return { ev: 'pin', pin, value: raw.value, t: asFiniteNumber(raw.t) ?? 0 };
    }
    case 'capture': {
      const pin = asFiniteNumber(raw.pin);
      const seq = asFiniteNumber(raw.seq);
      const chunks = asFiniteNumber(raw.chunks);
      const n = asFiniteNumber(raw.n);
      const rate = asFiniteNumber(raw.rate);
      if (
        pin === undefined ||
        seq === undefined ||
        chunks === undefined ||
        n === undefined ||
        rate === undefined ||
        typeof raw.data !== 'string'
      ) {
        throw new ProtocolParseError('malformed capture event', line);
      }
      return {
        ev: 'capture',
        pin,
        seq,
        chunks,
        n,
        t0: asFiniteNumber(raw.t0) ?? 0,
        rate,
        data: raw.data,
      };
    }
    case 'error': {
      const error = isRecord(raw.error) ? raw.error : {};
      return {
        ev: 'error',
        error: {
          code: typeof error.code === 'string' ? error.code : 'unknown',
          message: typeof error.message === 'string' ? error.message : 'unknown error',
        },
      };
    }
    default:
      throw new ProtocolParseError(`unknown event "${String(raw.ev)}"`, line);
  }
}

function parseResponse(raw: Record<string, unknown>, line: string): Response {
  const id = asFiniteNumber(raw.id);
  if (id === undefined) throw new ProtocolParseError('response without id', line);
  if (raw.ok === true) {
    return raw.result === undefined ? { id, ok: true } : { id, ok: true, result: raw.result };
  }
  const error = isRecord(raw.error) ? raw.error : {};
  return {
    id,
    ok: false,
    error: {
      code: typeof error.code === 'string' ? error.code : 'unknown',
      message: typeof error.message === 'string' ? error.message : 'unknown error',
    },
  };
}

/**
 * Parse one line coming from the device.
 *
 * @throws {ProtocolParseError} when the line is not valid protocol JSON. Callers
 * typically surface such lines as plain firmware console output instead.
 */
export function decodeMessage(line: string): DeviceMessage {
  const trimmed = line.trim();
  if (!trimmed) throw new ProtocolParseError('empty line', line);
  if (!trimmed.startsWith('{')) throw new ProtocolParseError('not a JSON object', line);
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (cause) {
    throw new ProtocolParseError(`invalid JSON: ${(cause as Error).message}`, line);
  }
  if (!isRecord(raw)) throw new ProtocolParseError('not a JSON object', line);
  if (typeof raw.ev === 'string') return parseEvent(raw, line);
  if ('id' in raw) return parseResponse(raw, line);
  throw new ProtocolParseError('message has neither "id" nor "ev"', line);
}

/** Type guard separating asynchronous events from command responses. */
export function isDeviceEvent(message: DeviceMessage): message is DeviceEvent {
  return 'ev' in message;
}

/**
 * Validate a request before it is sent so obviously invalid values are caught
 * in the UI rather than by the firmware.
 *
 * @returns a human readable problem description, or `null` when valid.
 */
export function validateRequest(request: Request): string | null {
  if (!Number.isInteger(request.id) || request.id < 0) return 'id must be a non-negative integer';
  switch (request.cmd) {
    case 'pin.mode':
      if (!isPinMode(request.mode)) return `unknown pin mode "${String(request.mode)}"`;
      return validPin(request.pin);
    case 'pin.read':
    case 'pin.toggle':
      return validPin(request.pin);
    case 'pin.write':
      return validPin(request.pin) ?? (request.value === 0 || request.value === 1 ? null : 'value must be 0 or 1');
    case 'pin.pulse':
      return (
        validPin(request.pin) ??
        (request.value === 0 || request.value === 1 ? null : 'value must be 0 or 1') ??
        (request.ms > 0 && request.ms <= 60_000 ? null : 'ms must be within 1..60000')
      );
    case 'pin.pwm':
      return (
        validPin(request.pin) ??
        (request.freq >= 1 && request.freq <= 40_000 ? null : 'freq must be within 1..40000') ??
        (request.duty >= 0 && request.duty <= 1 ? null : 'duty must be within 0..1')
      );
    case 'pin.blink':
      return (
        validPin(request.pin) ??
        (request.period >= 0 && request.period <= 60_000 ? null : 'period must be within 0..60000')
      );
    case 'pin.reset':
      return request.pin === undefined ? null : validPin(request.pin);
    case 'watch.set': {
      if (!Array.isArray(request.pins) || request.pins.length === 0) return 'pins must be a non-empty array';
      for (const pin of request.pins) {
        const problem = validPin(pin);
        if (problem) return problem;
      }
      return request.interval >= 5 && request.interval <= 10_000
        ? null
        : 'interval must be within 5..10000';
    }
    case 'sys.baud':
      return (SUPPORTED_BAUD_RATES as readonly number[]).includes(request.baud)
        ? null
        : `baud must be one of ${SUPPORTED_BAUD_RATES.join(', ')}`;
    case 'adc.capture': {
      const pinProblem = validPin(request.pin);
      if (pinProblem) return pinProblem;
      if (
        !Number.isFinite(request.rate) ||
        request.rate < CAPTURE_MIN_RATE ||
        request.rate > CAPTURE_MAX_RATE
      ) {
        return `rate must be within ${CAPTURE_MIN_RATE}..${CAPTURE_MAX_RATE}`;
      }
      if (
        !Number.isInteger(request.samples) ||
        request.samples < 16 ||
        request.samples > CAPTURE_MAX_SAMPLES
      ) {
        return `samples must be within 16..${CAPTURE_MAX_SAMPLES}`;
      }
      if ((request.samples / request.rate) * 1000 > CAPTURE_MAX_DURATION_MS) {
        return `a capture may not span more than ${CAPTURE_MAX_DURATION_MS} ms`;
      }
      if (
        request.pretrigger !== undefined &&
        !(request.pretrigger >= 0 && request.pretrigger <= 0.9)
      ) {
        return 'pretrigger must be within 0..0.9';
      }
      const trigger = request.trigger;
      if (trigger !== undefined) {
        if (trigger.edge !== 'rising' && trigger.edge !== 'falling') {
          return 'trigger edge must be "rising" or "falling"';
        }
        if (!(trigger.mv >= 0 && trigger.mv <= 3600)) return 'trigger mv must be within 0..3600';
        if (
          trigger.timeoutMs !== undefined &&
          !(trigger.timeoutMs >= 1 && trigger.timeoutMs <= 10_000)
        ) {
          return 'trigger timeoutMs must be within 1..10000';
        }
      }
      return null;
    }
    case 'scan.i2c':
      return validPin(request.sda) ?? validPin(request.scl);
    default:
      return null;
  }
}

function validPin(pin: number): string | null {
  return Number.isInteger(pin) && pin >= 0 && pin <= 63 ? null : `invalid pin "${String(pin)}"`;
}
