import { DEFAULT_BAUD_RATE } from '../protocol/types';
import { buildForChip, resolvePartUrl, type FirmwareManifest } from './manifest';

export interface FlashPart {
  data: Uint8Array;
  address: number;
  /** Label shown in the progress UI. */
  name: string;
}

export type FlashPhase = 'connecting' | 'erasing' | 'writing' | 'verifying' | 'done' | 'failed';

export interface FlashProgress {
  phase: FlashPhase;
  /** Overall progress, 0..1. */
  fraction: number;
  message: string;
  /** Chip reported by the ROM bootloader, once known. */
  chip?: string;
}

export interface FlashOptions {
  port: SerialPort;
  /**
   * The images to write, or a factory that picks them once the ROM bootloader
   * has identified the chip — so the board only has to be probed once.
   */
  parts: FlashPart[] | ((chip: string) => FlashPart[] | Promise<FlashPart[]>);
  /** Erase the whole flash before writing (wipes stored Wi-Fi credentials). */
  eraseAll?: boolean;
  /** Baud rate used for the flashing session; 921600 is usually safe over USB. */
  baudRate?: number;
  onProgress?: (progress: FlashProgress) => void;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}

export class FlashError extends Error {}

/**
 * Flash the given parts over Web Serial using esptool-js.
 *
 * esptool-js is imported lazily: it pulls in a large amount of code that is
 * only needed when the user actually installs firmware, so keeping it out of
 * the initial bundle makes the tool start noticeably faster.
 */
export async function flashFirmware(options: FlashOptions): Promise<string> {
  const { port, parts } = options;
  if (Array.isArray(parts) && parts.length === 0) throw new FlashError('nothing to flash');
  const report = (progress: FlashProgress) => options.onProgress?.(progress);
  const log = (line: string) => options.onLog?.(line);

  const { ESPLoader, Transport } = await import('esptool-js');
  const transport = new Transport(port, false);
  report({ phase: 'connecting', fraction: 0, message: 'Entering the ROM bootloader…' });

  const loader = new ESPLoader({
    transport,
    baudrate: options.baudRate ?? 921_600,
    romBaudrate: DEFAULT_BAUD_RATE,
    terminal: {
      clean: () => undefined,
      write: (data: string) => log(data.replace(/\r/g, '')),
      writeLine: (data: string) => log(data.replace(/\r/g, '')),
    },
  });

  try {
    const chip = await loader.main();
    log(`Detected chip: ${chip}`);
    options.signal?.throwIfAborted();

    const selected = Array.isArray(parts) ? parts : await parts(chip);
    if (selected.length === 0) throw new FlashError('nothing to flash');
    const totalBytes = selected.reduce((sum, part) => sum + part.data.length, 0);
    const writtenBefore: number[] = [];
    let offsetSum = 0;
    for (const part of selected) {
      writtenBefore.push(offsetSum);
      offsetSum += part.data.length;
    }
    if (options.eraseAll) {
      report({ phase: 'erasing', fraction: 0, message: 'Erasing flash…', chip });
    }
    report({ phase: 'writing', fraction: 0, message: 'Writing firmware…', chip });
    await loader.writeFlash({
      fileArray: selected.map((part) => ({ data: part.data, address: part.address })),
      flashMode: 'keep',
      flashFreq: 'keep',
      flashSize: 'keep',
      eraseAll: options.eraseAll ?? false,
      compress: true,
      reportProgress: (fileIndex: number, written: number) => {
        const done = (writtenBefore[fileIndex] ?? 0) + written;
        report({
          phase: 'writing',
          fraction: totalBytes > 0 ? Math.min(1, done / totalBytes) : 0,
          message: `Writing ${selected[fileIndex]?.name ?? 'firmware'} (${formatBytes(done)} / ${formatBytes(totalBytes)})`,
          chip,
        });
      },
    });
    report({ phase: 'done', fraction: 1, message: 'Firmware written, rebooting…', chip });
    await loader.after('hard_reset');
    return chip;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report({ phase: 'failed', fraction: 0, message });
    throw error instanceof FlashError ? error : new FlashError(message);
  } finally {
    // Always hand the port back so the diagnostic session can reopen it.
    await transport.disconnect().catch(() => undefined);
    await transport.waitForUnlock(1500).catch(() => undefined);
  }
}

/** Download every part of the build matching `chip`. */
export async function downloadBuild(
  manifest: FirmwareManifest,
  manifestUrl: string,
  chip: string,
  fetchImpl: typeof fetch = fetch,
  base?: string,
): Promise<FlashPart[]> {
  const build = buildForChip(manifest, chip);
  if (!build) {
    throw new FlashError(
      `The firmware manifest has no build for ${chip} (available: ${manifest.builds
        .map((item) => item.chipFamily)
        .join(', ')})`,
    );
  }
  const parts: FlashPart[] = [];
  for (const part of build.parts) {
    const url = resolvePartUrl(manifestUrl, part.path, base);
    const response = await fetchImpl(url);
    if (!response.ok) throw new FlashError(`could not download ${part.path} (HTTP ${response.status})`);
    parts.push({
      data: new Uint8Array(await response.arrayBuffer()),
      address: part.offset,
      name: part.path.split('/').pop() ?? part.path,
    });
  }
  return parts;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
