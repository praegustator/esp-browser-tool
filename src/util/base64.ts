/** Minimal standard-alphabet base64 codec, independent of `atob`/`Buffer`. */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const REVERSE = new Int8Array(128).fill(-1);
for (let index = 0; index < ALPHABET.length; index++) {
  REVERSE[ALPHABET.charCodeAt(index)] = index;
}

/** Decode a base64 string to raw bytes; padding is optional. */
export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/[=\s]+$/u, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let position = 0;
  for (let index = 0; index < clean.length; index++) {
    const code = clean.charCodeAt(index);
    const value = code < 128 ? REVERSE[code]! : -1;
    if (value < 0) throw new Error(`invalid base64 character at index ${index}`);
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[position++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, position);
}

/** Encode raw bytes as padded base64 (used by the simulated board). */
export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    out += ALPHABET[a >> 2]!;
    out += ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)]!;
    out += b === undefined ? '=' : ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)]!;
    out += c === undefined ? '=' : ALPHABET[c & 0x3f]!;
  }
  return out;
}

/** Decode base64 into little-endian uint16 samples (the capture wire format). */
export function decodeSamples(data: string): Uint16Array {
  const bytes = decodeBase64(data);
  const samples = new Uint16Array(Math.floor(bytes.length / 2));
  for (let index = 0; index < samples.length; index++) {
    samples[index] = bytes[index * 2]! | (bytes[index * 2 + 1]! << 8);
  }
  return samples;
}
