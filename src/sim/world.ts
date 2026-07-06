import { DUNGEON_FLOOR_Y, DUNGEON_X_THRESHOLD, getActiveWorldContent, WORLD_MAX_X } from './data';
import { fbm2, hash2 } from './rng';
import type { BiomeId, HeightStamp, WorldContent } from './types';

// Terrain is a pure function of (x, z, seed) for a given active world content:
// both the sim (ground clamping) and the renderer (mesh) sample the same
// heightfield, so they always agree. The active content is the built-in 3-zone
// world by default (data.ts BUILTIN_WORLD); the editor swaps in a custom map for
// play-testing via setActiveWorldContent. With the built-in world this file
// behaves exactly as before (byte-identical heightfield).
//
// The world is a north-running strip of zone bands (see ZONES in data.ts).
// Each biome shapes the heightfield differently — the vale rolls, the marsh
// lies low and flat, the peaks tower — with smooth blends at the boundaries
// and a mountain ridge wall between zones, pierced by a road pass.

const HILL_SCALE = 0.013;
const DETAIL_SCALE = 0.05;

// The built-in world's water surface height. Fixed-content call sites (tests,
// built-in tuning constants) may use the const; anything that must respect a
// custom map's water goes through waterLevel() below.
export const WATER_LEVEL = -4.5;

// The ACTIVE water surface height: the custom map's level if one is loaded, else
// the built-in constant. Cheap (identity-cached content lookup), safe in hot paths.
export function waterLevel(): number {
  return world().content.waterLevel ?? WATER_LEVEL;
}

// Hill amplitude / base elevation / hub plateau height per biome.
const BIOME_SHAPE: Record<BiomeId, { hill: number; base: number; hubHeight: number }> = {
  vale: { hill: 26, base: 0, hubHeight: 1.5 },
  marsh: { hill: 11, base: -1.0, hubHeight: 1.2 },
  peaks: { hill: 34, base: 7, hubHeight: 9 },
  // Paint-only biomes (the editor's biome brush): never a zone band in the
  // built-in world, so these rows only shape painted cells on custom maps.
  beach: { hill: 5, base: -2.4, hubHeight: 0.8 },
  desert: { hill: 15, base: 2.5, hubHeight: 2 },
  volcano: { hill: 42, base: 9, hubHeight: 6 },
  cave: { hill: 9, base: 1, hubHeight: 1 },
};

// Per-active-content derived terrain inputs: the ridge walls between zone bands
// and the world z-bounds. Recomputed only when the active content object changes
// (identity check), so the hot terrain path stays cheap. For the built-in world
// these match the old module-level constants exactly.
interface WorldDerived {
  content: WorldContent;
  ridges: { z: number; passX: number }[];
  minZ: number;
  maxZ: number;
  halfX: number;
}
let derivedCache: WorldDerived | null = null;
function world(): WorldDerived {
  const content = getActiveWorldContent();
  if (!derivedCache || derivedCache.content !== content) {
    const ridges: { z: number; passX: number }[] = [];
    for (let i = 0; i + 1 < content.zones.length; i++) {
      ridges.push({ z: content.zones[i].zMax, passX: 0 });
    }
    derivedCache = {
      content,
      ridges,
      minZ: content.zones[0].zMin,
      maxZ: content.zones[content.zones.length - 1].zMax,
      // Custom maps may narrow (or widen) the x extent; the built-in world
      // keeps its constant, so its heightfield stays byte-identical.
      halfX: content.worldHalfX ?? WORLD_MAX_X,
    };
  }
  return derivedCache;
}

const RIDGE_HEIGHT = 22;
const RIDGE_SIGMA = 18; // gaussian width of the wall
const PASS_HALF_WIDTH = 10; // flat opening around the road
const PASS_SHOULDER = 34; // ...rising to full wall by this far from the pass

export const MIREFEN_IMPACT_CRATER = {
  x: 149.5,
  z: 295,
  bowlRadius: 20,
  radius: 30,
  depth: 2.6,
  rimHeight: 0.95,
} as const;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ---------------------------------------------------------------------------
// The custom-map edit layer (the sculpt brushes), applied to the height computed
// so far. Stamps apply in array order; pure data, no RNG, so the sim and renderer
// agree. `add` stamps add a falloff-weighted delta; `level` stamps pull the height
// toward the absolute height `delta` (flatten/plateau/terrace). The built-in world
// has no edits, so the heightfield is unchanged.
//
// Stamps are looked up through a coarse spatial bucket index (cell 32yd; each
// stamp registered in every cell its radius's bounding box touches) instead of
// a linear scan: the render chunk rebuilder samples terrainHeight 5x per
// vertex, so with the 4000-stamp cap the linear scan grows editor brush cost
// with session length. Determinism contract: candidates for a query point are
// iterated in ascending original array index (each bucket is built in index
// order and a stamp appears at most once per bucket), so float addition order
// is bit-identical to the linear scan. The index is a pure cache keyed by the
// terrainEdits array reference + length; it is rebuilt when either differs and
// cleared by invalidateTerrainEditIndex() for same-length in-place mutations.
// ---------------------------------------------------------------------------

const EDIT_INDEX_CELL = 32; // yards per bucket cell
// A stamp this large would touch an unbounded number of cells; index none and
// fall back to the (bit-identical) linear scan. The document sanitizer caps
// stamp radius at 200, so this only guards hostile in-memory content.
const EDIT_INDEX_MAX_RADIUS = 4096;

interface TerrainEditIndex {
  length: number;
  linear: boolean; // true = do not use buckets, scan the array
  buckets: Map<string, number[]>; // "cx,cz" -> ascending stamp indices
}

let terrainEditIndexCache = new WeakMap<HeightStamp[], TerrainEditIndex>();

// Clears the edit-layer index cache. The editor MUST call this after a
// splice-style in-place mutation that keeps the array reference and length
// (e.g. replacing a stamp); push/pop/reassignment are picked up automatically
// via the length + reference key. The exact export name is a contract with the
// editor lane: do not rename.
export function invalidateTerrainEditIndex(): void {
  terrainEditIndexCache = new WeakMap();
}

function buildTerrainEditIndex(edits: HeightStamp[]): TerrainEditIndex {
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    if (e.radius <= 0) continue; // the scan skips these too; no cell to register
    // A non-finite stamp (NaN poisons the scan; Infinity reaches everywhere)
    // or an absurd radius cannot be bucketed: reproduce the linear scan's
    // exact semantics by not indexing at all.
    if (
      !Number.isFinite(e.radius) ||
      e.radius > EDIT_INDEX_MAX_RADIUS ||
      !Number.isFinite(e.x) ||
      !Number.isFinite(e.z)
    ) {
      return { length: edits.length, linear: true, buckets: new Map() };
    }
    // One guard cell on every side: sqrt rounding can put a point with
    // d < radius up to ~1 ulp outside the bbox cells at an exact cell
    // boundary. Extra candidates are harmless (applyStamp re-checks d).
    const c0 = Math.floor((e.x - e.radius) / EDIT_INDEX_CELL) - 1;
    const c1 = Math.floor((e.x + e.radius) / EDIT_INDEX_CELL) + 1;
    const r0 = Math.floor((e.z - e.radius) / EDIT_INDEX_CELL) - 1;
    const r1 = Math.floor((e.z + e.radius) / EDIT_INDEX_CELL) + 1;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const key = `${c},${r}`;
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = [];
          buckets.set(key, bucket);
        }
        bucket.push(i); // outer loop is ascending i, so each bucket stays sorted
      }
    }
  }
  return { length: edits.length, linear: false, buckets };
}

// One stamp's contribution, shared verbatim by the indexed and linear paths so
// they are bit-identical.
function applyStamp(e: HeightStamp, x: number, z: number, h: number): number {
  if (e.radius <= 0) return h;
  const dx = x - e.x;
  const dz = z - e.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d >= e.radius) return h;
  const t = d / e.radius; // 0 at centre, 1 at edge
  // 'flat' = full delta out to the edge; 'smooth' = eased taper to 0.
  const w = e.falloff === 'flat' ? 1 : 1 - smoothstep(0, 1, t);
  if (e.mode === 'level') return lerp(h, e.delta, w);
  return h + e.delta * w;
}

function applyEditLayer(x: number, z: number, h0: number): number {
  const edits = world().content.terrainEdits;
  if (!edits || edits.length === 0) return h0;
  let index = terrainEditIndexCache.get(edits);
  if (!index || index.length !== edits.length) {
    index = buildTerrainEditIndex(edits);
    terrainEditIndexCache.set(edits, index);
  }
  let h = h0;
  if (index.linear) {
    for (const e of edits) h = applyStamp(e, x, z, h);
    return h;
  }
  const key = `${Math.floor(x / EDIT_INDEX_CELL)},${Math.floor(z / EDIT_INDEX_CELL)}`;
  const bucket = index.buckets.get(key);
  if (!bucket) return h0;
  // Any stamp with d < radius has |x - e.x| < radius, so its bounding-box cells
  // cover the query cell: the bucket holds every contributing stamp, in
  // ascending array index, exactly once.
  for (const i of bucket) h = applyStamp(edits[i], x, z, h);
  return h;
}

export function mirefenImpactCraterOffset(x: number, z: number): number {
  const dx = x - MIREFEN_IMPACT_CRATER.x;
  const dz = z - MIREFEN_IMPACT_CRATER.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d >= MIREFEN_IMPACT_CRATER.radius) return 0;

  const bowlT = d / MIREFEN_IMPACT_CRATER.bowlRadius;
  const bowl =
    d < MIREFEN_IMPACT_CRATER.bowlRadius
      ? -MIREFEN_IMPACT_CRATER.depth * (1 - smoothstep(0, 1, bowlT))
      : 0;

  const rimStart = MIREFEN_IMPACT_CRATER.bowlRadius * 0.82;
  if (d <= rimStart) return bowl;
  const rimT = (d - rimStart) / (MIREFEN_IMPACT_CRATER.radius - rimStart);
  const rim =
    MIREFEN_IMPACT_CRATER.rimHeight * smoothstep(0, 0.35, rimT) * (1 - smoothstep(0.72, 1, rimT));
  return bowl + rim;
}

// Paint grid id -> biome. APPEND-ONLY: the id is persisted in map documents.
export const BIOME_BY_ID: BiomeId[] = [
  'vale',
  'marsh',
  'peaks',
  'beach',
  'desert',
  'volcano',
  'cave',
];

/** The raw painted cell id at (x,z) (built-in biome id OR a custom swatch id),
 *  or null when unpainted / no paint layer. The renderer colors custom-swatch
 *  cells directly; the sim's biome logic only follows built-in ids. */
export function paintedCellIdAt(x: number, z: number): number | null {
  const bp = world().content.biomePaint;
  if (!bp) return null;
  const c = Math.floor((x - bp.originX) / bp.cell);
  const r = Math.floor((z - bp.originZ) / bp.cell);
  if (c < 0 || c >= bp.cols || r < 0 || r >= bp.rows) return null;
  const id = bp.ids[r * bp.cols + c];
  return id === 255 ? null : id;
}

// The painted biome at (x,z), or null if unpainted / no paint layer / a custom
// color swatch (custom cells keep the zone biome's shape and gameplay biome:
// color-only painting). Cheap grid lookup; absent for the built-in world.
function paintedBiomeAt(x: number, z: number): BiomeId | null {
  const id = paintedCellIdAt(x, z);
  return id !== null && id >= 0 && id < BIOME_BY_ID.length ? BIOME_BY_ID[id] : null;
}

// Biome at a world point: the painted override if any, else the zone-band biome.
// This is the 2D biome the renderer colours by; zoneBiomeAt stays the 1D version.
export function biomeAt(x: number, z: number): BiomeId {
  return paintedBiomeAt(x, z) ?? zoneBiomeAt(z);
}

// Blended biome shape at a point: zone interiors keep their exact shape and
// blend across ±~35yd windows at the band boundaries. Biome PAINT deliberately
// does NOT participate: painting is texture/color only and must never reshape
// the terrain (it used to hard-override the shape per 8yd cell, which both
// deformed sculpted ground and read as terraced blocks).
function shapeAt(_x: number, z: number): { hill: number; base: number } {
  const zones = world().content.zones;
  let hill = BIOME_SHAPE[zones[0].biome].hill;
  let base = BIOME_SHAPE[zones[0].biome].base;
  for (let i = 0; i + 1 < zones.length; i++) {
    const boundary = zones[i].zMax;
    const t = smoothstep(boundary - 30, boundary + 35, z);
    const next = BIOME_SHAPE[zones[i + 1].biome];
    hill = lerp(hill, next.hill, t);
    base = lerp(base, next.base, t);
  }
  return { hill, base };
}

function baseHeight(x: number, z: number, seed: number): number {
  const zones = world().content.zones;
  const shape = shapeAt(x, z);
  let h =
    (fbm2(x * HILL_SCALE + 100, z * HILL_SCALE + 100, seed, 4) - 0.5) * shape.hill + shape.base;
  h += (fbm2(x * DETAIL_SCALE, z * DETAIL_SCALE, seed + 7, 2) - 0.5) * 2.2;
  // Flatten each zone's hub settlement into a plateau
  for (const zone of zones) {
    const dx = x - zone.hub.x,
      dz = z - zone.hub.z;
    const dHub = Math.sqrt(dx * dx + dz * dz);
    if (dHub < zone.hub.radius * 1.6) {
      const blend = smoothstep(zone.hub.radius * 0.7, zone.hub.radius * 1.6, dHub);
      h = h * blend + BIOME_SHAPE[zone.biome].hubHeight * (1 - blend);
    }
  }
  // Keep dry land everywhere: soft-floor low dips above the water level...
  const minLand = waterLevel() + 1.4;
  if (h < minLand) h = minLand - (minLand - h) * 0.12;
  // ...except the carved lake basins
  for (const zone of zones) {
    for (const lake of zone.lakes) {
      const dLake = Math.sqrt((x - lake.x) ** 2 + (z - lake.z) ** 2);
      if (dLake < lake.radius * 1.6) {
        const lakeBlend = smoothstep(lake.radius * 0.55, lake.radius * 1.6, dLake);
        h = h * lakeBlend + (waterLevel() - 4) * (1 - lakeBlend);
      }
    }
  }
  return h;
}

// Ground height including instanced dungeon floors (flat, far off-world) and
// editor-authored floor planes (custom maps only): inside a plane's rotated
// footprint the walkable floor is raised to the plane's level (the terrain
// height at its center plus its offset), never lowered, so movers step onto a
// flat room floor and off it again. The built-in world carries no volumes, so
// its path is unchanged.
export function groundHeight(x: number, z: number, seed: number): number {
  if (x > DUNGEON_X_THRESHOLD) return DUNGEON_FLOOR_Y;
  let h = terrainHeight(x, z, seed);
  const vols = world().content.colliderVolumes;
  if (vols) {
    for (const v of vols) {
      if (v.kind !== 'plane') continue;
      const dx = x - v.x;
      const dz = z - v.z;
      if (!v.rotX && !v.rotZ) {
        // Flat plane: into its local frame (three.js rotation.y convention, the
        // same math as sim/colliders.ts rotY with -rot).
        const c = Math.cos(v.rotY);
        const s = Math.sin(v.rotY);
        const lx = dx * c - dz * s;
        const lz = dx * s + dz * c;
        if (Math.abs(lx) > v.sizeX / 2 || Math.abs(lz) > v.sizeZ / 2) continue;
        const floor = terrainHeight(v.x, v.z, seed) + v.sizeY;
        if (floor > h) h = floor;
        continue;
      }
      // Tilted plane (a ramp): surface points are center + lx*u + lz*w, where
      // u/w are the rotated local X/Z axes under R = Rx(rotX)*Ry(rotY)*Rz(rotZ)
      // (three.js Euler 'XYZ', matching the editor overlay mesh). Solve the 2x2
      // system for (lx, lz) from the world XZ offset, bounds-check the
      // footprint, then read the surface height at that spot.
      const ca = Math.cos(v.rotX ?? 0);
      const sa = Math.sin(v.rotX ?? 0);
      const cb = Math.cos(v.rotY);
      const sb = Math.sin(v.rotY);
      const cg = Math.cos(v.rotZ ?? 0);
      const sg = Math.sin(v.rotZ ?? 0);
      const ux = cb * cg;
      const uy = ca * sg + sa * sb * cg;
      const uz = sa * sg - ca * sb * cg;
      const wx = sb;
      const wy = -sa * cb;
      const wz = ca * cb;
      const det = ux * wz - wx * uz;
      if (Math.abs(det) < 1e-6) continue; // near-vertical: no walkable surface
      const lx = (dx * wz - wx * dz) / det;
      const lz = (ux * dz - dx * uz) / det;
      if (Math.abs(lx) > v.sizeX / 2 || Math.abs(lz) > v.sizeZ / 2) continue;
      const floor = terrainHeight(v.x, v.z, seed) + v.sizeY + lx * uy + lz * wy;
      if (floor > h) h = floor;
    }
  }
  return h;
}

export function terrainHeight(x: number, z: number, seed: number): number {
  const w = world();
  let h = baseHeight(x, z, seed);

  // Flatten each camp a little so mobs don't stand on cliffs
  for (const camp of w.content.camps) {
    const dx = x - camp.center.x,
      dz = z - camp.center.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < camp.radius * 1.8) {
      const ch = baseHeight(camp.center.x, camp.center.z, seed);
      const blend = smoothstep(camp.radius * 0.8, camp.radius * 1.8, d);
      h = h * blend + ch * (1 - blend);
    }
  }

  // Mountain ridge walls between zones, pierced by the road pass
  for (const ridge of w.ridges) {
    const dz = Math.abs(z - ridge.z);
    if (dz < RIDGE_SIGMA * 3) {
      const profile = Math.exp(-(dz * dz) / (2 * RIDGE_SIGMA * RIDGE_SIGMA));
      const pass = smoothstep(PASS_HALF_WIDTH, PASS_SHOULDER, Math.abs(x - ridge.passX));
      // jagged crest so the wall reads as mountains, not a berm
      const crest = 1 + (fbm2(x * 0.03, ridge.z * 0.03, seed + 19, 2) - 0.5) * 0.7;
      h += RIDGE_HEIGHT * crest * profile * pass;
    }
  }

  // Raise the world rim so the player naturally stays in bounds
  const rimX = smoothstep(w.halfX - 30, w.halfX, Math.abs(x));
  const rimS = smoothstep(w.minZ + 30, w.minZ, z);
  const rimN = smoothstep(w.maxZ - 30, w.maxZ, z);
  const rim = Math.max(rimX, rimS, rimN);
  h += rim * 40;
  h += mirefenImpactCraterOffset(x, z);
  h = applyEditLayer(x, z, h);
  return h;
}

// Distance from (x,z) to the nearest road polyline segment.
export function roadDistance(x: number, z: number): number {
  let best = Infinity;
  for (const road of world().content.roads) {
    for (let i = 0; i < road.length - 1; i++) {
      const a = road[i],
        b = road[i + 1];
      const abx = b.x - a.x,
        abz = b.z - a.z;
      const apx = x - a.x,
        apz = z - a.z;
      const len2 = abx * abx + abz * abz;
      const t = len2 > 0 ? Math.max(0, Math.min(1, (apx * abx + apz * abz) / len2)) : 0;
      const dx = apx - abx * t,
        dz = apz - abz * t;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < best) best = d;
    }
  }
  return best;
}

// Deterministic decoration placement (trees, rocks) — used by the renderer,
// kept here so it shares the seed and stays out of mob camps / hubs / roads /
// lakes. Density and mix vary by biome: the vale is wooded, the marsh sparse
// and scrubby, the peaks rocky with hardy pines.
export interface Decoration {
  kind: 'tree' | 'tree2' | 'rock';
  x: number;
  z: number;
  scale: number;
  variant: number;
  biome: BiomeId;
}

const DECORATION_EXCLUSION_RADIUS = 1.2;
const DECORATION_EXCLUSIONS = [{ x: 2.456450840458274, z: 211.33819991815835 }];

function isExcludedDecoration(x: number, z: number): boolean {
  return DECORATION_EXCLUSIONS.some(
    (p) => Math.hypot(x - p.x, z - p.z) < DECORATION_EXCLUSION_RADIUS,
  );
}

export function zoneBiomeAt(z: number): BiomeId {
  const zones = world().content.zones;
  for (const zone of zones) {
    if (z < zone.zMax) return zone.biome;
  }
  return zones[zones.length - 1].biome;
}

export function generateDecorations(seed: number): Decoration[] {
  const w = world();
  if (w.content.decorationsMode === 'empty') return [];
  const out: Decoration[] = [];
  const step = 10;
  const xHalf = w.halfX - 14;
  for (let gx = -xHalf; gx < xHalf; gx += step) {
    for (let gz = w.minZ + 14; gz < w.maxZ - 14; gz += step) {
      const r = hash2(Math.round(gx), Math.round(gz), seed + 31);
      // biomeAt so painted areas grow the right mix; without paint this is the
      // zone-band biome exactly (byte-identical built-in world).
      const biome = biomeAt(gx, gz);
      // density gate + kind mix per biome
      let kind: Decoration['kind'] | null = null;
      if (biome === 'vale') {
        if (r > 0.48) continue;
        kind = r < 0.3 ? 'tree' : r < 0.4 ? 'tree2' : 'rock';
      } else if (biome === 'marsh') {
        if (r > 0.34) continue;
        kind = r < 0.08 ? 'tree' : r < 0.26 ? 'tree2' : 'rock';
      } else if (biome === 'beach') {
        if (r > 0.14) continue;
        kind = r < 0.05 ? 'tree' : r < 0.08 ? 'tree2' : 'rock';
      } else if (biome === 'desert') {
        if (r > 0.1) continue;
        kind = r < 0.025 ? 'tree2' : 'rock';
      } else if (biome === 'volcano') {
        if (r > 0.2) continue;
        kind = 'rock';
      } else if (biome === 'cave') {
        if (r > 0.16) continue;
        kind = 'rock';
      } else {
        if (r > 0.44) continue;
        kind = r < 0.2 ? 'tree' : r < 0.24 ? 'tree2' : 'rock';
      }
      const ox = (hash2(Math.round(gx), Math.round(gz), seed + 57) - 0.5) * step;
      const oz = (hash2(Math.round(gx), Math.round(gz), seed + 91) - 0.5) * step;
      const x = gx + ox,
        z = gz + oz;
      if (isExcludedDecoration(x, z)) continue;
      let inHub = false;
      for (const zone of w.content.zones) {
        const dx = x - zone.hub.x,
          dz = z - zone.hub.z;
        if (Math.sqrt(dx * dx + dz * dz) < zone.hub.radius + 4) {
          inHub = true;
          break;
        }
      }
      if (inHub) continue;
      if (terrainHeight(x, z, seed) < waterLevel() + 1) continue;
      if (roadDistance(x, z) < 5) continue;
      let inCamp = false;
      for (const c of w.content.camps) {
        const dx = x - c.center.x,
          dz = z - c.center.z;
        if (Math.sqrt(dx * dx + dz * dz) < c.radius + 3) {
          inCamp = true;
          break;
        }
      }
      if (inCamp) continue;
      out.push({
        kind,
        x,
        z,
        scale: 0.7 + hash2(Math.round(gx), Math.round(gz), seed + 13) * 0.9,
        variant: Math.floor(hash2(Math.round(gx), Math.round(gz), seed + 77) * 3),
        biome,
      });
    }
  }
  return out;
}
