import { describe, expect, it } from 'vitest';
import { LineFramer } from './lineFramer';

const encode = (text: string) => new TextEncoder().encode(text);

describe('LineFramer', () => {
  it('splits complete lines and keeps the remainder', () => {
    const framer = new LineFramer();
    expect(framer.push(encode('{"a":1}\n{"b":'))).toEqual(['{"a":1}']);
    expect(framer.push(encode('2}\n'))).toEqual(['{"b":2}']);
    expect(framer.flush()).toBeNull();
  });

  it('handles CRLF and blank lines', () => {
    const framer = new LineFramer();
    expect(framer.push(encode('one\r\n\r\ntwo\r\n'))).toEqual(['one', 'two']);
  });

  it('reassembles split multi-byte characters', () => {
    const bytes = encode('{"m":"µΩ"}\n');
    const framer = new LineFramer();
    expect(framer.push(bytes.slice(0, 8))).toEqual([]);
    expect(framer.push(bytes.slice(8))).toEqual(['{"m":"µΩ"}']);
  });

  it('flushes an unterminated tail', () => {
    const framer = new LineFramer();
    framer.push(encode('partial'));
    expect(framer.flush()).toBe('partial');
    expect(framer.flush()).toBeNull();
  });

  it('drops runaway buffers beyond the limit', () => {
    const framer = new LineFramer(16);
    framer.pushText('x'.repeat(100));
    expect((framer.flush() ?? '').length).toBe(16);
  });

  it('resets pending state', () => {
    const framer = new LineFramer();
    framer.pushText('abc');
    framer.reset();
    expect(framer.flush()).toBeNull();
  });
});
