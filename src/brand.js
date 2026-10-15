import { readFileSync, statSync } from 'node:fs';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export class BrandError extends Error {}

/** Read a logo once at startup; an empty path means no logo. Served from memory, never by path. */
export function loadLogo(path) {
  if (!path) return null;
  let size;
  try {
    size = statSync(path).size;
  } catch (e) {
    throw new BrandError(`cannot read logo ${path}: ${e.message}`);
  }
  if (size > MAX_LOGO_BYTES) throw new BrandError(`logo ${path} is over ${MAX_LOGO_BYTES / 1024 / 1024} MB`);
  const buf = readFileSync(path);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE) || buf.toString('latin1', 12, 16) !== 'IHDR') {
    throw new BrandError(`logo ${path} is not a PNG file`);
  }
  return { bytes: buf, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function loadBrand(cfg) {
  return { light: loadLogo(cfg.logoLight), dark: loadLogo(cfg.logoDark) };
}
