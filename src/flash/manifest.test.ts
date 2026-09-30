import { describe, expect, it } from 'vitest';
import { buildForChip, loadManifest, ManifestError, parseManifest, resolvePartUrl } from './manifest';
import { downloadBuild, formatBytes } from './flasher';

const validManifest = {
  name: 'ESP Browser Tool diagnostics',
  version: '1.0.0',
  new_install_prompt_erase: true,
  builds: [
    { chipFamily: 'ESP32', parts: [{ path: 'esp32/firmware.bin', offset: 0 }] },
    { chipFamily: 'ESP32-S3', parts: [{ path: 'esp32s3/firmware.bin', offset: 0 }] },
  ],
};

describe('parseManifest', () => {
  it('accepts a well formed manifest', () => {
    const manifest = parseManifest(validManifest);
    expect(manifest.builds).toHaveLength(2);
    expect(manifest.new_install_prompt_erase).toBe(true);
  });

  it('rejects malformed manifests', () => {
    expect(() => parseManifest(null)).toThrow(ManifestError);
    expect(() => parseManifest({ version: '1', builds: [] })).toThrow(/name/);
    expect(() => parseManifest({ name: 'x', builds: [] })).toThrow(/version/);
    expect(() => parseManifest({ name: 'x', version: '1', builds: [] })).toThrow(/builds/);
    expect(() => parseManifest({ name: 'x', version: '1', builds: [{ parts: [] }] })).toThrow(/chipFamily/);
    expect(() =>
      parseManifest({ name: 'x', version: '1', builds: [{ chipFamily: 'ESP32', parts: [{ path: 'a.bin' }] }] }),
    ).toThrow(/offset/);
  });
});

describe('buildForChip', () => {
  it('prefers the most specific chip family', () => {
    const manifest = parseManifest(validManifest);
    expect(buildForChip(manifest, 'ESP32-S3 (QFN56)')?.chipFamily).toBe('ESP32-S3');
    expect(buildForChip(manifest, 'ESP32-D0WD-V3')?.chipFamily).toBe('ESP32');
    expect(buildForChip(manifest, 'ESP32-C6')).toBeUndefined();
  });
});

describe('resolvePartUrl', () => {
  it('resolves parts relative to the manifest', () => {
    expect(resolvePartUrl('https://example.com/fw/manifest.json', 'esp32/app.bin')).toBe(
      'https://example.com/fw/esp32/app.bin',
    );
    expect(resolvePartUrl('/firmware/manifest.json', 'app.bin', 'https://example.com/tool/')).toBe(
      'https://example.com/firmware/app.bin',
    );
  });
});

describe('loadManifest / downloadBuild', () => {
  const fetchStub = (responses: Record<string, Response>): typeof fetch =>
    (async (input: RequestInfo | URL) => {
      const url = String(input);
      const response = responses[url];
      if (!response) throw new Error(`unexpected fetch of ${url}`);
      return response;
    }) as typeof fetch;

  it('downloads and validates a manifest', async () => {
    const manifest = await loadManifest(
      'https://example.com/manifest.json',
      fetchStub({
        'https://example.com/manifest.json': new Response(JSON.stringify(validManifest)),
      }),
    );
    expect(manifest.name).toBe(validManifest.name);
  });

  it('reports HTTP failures', async () => {
    await expect(
      loadManifest(
        'https://example.com/manifest.json',
        fetchStub({ 'https://example.com/manifest.json': new Response('', { status: 404 }) }),
      ),
    ).rejects.toThrow(/HTTP 404/);
  });

  it('downloads every part of the matching build', async () => {
    const manifest = parseManifest(validManifest);
    const parts = await downloadBuild(
      manifest,
      'https://example.com/fw/manifest.json',
      'ESP32-S3',
      fetchStub({
        'https://example.com/fw/esp32s3/firmware.bin': new Response(new Uint8Array([1, 2, 3])),
      }),
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]?.address).toBe(0);
    expect(parts[0]?.name).toBe('firmware.bin');
    expect(parts[0]?.data.length).toBe(3);
  });

  it('explains when no build matches the chip', async () => {
    const manifest = parseManifest(validManifest);
    await expect(
      downloadBuild(manifest, 'https://example.com/fw/manifest.json', 'ESP32-C6', fetchStub({})),
    ).rejects.toThrow(/no build for ESP32-C6/);
  });
});

describe('formatBytes', () => {
  it('scales the unit', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 kB');
    expect(formatBytes(1024 * 1024 * 3)).toBe('3.00 MB');
  });
});
