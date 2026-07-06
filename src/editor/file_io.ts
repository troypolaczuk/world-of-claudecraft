// DOM file I/O for CustomMap documents: download to a .json file and pick one back
// in. Kept apart from persist.ts so the (de)serializer stays DOM-free and testable.

import { restoreBundleDeps, zipRead } from './bundle';
import type { CustomMap } from './custom_map';
import { parseMap, serializeMap } from './persist';

export function downloadMap(map: CustomMap): void {
  const blob = new Blob([serializeMap(map)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const safe = map.meta.name.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase() || 'map';
  a.download = `woc-map-${safe}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Open a file picker and resolve with the parsed map, or null if cancelled/invalid.
export function pickMapFile(): Promise<CustomMap | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      file
        .text()
        .then((text) => resolve(parseMap(text)))
        .catch(() => resolve(null));
    };
    input.click();
  });
}

/**
 * The result of the import picker: a parsed map, a file that was chosen but
 * could not be read as a map, or a dismissed dialog. The caller distinguishes
 * them so a cancel stays silent while a genuine bad file surfaces an error
 * (rather than the old behaviour, where BOTH looked like "nothing happened").
 */
export type MapPickOutcome =
  | { status: 'ok'; map: CustomMap }
  | { status: 'invalid' }
  | { status: 'cancelled' };

/** Read a chosen file into a CustomMap: a .wocmap.zip bundle restores its
 *  dependencies (best effort) before parsing the contained map.json; anything
 *  else is parsed as plain map JSON. Returns null when the bytes are not a map. */
async function readMapFile(file: File): Promise<CustomMap | null> {
  if (/\.zip$/i.test(file.name)) {
    const files = zipRead(new Uint8Array(await file.arrayBuffer()));
    const mapEntry = files?.find((f) => f.path === 'map.json');
    if (!files || !mapEntry) return null;
    // Dependency restore is best effort: a failed texture/model write must not
    // stop the map itself from loading (placements just fall back to holes).
    try {
      await restoreBundleDeps(files);
    } catch {
      // ignore: deps stay unresolved, the map still opens
    }
    return parseMap(new TextDecoder().decode(mapEntry.bytes));
  }
  return parseMap(await file.text());
}

/**
 * Import picker accepting a plain map .json OR a .wocmap.zip bundle. The <input>
 * is mounted in the document before .click(): a DETACHED file input does not
 * reliably fire 'change' on Firefox/Safari, which is what made Import silently
 * do nothing there. A dismissed dialog resolves via the 'cancel' event so the
 * promise can never hang forever.
 */
export function pickMapOrBundle(): Promise<MapPickOutcome> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json,application/zip,.zip';
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.setAttribute('aria-hidden', 'true');
    let settled = false;
    const settle = (outcome: MapPickOutcome): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(outcome);
    };
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        settle({ status: 'cancelled' });
        return;
      }
      readMapFile(file)
        .then((map) => settle(map ? { status: 'ok', map } : { status: 'invalid' }))
        .catch(() => settle({ status: 'invalid' }));
    });
    // Fired when the picker is dismissed with no selection (modern browsers);
    // without it a cancel would leave the promise pending and Import unusable
    // until reload.
    input.addEventListener('cancel', () => settle({ status: 'cancelled' }));
    document.body.appendChild(input);
    input.click();
  });
}
