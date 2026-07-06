// Map bundle export/import: the map JSON plus every browser-stored dependency
// (imported models, ground textures, uploaded skybox) packaged so a map moves
// to another computer whole. Export prefers a real folder (File System Access
// API) and falls back to downloading a single .wocmap.zip; import reads that
// zip back and restores the dependencies into IndexedDB.
//
// The ZIP writer/reader here is deliberately minimal: STORED entries only (no
// compression - the payloads are already-compressed GLB/PNG/JPG), which keeps
// both sides ~80 lines and dependency-free.

import { loadGroundTextureBytes } from '../render/assets/ground_textures';
import { loadSkyboxBytes, storeSkybox } from '../render/assets/skyboxes';
import type { CustomMap } from './custom_map';
import { isLocalAssetId } from './local_assets';
import { loadStoredLocalAssets, storeLocalAssetBytes } from './local_assets_db';
import { serializeMap } from './persist';

export interface BundleFile {
  path: string;
  bytes: Uint8Array;
}

const enc = new TextEncoder();

// ---- CRC32 (standard polynomial), table-driven --------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- minimal ZIP (stored) ------------------------------------------------------

export function zipStore(files: readonly BundleFile[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.path);
    const crc = crc32(f.bytes);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(8, 0, true); // method: stored
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.bytes.length, true);
    lv.setUint32(22, f.bytes.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    chunks.push(local, f.bytes);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.bytes.length, true);
    cv.setUint32(24, f.bytes.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    offset += local.length + f.bytes.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of [...chunks, ...central, end]) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

/** Read a STORED-entries zip (the format zipStore writes). Compressed entries
 *  return null (foreign zips are out of scope). */
export function zipRead(bytes: Uint8Array): BundleFile[] | null {
  const files: BundleFile[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  const dec = new TextDecoder();
  while (pos + 30 <= bytes.length && view.getUint32(pos, true) === 0x04034b50) {
    const method = view.getUint16(pos + 8, true);
    const size = view.getUint32(pos + 18, true);
    const nameLen = view.getUint16(pos + 26, true);
    const extraLen = view.getUint16(pos + 28, true);
    if (method !== 0) return null;
    const nameStart = pos + 30;
    const dataStart = nameStart + nameLen + extraLen;
    if (dataStart + size > bytes.length) return null;
    files.push({
      path: dec.decode(bytes.subarray(nameStart, nameStart + nameLen)),
      bytes: bytes.slice(dataStart, dataStart + size),
    });
    pos = dataStart + size;
  }
  return files.length > 0 ? files : null;
}

// ---- bundle build --------------------------------------------------------------

/** Collect the map JSON plus every dependency stored in this browser. */
export async function buildMapBundle(map: CustomMap): Promise<BundleFile[]> {
  const files: BundleFile[] = [{ path: 'map.json', bytes: enc.encode(serializeMap(map)) }];
  // Imported local models referenced by 'local/<sha>' placements.
  const usedShas = new Set<string>();
  for (const p of map.placements) {
    if (isLocalAssetId(p.assetId)) usedShas.add(p.assetId.slice('local/'.length));
  }
  if (usedShas.size > 0) {
    for (const stored of await loadStoredLocalAssets()) {
      if (!usedShas.has(stored.sha256)) continue;
      files.push({ path: `models/${stored.sha256}.glb`, bytes: new Uint8Array(stored.bytes) });
    }
  }
  // Ground textures behind custom paint swatches.
  for (const sw of map.biomePaint?.custom ?? []) {
    if (!sw.textureSha) continue;
    const stored = await loadGroundTextureBytes(sw.textureSha);
    if (stored) {
      files.push({ path: `textures/${stored.sha256}`, bytes: new Uint8Array(stored.bytes) });
    }
  }
  // The uploaded skybox, when the map uses one.
  if (map.skybox?.startsWith('custom:')) {
    const stored = await loadSkyboxBytes(map.skybox.slice('custom:'.length));
    if (stored) {
      files.push({ path: `skybox/${stored.sha256}`, bytes: new Uint8Array(stored.bytes) });
    }
  }
  return files;
}

/** Restore a bundle's dependencies into this browser's stores (import side). */
export async function restoreBundleDeps(files: readonly BundleFile[]): Promise<void> {
  for (const f of files) {
    if (f.path.startsWith('models/')) {
      const sha = f.path.slice('models/'.length).replace(/\.glb$/i, '');
      await storeLocalAssetBytes({
        sha256: sha,
        name: sha.slice(0, 8),
        mime: 'model/gltf-binary',
        byteSize: f.bytes.length,
        bytes: f.bytes.slice().buffer,
      });
    } else if (f.path.startsWith('textures/')) {
      const sha = f.path.slice('textures/'.length);
      const { storeGroundTexture } = await import('../render/assets/ground_textures');
      await storeGroundTexture({
        sha256: sha,
        name: sha.slice(0, 8),
        mime: 'image/png',
        bytes: f.bytes.slice().buffer,
      });
    } else if (f.path.startsWith('skybox/')) {
      const sha = f.path.slice('skybox/'.length);
      await storeSkybox({
        sha256: sha,
        name: sha.slice(0, 8),
        mime: 'image/png',
        bytes: f.bytes.slice().buffer,
      });
    }
  }
}
