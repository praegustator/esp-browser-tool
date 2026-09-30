/** Transport-agnostic view of a connected board. */
export interface Transport {
  readonly name: string;
  /** True once {@link open} has completed and before {@link close}. */
  readonly isOpen: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  /** Send one already newline-terminated line. */
  send(line: string): Promise<void>;
  /** Called with each complete line received from the device. */
  onLine(handler: (line: string) => void): () => void;
  /** Called when the transport closes unexpectedly. */
  onClose(handler: (reason: Error | null) => void): () => void;
  /** Pulse DTR/RTS to reboot the board, when the transport supports it. */
  reset?(): Promise<void>;
}

/** Minimal emitter used by the transports and the device session. */
export class Emitter<T> {
  private handlers = new Set<(value: T) => void>();

  on(handler: (value: T) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(value: T): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(value);
      } catch (error) {
        console.error('emitter handler failed', error);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
