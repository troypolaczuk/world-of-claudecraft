// Editor skyboxes: the bundled CC0 equirect skies under /skybox/ plus
// user-uploaded ones persisted in IndexedDB (content-addressed by sha256,
// exactly the ground-texture pattern). The editor's Lighting tab picks one and
// the renderer draws it as scene.background. Never-throws: a blocked IDB or a
// missing entry resolves null and the procedural HDRI dome stays up.

const DB_NAME = 'woc_editor_skyboxes';
const STORE = 'skyboxes';
const DB_VERSION = 1;

/** Bundled skies (equirect, 4096x2048). toon_day is the project's stylized
 *  flat-color sky (converted from the author's cubemap cross). */
export const BUILTIN_SKYBOXES: readonly { id: string; path: string }[] = [
  { id: 'toon_day', path: '/skybox/toon_day.png' },
];

/** Resolve a skybox token ('builtin:<id>' | 'custom:<sha256>') to a URL the
 *  renderer can load — sync for builtins, IndexedDB lookup for uploads. The
 *  SAME resolution serves the editor preview and the playtest boot. */
export async function resolveSkyboxUrl(token: string | undefined | null): Promise<string | null> {
  if (!token) return null;
  if (token.startsWith('builtin:')) {
    const id = token.slice('builtin:'.length);
    return BUILTIN_SKYBOXES.find((s) => s.id === id)?.path ?? null;
  }
  if (token.startsWith('custom:')) return skyboxUrlFor(token.slice('custom:'.length));
  return null;
}

export interface StoredSkybox {
  sha256: string;
  name: string;
  mime: string;
  bytes: ArrayBuffer;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'sha256' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Persist an uploaded skybox (silent failure = session-only). */
export async function storeSkybox(entry: StoredSkybox): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  db.close();
}

/** Raw stored bytes for a skybox sha (bundle export), or null. */
export async function loadSkyboxBytes(sha256: string): Promise<StoredSkybox | null> {
  const db = await openDb();
  if (!db) return null;
  const out = await new Promise<StoredSkybox | null>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(sha256);
      req.onsuccess = () => resolve((req.result as StoredSkybox) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  db.close();
  return out;
}

const urlCache = new Map<string, Promise<string | null>>();

/** Object URL for a stored skybox's image, cached per sha for the session.
 *  Null when the bytes are not in this browser. */
export function skyboxUrlFor(sha256: string): Promise<string | null> {
  let p = urlCache.get(sha256);
  if (!p) {
    p = (async () => {
      const db = await openDb();
      if (!db) return null;
      const stored = await new Promise<StoredSkybox | null>((resolve) => {
        try {
          const tx = db.transaction(STORE, 'readonly');
          const req = tx.objectStore(STORE).get(sha256);
          req.onsuccess = () => resolve((req.result as StoredSkybox) ?? null);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
      db.close();
      if (!stored) return null;
      try {
        return URL.createObjectURL(new Blob([stored.bytes], { type: stored.mime }));
      } catch {
        return null;
      }
    })();
    urlCache.set(sha256, p);
  }
  return p;
}
