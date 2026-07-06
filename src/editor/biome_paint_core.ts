// Pure helpers for the biome-paint grid resolution: pick the finest cell size
// a map's extent can afford, and upsample an existing coarser grid so old maps
// gain the finer brush the moment they are painted on. No DOM/Three imports;
// Vitest imports this directly.

import type { BiomePaint } from '../sim/types';

// The sanitizer drops grids over 1,000,000 cells (sim/map_doc.ts); stay well
// under it so the saved JSON stays reasonable and a resample can never trip
// that gate.
export const MAX_PAINT_CELLS = 600_000;

// Finest first: small and medium maps paint at 0.5yd cells (smooth, un-blocky
// brush edges), most maps at 1yd, big worlds at 2yd, only gigantic bounds at
// 4yd. The 0.5yd tier only kicks in where the grid stays under MAX_PAINT_CELLS,
// so large open-world maps are unchanged.
export const PAINT_CELL_CHOICES: readonly number[] = [0.5, 1, 2, 4];

export function finestPaintCell(width: number, depth: number): number {
  for (const cell of PAINT_CELL_CHOICES) {
    const cols = Math.ceil(width / cell) + 1;
    const rows = Math.ceil(depth / cell) + 1;
    if (cols * rows <= MAX_PAINT_CELLS) return cell;
  }
  return PAINT_CELL_CHOICES[PAINT_CELL_CHOICES.length - 1];
}

/**
 * Nearest-neighbor upsample of a paint grid to a finer cell over the same
 * world rect (same origin, same coverage), sampling by new-cell CENTER so
 * painted regions keep their exact footprint. Returns a NEW grid sharing the
 * custom swatch list; null when the grid is already at/below the target or
 * the result would exceed the sanitizer's hard cap.
 */
export function resampleBiomePaint(bp: BiomePaint, targetCell: number): BiomePaint | null {
  if (targetCell <= 0 || bp.cell <= targetCell) return null;
  const width = bp.cols * bp.cell;
  const depth = bp.rows * bp.cell;
  const cols = Math.ceil(width / targetCell);
  const rows = Math.ceil(depth / targetCell);
  if (cols * rows > 1_000_000) return null;
  const ids = new Array<number>(cols * rows);
  for (let r = 0; r < rows; r++) {
    const or = Math.min(bp.rows - 1, Math.floor(((r + 0.5) * targetCell) / bp.cell));
    for (let c = 0; c < cols; c++) {
      const oc = Math.min(bp.cols - 1, Math.floor(((c + 0.5) * targetCell) / bp.cell));
      ids[r * cols + c] = bp.ids[or * bp.cols + oc];
    }
  }
  const out: BiomePaint = {
    cell: targetCell,
    cols,
    rows,
    originX: bp.originX,
    originZ: bp.originZ,
    ids,
  };
  if (bp.custom) out.custom = bp.custom;
  return out;
}
