/**
 * Incremental newline framer for byte streams.
 *
 * The firmware emits one JSON document per line, but a serial read can deliver
 * a partial line, several lines at once, or split a multi-byte UTF-8 sequence,
 * so decoding is done with a streaming decoder and an explicit carry buffer.
 */
export class LineFramer {
  private readonly decoder = new TextDecoder('utf-8');
  private buffer = '';
  private readonly maxLineLength: number;

  /**
   * @param maxLineLength Guards against a device that never emits a newline;
   * the pending buffer is dropped once it exceeds this many characters.
   */
  constructor(maxLineLength = 64 * 1024) {
    this.maxLineLength = maxLineLength;
  }

  /** Feed raw bytes, returning every complete line contained in the stream. */
  push(chunk: Uint8Array): string[] {
    return this.pushText(this.decoder.decode(chunk, { stream: true }));
  }

  /** Feed already-decoded text (used by tests and the simulator). */
  pushText(text: string): string[] {
    if (!text) return [];
    this.buffer += text;
    if (this.buffer.length > this.maxLineLength) {
      // Keep the tail so a resynchronising device can still be understood.
      this.buffer = this.buffer.slice(-this.maxLineLength);
    }
    const lines: string[] = [];
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) lines.push(line);
      index = this.buffer.indexOf('\n');
    }
    return lines;
  }

  /** Return and clear any bytes not yet terminated by a newline. */
  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest.length > 0 ? rest : null;
  }

  reset(): void {
    this.buffer = '';
  }
}
