import type { DiagnosticsController } from '../device/diagnosticsController';
import { downloadBuild, flashFirmware, formatBytes, type FlashPart } from '../flash/flasher';
import { loadManifest } from '../flash/manifest';
import { isWebSerialSupported, requestSerialPort } from '../transport/serialTransport';
import { button, el } from './dom';

export interface FlashPanelOptions {
  /** URL of the firmware manifest bundled with the deployment. */
  manifestUrl: string;
}

/**
 * Installs the diagnostic firmware onto a board.
 *
 * Two sources are supported: the manifest that ships with the deployment, and
 * locally built binaries picked from disk — the latter matters because the
 * repository cannot ship prebuilt binaries for every chip.
 */
export class FlashPanel {
  readonly root: HTMLElement;

  private readonly controller: DiagnosticsController;
  private readonly manifestUrl: string;
  private readonly status: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly eraseToggle: HTMLInputElement;
  private readonly fileInput: HTMLInputElement;
  private localParts: FlashPart[] = [];
  private busy = false;

  constructor(controller: DiagnosticsController, options: FlashPanelOptions) {
    this.controller = controller;
    this.manifestUrl = options.manifestUrl;
    this.status = el('p', { class: 'flash-status', text: 'Idle' });
    this.bar = el('div', { class: 'flash-bar-fill' });
    this.eraseToggle = el('input', { attrs: { type: 'checkbox' } });
    this.fileInput = el('input', {
      attrs: { type: 'file', accept: '.bin', multiple: true, 'aria-label': 'Firmware binaries' },
      on: { change: () => void this.onFilesPicked() },
    });

    this.root = el(
      'section',
      { class: 'panel flash-panel' },
      el('header', { class: 'panel-head' }, el('h2', { text: '1 · Install firmware' })),
      el('p', {
        class: 'muted',
        text: 'Flash the diagnostic firmware once. Afterwards the board can be opened directly from the toolbar.',
      }),
      el(
        'div',
        { class: 'btn-row' },
        button('Flash bundled firmware', () => this.flashFromManifest(), { class: 'btn-primary' }),
        el('label', { class: 'checkbox' }, this.eraseToggle, el('span', { text: 'Erase flash first' })),
      ),
      el(
        'details',
        { class: 'flash-local' },
        el('summary', { text: 'Flash locally built binaries' }),
        el('p', {
          class: 'muted',
          text: 'Select the .bin files produced by the Arduino IDE or PlatformIO. Offsets are taken from the file names (e.g. 0x10000-firmware.bin) or default to 0x10000 for a single merged image.',
        }),
        this.fileInput,
        button('Flash selected files', () => this.flashLocal()),
      ),
      el('div', { class: 'flash-bar' }, this.bar),
      this.status,
    );
  }

  private setProgress(fraction: number, message: string): void {
    this.bar.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
    this.status.textContent = message;
  }

  private async onFilesPicked(): Promise<void> {
    const files = [...(this.fileInput.files ?? [])];
    this.localParts = [];
    for (const file of files) {
      const address = offsetFromName(file.name, files.length === 1);
      this.localParts.push({
        data: new Uint8Array(await file.arrayBuffer()),
        address,
        name: file.name,
      });
    }
    this.localParts.sort((a, b) => a.address - b.address);
    this.setProgress(
      0,
      this.localParts.length === 0
        ? 'Idle'
        : `Ready: ${this.localParts
            .map((part) => `${part.name} @ 0x${part.address.toString(16)} (${formatBytes(part.data.length)})`)
            .join(', ')}`,
    );
  }

  private async flashLocal(): Promise<void> {
    if (this.localParts.length === 0) {
      this.controller.log('warn', 'Pick at least one .bin file first');
      return;
    }
    await this.flash(async () => this.localParts);
  }

  private async flashFromManifest(): Promise<void> {
    await this.flash(async (chip) => {
      const manifest = await loadManifest(this.manifestUrl).catch((error: unknown) => {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}. This deployment ships no prebuilt binaries — build the firmware (see firmware/README.md) and use "Flash locally built binaries" below.`,
        );
      });
      this.controller.log('info', `Manifest: ${manifest.name} ${manifest.version}`);
      return downloadBuild(manifest, this.manifestUrl, chip, fetch, location.href);
    });
  }

  /**
   * Shared flashing flow. The parts factory receives the detected chip so the
   * manifest build can be chosen after the board identifies itself, without
   * probing the ROM bootloader a second time.
   */
  private async flash(parts: (chip: string) => Promise<FlashPart[]>): Promise<void> {
    if (this.busy) return;
    if (!isWebSerialSupported()) {
      this.controller.log('error', 'Web Serial is not available in this browser.');
      return;
    }
    this.busy = true;
    try {
      if (this.controller.connected) await this.controller.disconnect();
      const port = await requestSerialPort();
      this.setProgress(0, 'Detecting chip…');
      await flashFirmware({
        port,
        parts: async (chip) => {
          this.controller.log('info', `Chip detected: ${chip}`);
          const selected = await parts(chip);
          this.controller.log(
            'info',
            `Flashing ${selected.length} part(s), ${formatBytes(
              selected.reduce((sum, part) => sum + part.data.length, 0),
            )} total`,
          );
          return selected;
        },
        eraseAll: this.eraseToggle.checked,
        onProgress: (progress) => this.setProgress(progress.fraction, progress.message),
        onLog: (line) => this.controller.log('info', line),
      });
      this.setProgress(1, 'Done — the board is rebooting. Now press “Connect board”.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setProgress(0, `Failed: ${message}`);
      this.controller.log('error', `Flashing failed: ${message}`);
    } finally {
      this.busy = false;
    }
  }
}

/**
 * Derive a flash offset from a file name.
 *
 * Conventional names such as `0x1000-bootloader.bin` or `firmware.0x10000.bin`
 * carry their offset; a lone file is assumed to be an application image at the
 * standard 0x10000 offset, and a merged image at 0x0.
 */
export function offsetFromName(name: string, single: boolean): number {
  const match = /0x([0-9a-f]+)/i.exec(name);
  if (match) return Number.parseInt(match[1]!, 16);
  if (/merged|factory|combined/i.test(name)) return 0;
  return single ? 0x10000 : 0;
}
