import { describe, expect, it } from 'vitest';
import { CUSTOM_PAINT_ID_MIN, sanitizeMapDoc } from '../src/sim/map_doc';

// Custom biome-paint swatches (maker palette additions): the sanitizer keeps
// swatches in the reserved id range and preserves cells painted with them;
// unknown ids still degrade to 255 (unpainted).

function docWith(biomePaint: unknown): unknown {
  return {
    version: 2,
    meta: { id: 'm', name: 'M', createdAt: 0, updatedAt: 0, seed: 1, parentId: '' },
    content: {
      zones: [
        {
          id: 'z',
          name: 'Z',
          zMin: 0,
          zMax: 100,
          levelRange: [1, 1],
          biome: 'vale',
          hub: { x: 0, z: 0, radius: 8, name: '' },
          graveyard: { x: 0, z: 0 },
          lakes: [],
          pois: [],
          welcome: '',
        },
      ],
      camps: [],
      npcs: {},
      objects: [],
      roads: [],
    },
    terrainEdits: [],
    placements: [],
    biomePaint,
  };
}

describe('custom paint swatches', () => {
  it('round-trips swatches and keeps cells painted with them', () => {
    const id = CUSTOM_PAINT_ID_MIN;
    const doc = sanitizeMapDoc(
      docWith({
        cell: 8,
        cols: 2,
        rows: 1,
        originX: 0,
        originZ: 0,
        ids: [id, 1],
        custom: [{ id, color: 0xd024b0, label: 'Magenta' }],
      }),
    );
    expect(doc?.biomePaint?.custom).toEqual([{ id, color: 0xd024b0, label: 'Magenta' }]);
    expect(doc?.biomePaint?.ids).toEqual([id, 1]);
  });

  it('drops out-of-range swatches and degrades their cells to unpainted', () => {
    const doc = sanitizeMapDoc(
      docWith({
        cell: 8,
        cols: 2,
        rows: 1,
        originX: 0,
        originZ: 0,
        ids: [190, 1], // 190 is below the custom range and not built-in
        custom: [{ id: 190, color: 0x123456 }],
      }),
    );
    expect(doc?.biomePaint?.custom).toBeUndefined();
    expect(doc?.biomePaint?.ids).toEqual([255, 1]);
  });
});
