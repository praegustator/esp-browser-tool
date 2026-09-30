/**
 * Firmware manifest handling.
 *
 * The format mirrors the one used by ESP Web Tools so that firmware published
 * for that ecosystem can be reused here without conversion.
 */

import { sameChipFamily } from '../util/chipFamily';

export interface FirmwarePart {
  /** URL of the binary, relative to the manifest. */
  path: string;
  /** Flash offset the part is written to. */
  offset: number;
}

export interface FirmwareBuild {
  /** e.g. `ESP32`, `ESP32-S3`, `ESP32-C3`. */
  chipFamily: string;
  parts: FirmwarePart[];
}

export interface FirmwareManifest {
  name: string;
  version: string;
  /** Wipe the whole flash (including NVS/Wi-Fi credentials) before writing. */
  new_install_prompt_erase?: boolean;
  builds: FirmwareBuild[];
}

export class ManifestError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate a parsed manifest, throwing {@link ManifestError} when malformed. */
export function parseManifest(raw: unknown): FirmwareManifest {
  if (!isRecord(raw)) throw new ManifestError('manifest must be a JSON object');
  const { name, version, builds } = raw;
  if (typeof name !== 'string' || !name) throw new ManifestError('manifest.name is required');
  if (typeof version !== 'string' || !version) throw new ManifestError('manifest.version is required');
  if (!Array.isArray(builds) || builds.length === 0) {
    throw new ManifestError('manifest.builds must be a non-empty array');
  }
  return {
    name,
    version,
    new_install_prompt_erase: raw.new_install_prompt_erase === true,
    builds: builds.map((build, index) => parseBuild(build, index)),
  };
}

function parseBuild(raw: unknown, index: number): FirmwareBuild {
  if (!isRecord(raw)) throw new ManifestError(`builds[${index}] must be an object`);
  const chipFamily = raw.chipFamily;
  if (typeof chipFamily !== 'string' || !chipFamily) {
    throw new ManifestError(`builds[${index}].chipFamily is required`);
  }
  if (!Array.isArray(raw.parts) || raw.parts.length === 0) {
    throw new ManifestError(`builds[${index}].parts must be a non-empty array`);
  }
  const parts = raw.parts.map((part, partIndex) => {
    if (!isRecord(part) || typeof part.path !== 'string' || !part.path) {
      throw new ManifestError(`builds[${index}].parts[${partIndex}].path is required`);
    }
    const offset = part.offset;
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
      throw new ManifestError(`builds[${index}].parts[${partIndex}].offset must be a non-negative integer`);
    }
    return { path: part.path, offset };
  });
  return { chipFamily, parts };
}

/** Pick the build whose chip family matches the chip reported by esptool. */
export function buildForChip(manifest: FirmwareManifest, chip: string): FirmwareBuild | undefined {
  return manifest.builds.find((build) => sameChipFamily(build.chipFamily, chip));
}

/** Resolve a part path against the manifest location. */
export function resolvePartUrl(manifestUrl: string, path: string, base?: string): string {
  return new URL(path, new URL(manifestUrl, base ?? 'http://localhost/')).toString();
}

/** Fetch and validate a manifest. */
export async function loadManifest(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FirmwareManifest> {
  const response = await fetchImpl(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new ManifestError(`could not download manifest (HTTP ${response.status})`);
  }
  return parseManifest(await response.json());
}
