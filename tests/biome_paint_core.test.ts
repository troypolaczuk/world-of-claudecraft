import { describe, expect, it } from 'vitest';
import {
  finestPaintCell,
  MAX_PAINT_CELLS,
  resampleBiomePaint,
} from '../src/editor/biome_paint_core';
import type { BiomePaint } from '../src/sim/types';

function grid(cell: number, cols: number, rows: number, fill = 255): BiomePaint {
  return {
    cell,
    cols,
    rows,
    originX: -10,
    originZ: -20,
    ids: new Array(cols * rows).fill(fill),
  };
}

describe('finestPaintCell', () => {
  it('gives small maps 1yd cells', () => {
    expect(finestPaintCell(400, 400)).toBe(1);
  });

  it('gives the full-size world 2yd cells', () => {
    // Built-in world extent: 900 wide, ~1920 deep. 1yd would be ~1.7M cells.
    expect(finestPaintCell(900, 1920)).toBe(2);
  });

  it('never exceeds the cell budget', () => {
    for (const [w, d] of [
      [100, 100],
      [600, 600],
      [900, 1920],
      [4000, 4000],
    ]) {
      const cell = finestPaintCell(w, d);
      const cols = Math.ceil(w / cell) + 1;
      const rows = Math.ceil(d / cell) + 1;
      if (cell < 4) expect(cols * rows).toBeLessThanOrEqual(MAX_PAINT_CELLS);
    }
  });
});

describe('resampleBiomePaint', () => {
  it('returns null when already at or below the target cell', () => {
    expect(resampleBiomePaint(grid(2, 10, 10), 2)).toBeNull();
    expect(resampleBiomePaint(grid(1, 10, 10), 2)).toBeNull();
  });

  it('upsamples 4yd to 2yd preserving the painted footprint', () => {
    const bp = grid(4, 4, 4);
    // Paint old cell (col 1, row 2) with biome 3.
    bp.ids[2 * 4 + 1] = 3;
    const fine = resampleBiomePaint(bp, 2);
    expect(fine).not.toBeNull();
    if (!fine) return;
    expect(fine.cell).toBe(2);
    expect(fine.cols).toBe(8);
    expect(fine.rows).toBe(8);
    expect(fine.originX).toBe(bp.originX);
    expect(fine.originZ).toBe(bp.originZ);
    // The old painted cell covered world cols [4yd..8yd) x rows [8yd..12yd)
    // from the origin: exactly new cols 2..3 x rows 4..5.
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const painted = c >= 2 && c <= 3 && r >= 4 && r <= 5;
        expect(fine.ids[r * 8 + c]).toBe(painted ? 3 : 255);
      }
    }
  });

  it('keeps the custom swatch list by reference', () => {
    const bp = grid(4, 2, 2);
    bp.custom = [{ id: 200, color: 0xff00ff }];
    const fine = resampleBiomePaint(bp, 1);
    expect(fine?.custom).toBe(bp.custom);
  });

  it('refuses a resample that would exceed the sanitizer cap', () => {
    // 4000x4000 world at 4yd = 1000x1000 cells; 1yd would be 16M cells.
    expect(resampleBiomePaint(grid(4, 1000, 1000), 1)).toBeNull();
  });
});
