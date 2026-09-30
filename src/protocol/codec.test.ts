import { describe, expect, it } from 'vitest';
import {
  decodeMessage,
  encodeRequest,
  isDeviceEvent,
  ProtocolParseError,
  validateRequest,
} from './codec';
import { PROTOCOL_VERSION, isPinMode } from './types';

describe('encodeRequest', () => {
  it('emits one newline terminated JSON document', () => {
    const line = encodeRequest({ id: 7, cmd: 'pin.write', pin: 2, value: 1 });
    expect(line).toBe('{"id":7,"cmd":"pin.write","pin":2,"value":1}\n');
  });
});

describe('decodeMessage', () => {
  it('decodes an ok response', () => {
    const message = decodeMessage('{"id":3,"ok":true,"result":{"pin":2,"d":1}}');
    expect(message).toEqual({ id: 3, ok: true, result: { pin: 2, d: 1 } });
    expect(isDeviceEvent(message)).toBe(false);
  });

  it('decodes an error response and fills in defaults', () => {
    expect(decodeMessage('{"id":4,"ok":false,"error":{"code":"bad_pin"}}')).toEqual({
      id: 4,
      ok: false,
      error: { code: 'bad_pin', message: 'unknown error' },
    });
  });

  it('decodes a ready event', () => {
    const message = decodeMessage(
      `{"ev":"ready","info":{"protocol":${PROTOCOL_VERSION},"firmware":"x","chip":"ESP32","pins":[2,4],"adcMax":4095}}`,
    );
    expect(message).toEqual({
      ev: 'ready',
      info: {
        protocol: PROTOCOL_VERSION,
        firmware: 'x',
        chip: 'ESP32',
        pins: [2, 4],
        adcMax: 4095,
      },
    });
  });

  it('decodes a sample event and drops non numeric keys', () => {
    const message = decodeMessage('{"ev":"sample","t":120,"pins":{"2":{"d":1},"x":{"d":0},"33":{"a":2048,"mv":1650}}}');
    expect(message).toEqual({
      ev: 'sample',
      t: 120,
      pins: { '2': { d: 1 }, '33': { a: 2048, mv: 1650 } },
    });
  });

  it('normalises unknown log levels', () => {
    expect(decodeMessage('{"ev":"log","level":"weird","message":"hi"}')).toEqual({
      ev: 'log',
      level: 'info',
      message: 'hi',
    });
  });

  it('rejects firmware console output', () => {
    expect(() => decodeMessage('ets Jun  8 2016 00:22:57')).toThrow(ProtocolParseError);
    expect(() => decodeMessage('{not json')).toThrow(ProtocolParseError);
    expect(() => decodeMessage('   ')).toThrow(ProtocolParseError);
    expect(() => decodeMessage('{"hello":1}')).toThrow(ProtocolParseError);
    expect(() => decodeMessage('{"ev":"nope"}')).toThrow(ProtocolParseError);
  });
});

describe('validateRequest', () => {
  it('accepts well formed requests', () => {
    expect(validateRequest({ id: 1, cmd: 'pin.pwm', pin: 5, freq: 1000, duty: 0.5 })).toBeNull();
    expect(validateRequest({ id: 1, cmd: 'watch.set', pins: [2, 4], interval: 50 })).toBeNull();
    expect(validateRequest({ id: 1, cmd: 'pin.reset' })).toBeNull();
  });

  it('rejects out of range values', () => {
    expect(validateRequest({ id: 1, cmd: 'pin.write', pin: 99, value: 1 })).toMatch(/invalid pin/);
    expect(validateRequest({ id: 1, cmd: 'pin.pwm', pin: 5, freq: 0, duty: 0.5 })).toMatch(/freq/);
    expect(validateRequest({ id: 1, cmd: 'pin.pwm', pin: 5, freq: 100, duty: 2 })).toMatch(/duty/);
    expect(validateRequest({ id: 1, cmd: 'watch.set', pins: [], interval: 50 })).toMatch(/non-empty/);
    expect(validateRequest({ id: 1, cmd: 'watch.set', pins: [2], interval: 1 })).toMatch(/interval/);
    expect(validateRequest({ id: -1, cmd: 'sys.info' })).toMatch(/id/);
    // @ts-expect-error deliberately invalid mode
    expect(validateRequest({ id: 1, cmd: 'pin.mode', pin: 2, mode: 'nope' })).toMatch(/pin mode/);
  });
});

describe('isPinMode', () => {
  it('recognises known modes only', () => {
    expect(isPinMode('input_pullup')).toBe(true);
    expect(isPinMode('nope')).toBe(false);
  });
});
