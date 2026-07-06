// The serializable custom-map document: the editor's save format, the JSON a
// player exports/imports, and the JSONB the server stores for saved/forked maps.
// Lives in src/sim (DOM-free, deterministic) because BOTH sides must agree on
// what a valid document is: the editor parses untrusted local files with the
// exact sanitizer the server applies to untrusted uploads. Never throws: every
// field is validated, clamped, and def-filled; an unsalvageable input returns
// null. The wire/storage shape is CustomMap v1 plus the optional v2 fields
// (waterLevel, playerStart, meta.description/parentId, stamp mode, placement
// collide + collideRadius, blockers, propsMode, decorationsMode), so every v1
// document parses unchanged.

import type {
  BiomePaint,
  BlockerDef,
  CampDef,
  CustomPaintSwatch,
  GroundObjectDef,
  HeightStamp,
  MapMusic,
  MapWeather,
  NpcDef,
  TerrainStyle,
  ZoneDef,
} from './types';
import { BIOME_BY_ID } from './world';

export const MAP_DOC_VERSION = 2;

// Hard caps applied by the sanitizer (the server stores what the sanitizer
// returns, so these bound document size and playtest cost).
// Terrain stamps are spatially indexed (world.ts EDIT_INDEX_CELL), so
// per-sample cost tracks LOCAL stamp density, not the total; 10k stamps is
// ~80KiB JSON, well under the 2MiB server payload cap. The cap still exists
// so a hostile document cannot stall the editor's chunk rebuilds.
export const MAX_TERRAIN_EDITS = 10_000;
export const MAX_PLACEMENTS = 4000;
export const MAX_CAMPS = 600;
export const MAX_NPCS = 200;
export const MAX_OBJECTS = 400;
export const MAX_ZONES = 12;
export const MAX_ROADS = 64;
export const MAX_ROAD_POINTS = 256;
export const MAX_NAME_LENGTH = 60;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MIN_WATER_LEVEL = -40;
export const MAX_WATER_LEVEL = 40;
// Playtest-cost bounds for gameplay arrays: the Sim spawns camp.count mobs per
// camp and one ground object per position, so both are hard-clamped here (the
// built-in camps top out at count 14; see src/sim/content/zone*.ts).
export const MAX_CAMP_COUNT = 20;
export const MAX_CAMP_RADIUS = 100;
export const MAX_OBJECT_POSITIONS = 100;
export const MAX_ID_LENGTH = 64;
// Generous world-coordinate bound (the built-in world spans ~360yd); camp, NPC,
// and object coordinates are clamped into it so a hostile document cannot park
// gameplay content at astronomical positions.
export const MAX_WORLD_COORD = 10_000;
// Zone sub-arrays feed terrainHeight per sampled vertex (lakes) and the
// decoration generator loop bounds (zMin/zMax), so a stored map must not be
// able to carry unbounded values a viewer's tab then pays for.
export const MAX_ZONE_LAKES = 32;
export const MAX_ZONE_POIS = 64;
export const MAX_STR_ARRAY = 64;
// Per-placement collision-radius override bounds (yards). The derived
// collideRadiusFor(scale, assetId) shares the same cap; both stay bounded so a
// hostile document cannot wall off the world with one placement.
export const MIN_COLLIDE_RADIUS = 0.1;
export const MAX_COLLIDE_RADIUS = 30;
// Invisible blocker walls: entry cap and per-segment length bounds (yards).
// Each blocker becomes one static OBB collider at playtest, so both the count
// and the segment length are hard-clamped here.
export const MAX_BLOCKERS = 128;
// Named locations (authored sub-zone rects), AI marker points, and authored
// point lights. Lights are capped hard: each rides the renderer's ranked
// point-light budget.
export const MAX_LOCATIONS = 64;
export const MAX_MARKERS = 128;
export const MAX_LIGHTS = 24;
export const MAX_LOCATION_NAME = 40;
// Ambience animation speed (map "world speed"): render-cosmetic motion only.
export const MIN_TIME_SCALE = 0.25;
export const MAX_TIME_SCALE = 2;
// Placed-asset view distance (yards from the camera): how far free-placed decor
// renders before it fades out and culls, capped at the fog either way. Render-
// only performance knob; never affects gameplay. MAX reads as "to the fog".
export const MIN_ASSET_VIEW_DISTANCE = 120;
export const MAX_ASSET_VIEW_DISTANCE = 2000;
export const DEFAULT_ASSET_VIEW_DISTANCE = 500;
export const MIN_BLOCKER_LENGTH = 0.5;
export const MAX_BLOCKER_LENGTH = 200;
// Collider-volume placement dimensions (yards): footprint sides are bounded
// like blocker segments so one hostile placement cannot wall the world; the
// vertical size doubles as a plane's floor offset, so it may be negative.
export const MIN_COLLIDER_SIZE = 0.1;
export const MAX_COLLIDER_SIZE = 200;
export const MIN_COLLIDER_SIZE_Y = -100;
export const MAX_COLLIDER_SIZE_Y = 100;
// Custom biome-paint swatch ids live well clear of the built-in BIOME_BY_ID
// range and of 255 (unpainted), bounded so the palette stays small.
export const CUSTOM_PAINT_ID_MIN = 200;
export const CUSTOM_PAINT_ID_MAX = 250;
export const MAX_CUSTOM_PAINT_SWATCHES = 24;
export const MAX_SWATCH_LABEL_LENGTH = 24;
// Per-axis scale multipliers (gizmo axis handles) share the uniform scale's
// bounds, so the combined per-axis scale stays within sane document limits.
export const MIN_AXIS_SCALE = 0.05;
export const MAX_AXIS_SCALE = 50;
// A placement's vertical offset above its terrain seat (the gizmo's Y arrow).
export const MAX_PLACEMENT_Y_OFFSET = 200;
// Max length of a placement's editor display name (Scene Collection rename).
export const MAX_PLACEMENT_NAME_LENGTH = 40;

// A free-form GLB placement from the asset catalogue. `collide` opts the
// placement into a sim circle collider at playtest (see collideRadiusFor).
export interface MapPlacement {
  assetId: string; // catalogue id, e.g. "props/well"
  x: number;
  z: number;
  rotY: number; // radians
  scale: number;
  collide: boolean;
  // Optional collision-radius override in yards (clamped to
  // [MIN_COLLIDE_RADIUS, MAX_COLLIDE_RADIUS]); absent = derive from scale via
  // collideRadiusFor. Only meaningful while collide is true, but stored either
  // way so toggling collide off and back on keeps the authored radius.
  collideRadius?: number;
  // Footprint shape: absent = circle; 'square' = a yaw-following OBB whose
  // half-extents equal the (derived or overridden) radius.
  collideShape?: 'square';
  // v2 optional: per-axis dimensions for 'collider/<kind>' placements (yards
  // at scale 1; see sim/collider_volumes.ts). Absent = the kind's default.
  // Ignored for ordinary model placements.
  sizeX?: number;
  sizeY?: number;
  sizeZ?: number;
  // v2 optional: extra visual transform axes (the editor's 3-axis gizmo).
  // rotX/rotZ tilt the MODEL only (radians; collision keeps its yaw-only
  // footprint); scaleX/Y/Z multiply the uniform scale per axis. Absent = 0 / 1.
  rotX?: number;
  rotZ?: number;
  scaleX?: number;
  scaleY?: number;
  scaleZ?: number;
  // v2 optional: vertical offset above the terrain seat (yards; the gizmo's Y
  // arrow). Visual only: the circle collider stays at ground level.
  y?: number;
  // v3 optional (editor): grabbing a placement with the Move tool DETACHES it
  // from the terrain seat — its world Y stops tracking terrainHeight so the maker
  // can float it anywhere. `groundY` freezes the terrain height captured at detach
  // time; the model seats at groundY - minY*scaleY + y. Render-only like `y`:
  // the sim collider stays at ground level (collision is 2D).
  detached?: boolean;
  groundY?: number;
  // v3 optional (editor): the Scene Collection panel's per-object display name
  // (double-click to rename). Absent = the derived catalogue/collider label.
  name?: string;
  // v3 optional (editor): hidden from the EDITOR viewport only (the Scene
  // Collection eyeball). The object still exists in the map and renders in
  // playtest/export; this flag only skips it in the editor's 3D + 2D overlays.
  hidden?: boolean;
  // v2 optional: grass hue override in degrees [0, 360] for 'grass/patch'
  // placements (the foliage brush's animated grass). Absent = the game's
  // default grass tint. Ignored for ordinary model placements.
  hue?: number;
  // v2 optional, grass patches only: blade lightness [0, 1] (absent = the
  // default meadow lightness) and tufts per patch [1, 60] (absent = the
  // default clump; 1 = a single strand).
  lum?: number;
  clump?: number;
  // v2 optional: per-placement material overrides (the asset library's shader
  // tweaks). tint multiplies the albedo (0xFFFFFF = unchanged); opacity < 1
  // renders the model transparent; glow adds an emissive color scaled by
  // glowStrength. Applied in editor AND playtest.
  tint?: number;
  opacity?: number;
  glow?: number;
  glowStrength?: number;
  // v2 optional: animated fire effect at the model's top (render-only; a
  // campfire-style light joins the playtest boot set). Absent = none.
  fire?: boolean;
}

// Reserved placement id for the foliage brush's animated grass: no GLB behind
// it; the renderer draws a procedural tuft cluster (the same grass cards the
// built-in world streams around the player). Purely cosmetic: never collides,
// never touches the sim.
export const GRASS_PATCH_ASSET_ID = 'grass/patch';
// The sentinel "path" placementsToRenderAssets resolves the id to; the placed-
// asset renderer intercepts it instead of fetching a model.
export const GRASS_PATCH_PATH = 'procedural://grass-patch';

// Reserved placement id for the water tool's animated waterfall: procedural
// like the grass patch (no GLB), purely cosmetic, never collides.
export const WATERFALL_ASSET_ID = 'water/waterfall';
export const WATERFALL_PATH = 'procedural://waterfall';

export interface MapDocMeta {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  seed: number;
  // Fork lineage (set by the server on fork; empty string = original work).
  parentId: string;
}

// The spatial content tables, mirroring the per-zone content modules. `objects`
// matches the stored-JSON key (WorldContent calls them groundObjects).
export interface MapDocContent {
  zones: ZoneDef[];
  camps: CampDef[];
  npcs: Record<string, NpcDef>;
  objects: GroundObjectDef[];
  roads: { x: number; z: number }[][];
}

export interface MapDoc {
  version: number;
  meta: MapDocMeta;
  content: MapDocContent;
  terrainEdits: HeightStamp[];
  placements: MapPlacement[];
  biomePaint?: BiomePaint;
  // v2: invisible blocker walls (collision-only segments); absent = none.
  blockers?: BlockerDef[];
  // v2: map-wide water surface height; absent = the built-in WATER_LEVEL.
  waterLevel?: number;
  // v2 optional: half the world's x extent in yards (the world spans
  // [-worldHalfX, worldHalfX]); absent = the built-in WORLD_MAX_X. The z extent
  // is already per-map via the zone bands' zMin/zMax.
  worldHalfX?: number;
  // v2: where playtest drops the player; absent = the built-in start.
  playerStart?: { x: number; z: number };
  // v2 optional: the map's sky. 'builtin:<id>' names a bundled equirect image
  // (render/assets/skyboxes.ts); 'custom:<sha256>' an uploaded one (IndexedDB,
  // exported with the map bundle). Absent = the procedural HDRI sky.
  skybox?: string;
  // v2: built-in static prop set by default; 'empty' gives blank authoring maps
  // no houses/fences/market props unless the maker places assets explicitly.
  propsMode?: 'empty';
  // v2: procedural terrain decorations by default; 'empty' removes trees/rocks.
  decorationsMode?: 'empty';
  // v2: render-only world dressing by default; 'blank' is the flat-map slate.
  presentationMode?: 'blank';
  // v2 optional: named locations - axis-aligned rects the HUD shows as the
  // player's current location name in playtest.
  locations?: MapLocation[];
  // v2 optional: editor-only marker points ("quest giver goes here", "chest
  // here") for AI quest/event generation. NEVER rendered or projected into
  // playtest; they only live in the document.
  markers?: MapMarker[];
  // v2 optional: authored point lights (rendered in editor AND playtest).
  lights?: MapLight[];
  // v2 optional: auto-texturing rule toggles (slope rock, snow caps, rim
  // mountains, shore sand). Absent = every rule on (the shipped look).
  terrainStyle?: TerrainStyle;
  // v2 optional: ambience animation speed (0.25..2, render-only cosmetic
  // motion: water, foliage sway, fire, birds, weather). Absent = 1.
  timeScale?: number;
  // v2 optional: how far placed decor renders before it culls (yards from the
  // camera, capped at the fog). Render-only perf knob. Absent = the default.
  assetViewDistance?: number;
  // v2 optional: ambient weather (fixed mode or a timed schedule, plus the
  // cloud deck). Render-only; absent = the biome rule.
  weather?: MapWeather;
  // v2 optional: authored soundtrack (map-wide track + per-area rects).
  music?: MapMusic;
}

export interface MapLocation {
  name: string;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface MapMarker {
  name: string;
  kind: 'npc' | 'object';
  x: number;
  z: number;
}

export interface MapLight {
  x: number;
  z: number;
  /** Height above the terrain seat (yards). */
  y: number;
  color: number; // 0xRRGGBB
  intensity: number;
  range: number; // yards
}

// Placed assets are normalized to ~2.2yd max dimension at scale 1 by the
// renderer (src/render/placed_assets.ts TARGET_HEIGHT), so a colliding
// placement gets a footprint radius proportional to its scale. What should
// BLOCK differs per family though: a tree blocks by its trunk (its normalized
// max dimension is the canopy/height), a rock by most of its body. Matched by
// assetId prefix; unknown ids keep the generic factor. Pure data in the
// document pipeline: the sim never opens the GLB.
const COLLIDE_FACTOR_DEFAULT = 0.8;
const COLLIDE_FACTORS: readonly { prefix: string; factor: number }[] = [
  { prefix: 'foliage/oak', factor: 0.22 },
  { prefix: 'foliage/pine', factor: 0.22 },
  { prefix: 'foliage/dead', factor: 0.18 },
  { prefix: 'foliage/twisted', factor: 0.22 },
  { prefix: 'foliage/bush', factor: 0.5 },
  { prefix: 'foliage/fern', factor: 0.35 },
  { prefix: 'foliage/mushroom', factor: 0.35 },
  { prefix: 'foliage/rock', factor: 0.7 },
  { prefix: 'grass/', factor: 0.3 },
];

/**
 * The derived (auto) collision radius for a placement: per-family footprint
 * factor times scale, so the blocking circle tracks the VISUAL silhouette at
 * every scale instead of the old flat 0.8*scale capped at 8 (which walled off
 * huge areas around scaled-up tree trunks). Capped at the same bound as the
 * manual override so one placement still cannot wall off the world.
 */
export function collideRadiusFor(scale: number, assetId?: string): number {
  let factor = COLLIDE_FACTOR_DEFAULT;
  if (assetId) {
    for (const f of COLLIDE_FACTORS) {
      if (assetId.startsWith(f.prefix)) {
        factor = f.factor;
        break;
      }
    }
  }
  return Math.max(MIN_COLLIDE_RADIUS, Math.min(MAX_COLLIDE_RADIUS, factor * scale));
}

export function serializeMapDoc(doc: MapDoc): string {
  return JSON.stringify(doc, null, 2);
}

const DEFAULT_SEED = 20061; // the game's fixed world seed (src/main.ts WORLD_SEED)

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
// Every accepted number must pass this (never bare `typeof === 'number'`):
// JSON.parse turns 1e999 into Infinity, which JSON.stringify then stores as
// null in JSONB, making the stored document unloadable forever.
function finiteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function coord(v: number): number {
  return clamp(v, -MAX_WORLD_COORD, MAX_WORLD_COORD);
}
function idStr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LENGTH ? v : null;
}
function strArray(v: unknown): string[] {
  return arr(v)
    .filter((s): s is string => typeof s === 'string')
    .slice(0, MAX_STR_ARRAY)
    .map((s) => s.slice(0, MAX_ID_LENGTH));
}

function sanitizeStamp(v: unknown): HeightStamp | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  if (typeof s.x !== 'number' || typeof s.z !== 'number') return null;
  if (!Number.isFinite(s.x) || !Number.isFinite(s.z)) return null;
  const radius = num(s.radius, 0);
  if (radius <= 0) return null;
  const stamp: HeightStamp = {
    x: s.x,
    z: s.z,
    radius: clamp(radius, 0.1, 200),
    delta: clamp(num(s.delta, 0), -200, 200),
    falloff: s.falloff === 'flat' ? 'flat' : 'smooth',
  };
  if (s.mode === 'level') stamp.mode = 'level';
  return stamp;
}

function sanitizePlacement(v: unknown): MapPlacement | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  if (typeof p.assetId !== 'string' || p.assetId.length > 128) return null;
  if (typeof p.x !== 'number' || typeof p.z !== 'number') return null;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return null;
  const out: MapPlacement = {
    assetId: p.assetId,
    x: p.x,
    z: p.z,
    rotY: num(p.rotY, 0),
    scale: clamp(num(p.scale, 1) || 1, 0.05, 50),
    collide: p.collide === true,
  };
  // Optional radius override: accepted only finite, always clamped. Kept even
  // while collide is false (cheap, and it survives a collide re-toggle).
  if (finiteNum(p.collideRadius)) {
    out.collideRadius = clamp(p.collideRadius, MIN_COLLIDE_RADIUS, MAX_COLLIDE_RADIUS);
  }
  if (p.collideShape === 'square') out.collideShape = 'square';
  // Optional collider-volume dimensions: same accept-only-finite, always-clamp
  // contract. Harmless on ordinary placements (nothing reads them there).
  if (finiteNum(p.sizeX)) out.sizeX = clamp(p.sizeX, MIN_COLLIDER_SIZE, MAX_COLLIDER_SIZE);
  if (finiteNum(p.sizeY)) out.sizeY = clamp(p.sizeY, MIN_COLLIDER_SIZE_Y, MAX_COLLIDER_SIZE_Y);
  if (finiteNum(p.sizeZ)) out.sizeZ = clamp(p.sizeZ, MIN_COLLIDER_SIZE, MAX_COLLIDER_SIZE);
  // Optional gizmo transform axes: tilts accepted finite like rotY; per-axis
  // scale multipliers clamped to the uniform scale's bounds.
  if (finiteNum(p.rotX)) out.rotX = p.rotX;
  if (finiteNum(p.rotZ)) out.rotZ = p.rotZ;
  if (finiteNum(p.scaleX)) out.scaleX = clamp(p.scaleX, MIN_AXIS_SCALE, MAX_AXIS_SCALE);
  if (finiteNum(p.scaleY)) out.scaleY = clamp(p.scaleY, MIN_AXIS_SCALE, MAX_AXIS_SCALE);
  if (finiteNum(p.scaleZ)) out.scaleZ = clamp(p.scaleZ, MIN_AXIS_SCALE, MAX_AXIS_SCALE);
  if (finiteNum(p.y)) out.y = clamp(p.y, -MAX_PLACEMENT_Y_OFFSET, MAX_PLACEMENT_Y_OFFSET);
  // Editor detach: a detached placement floats at a frozen ground height instead
  // of tracking terrainHeight (see MapPlacement.detached). Both survive the round
  // trip so a saved/imported map keeps floating objects put.
  if (p.detached === true) {
    out.detached = true;
    if (finiteNum(p.groundY)) out.groundY = p.groundY;
  }
  // Editor-only Scene Collection metadata: a display-name rename and a viewport
  // hide flag. Names are trimmed and length-capped like the other rename inputs.
  if (typeof p.name === 'string' && p.name.trim().length > 0) {
    out.name = p.name.trim().slice(0, MAX_PLACEMENT_NAME_LENGTH);
  }
  if (p.hidden === true) out.hidden = true;
  // Grass-patch color/clump fields; harmless on ordinary placements.
  if (finiteNum(p.hue)) out.hue = clamp(p.hue, 0, 360);
  if (finiteNum(p.lum)) out.lum = clamp(p.lum, 0, 1);
  if (finiteNum(p.clump)) out.clump = Math.round(clamp(p.clump, 1, 60));
  // Material overrides (shader tweaks): accepted finite, clamped.
  if (finiteNum(p.tint)) out.tint = Math.round(clamp(p.tint, 0, 0xffffff));
  if (finiteNum(p.opacity)) out.opacity = clamp(p.opacity, 0.05, 1);
  if (finiteNum(p.glow)) out.glow = Math.round(clamp(p.glow, 0, 0xffffff));
  if (finiteNum(p.glowStrength)) out.glowStrength = clamp(p.glowStrength, 0, 8);
  if (p.fire === true) out.fire = true;
  return out;
}

/**
 * Clamp a blocker segment's length: null when shorter than MIN_BLOCKER_LENGTH
 * (too small to author deliberately), far end truncated toward the anchor when
 * longer than MAX_BLOCKER_LENGTH. Shared by the sanitizer and the editor's
 * live drag preview so what you see while drawing is what gets stored.
 */
export function clampBlockerSegment(
  x1: number,
  z1: number,
  x2: number,
  z2: number,
): BlockerDef | null {
  const dx = x2 - x1;
  const dz = z2 - z1;
  const len = Math.hypot(dx, dz);
  if (len < MIN_BLOCKER_LENGTH) return null;
  // The epsilon keeps the truncation idempotent: hypot rounding can leave a
  // truncated segment ~1 ulp over the cap, and re-sanitizing the stored bytes
  // must not produce a new byte-different (spuriously dirty) document.
  if (len > MAX_BLOCKER_LENGTH + 1e-6) {
    const k = MAX_BLOCKER_LENGTH / len;
    return { x1, z1, x2: x1 + dx * k, z2: z1 + dz * k };
  }
  return { x1, z1, x2, z2 };
}

// A blocker wall must have four finite coordinates; they are clamped into the
// world bound BEFORE the length rules, so a truncated far end (interpolated
// between two in-bound points) stays in bounds too.
function sanitizeBlocker(v: unknown): BlockerDef | null {
  if (!v || typeof v !== 'object') return null;
  const b = v as Record<string, unknown>;
  if (!finiteNum(b.x1) || !finiteNum(b.z1) || !finiteNum(b.x2) || !finiteNum(b.z2)) return null;
  return clampBlockerSegment(coord(b.x1), coord(b.z1), coord(b.x2), coord(b.z2));
}

// Maker-defined paint swatches: bounded count, ids in the reserved custom
// range and unique, colors clamped to 24-bit, labels truncated.
function sanitizeCustomSwatches(v: unknown): CustomPaintSwatch[] {
  const out: CustomPaintSwatch[] = [];
  const seen = new Set<number>();
  for (const raw of arr(v).slice(0, MAX_CUSTOM_PAINT_SWATCHES)) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    if (!finiteNum(s.id) || !Number.isInteger(s.id)) continue;
    if (s.id < CUSTOM_PAINT_ID_MIN || s.id > CUSTOM_PAINT_ID_MAX || seen.has(s.id)) continue;
    if (!finiteNum(s.color)) continue;
    seen.add(s.id);
    const swatch: CustomPaintSwatch = {
      id: s.id,
      color: Math.floor(clamp(s.color, 0, 0xffffff)),
    };
    if (typeof s.label === 'string' && s.label.length > 0) {
      swatch.label = s.label.slice(0, MAX_SWATCH_LABEL_LENGTH);
    }
    if (typeof s.textureSha === 'string' && /^[a-f0-9]{64}$/.test(s.textureSha)) {
      swatch.textureSha = s.textureSha;
    }
    if (finiteNum(s.tileSize)) swatch.tileSize = clamp(s.tileSize, 1, 64);
    out.push(swatch);
  }
  return out;
}

// Validate a biome paint grid: ids length must match cols*rows and cell must be
// positive, else the grid is dropped. Unknown biome ids become 255 (unpainted)
// unless they name one of the document's custom swatches, so a document from a
// future build degrades instead of breaking.
function sanitizeBiomePaint(v: unknown): BiomePaint | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const b = v as Record<string, unknown>;
  const cols = num(b.cols, 0);
  const rows = num(b.rows, 0);
  const cell = num(b.cell, 0);
  if (cols <= 0 || rows <= 0 || cell <= 0) return undefined;
  if (cols * rows > 1_000_000) return undefined;
  if (!Array.isArray(b.ids) || b.ids.length !== cols * rows) return undefined;
  const custom = sanitizeCustomSwatches(b.custom);
  const customIds = new Set(custom.map((s) => s.id));
  const idCount = BIOME_BY_ID.length;
  const ids = b.ids.map((n) =>
    typeof n === 'number' && Number.isInteger(n) && n >= 0 && (n < idCount || customIds.has(n))
      ? n
      : 255,
  );
  const paint: BiomePaint = {
    cell,
    cols,
    rows,
    originX: num(b.originX, 0),
    originZ: num(b.originZ, 0),
    ids,
  };
  if (custom.length > 0) paint.custom = custom;
  return paint;
}

function sanitizeMeta(v: unknown): MapDocMeta {
  const m = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const created = num(m.createdAt, 0);
  return {
    id: str(m.id, '').slice(0, 64),
    name: str(m.name, 'Untitled Map').slice(0, MAX_NAME_LENGTH),
    description: str(m.description, '').slice(0, MAX_DESCRIPTION_LENGTH),
    createdAt: created,
    updatedAt: num(m.updatedAt, created),
    seed: Math.floor(num(m.seed, DEFAULT_SEED)),
    parentId: str(m.parentId, '').slice(0, 64),
  };
}

// The Sim spawns camp.count mobs inside camp.radius, so every field is
// validated and clamped; a malformed camp is dropped, never thrown on.
function sanitizeCamp(v: unknown): CampDef | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  const mobId = idStr(c.mobId);
  if (!mobId) return null;
  const center = c.center as Record<string, unknown> | null | undefined;
  if (!center || typeof center !== 'object') return null;
  if (!finiteNum(center.x) || !finiteNum(center.z)) return null;
  return {
    mobId,
    center: { x: coord(center.x), z: coord(center.z) },
    radius: clamp(num(c.radius, 5), 0.5, MAX_CAMP_RADIUS),
    count: clamp(Math.floor(num(c.count, 1)), 1, MAX_CAMP_COUNT),
  };
}

// NPC ids are validated for shape only (the engine tolerates an unknown quest
// or vendor item id; it just renders nothing for it).
function sanitizeNpc(v: unknown): NpcDef | null {
  if (!v || typeof v !== 'object') return null;
  const n = v as Record<string, unknown>;
  const id = idStr(n.id);
  if (!id) return null;
  const pos = n.pos as Record<string, unknown> | null | undefined;
  if (!pos || typeof pos !== 'object') return null;
  if (!finiteNum(pos.x) || !finiteNum(pos.z)) return null;
  const npc: NpcDef = {
    id,
    name: str(n.name, 'Villager').slice(0, MAX_NAME_LENGTH),
    title: str(n.title, '').slice(0, MAX_NAME_LENGTH),
    pos: { x: coord(pos.x), z: coord(pos.z) },
    facing: num(n.facing, 0),
    color: Math.floor(clamp(num(n.color, 0xffffff), 0, 0xffffff)),
    questIds: strArray(n.questIds),
    greeting: str(n.greeting, '').slice(0, MAX_DESCRIPTION_LENGTH),
  };
  if (Array.isArray(n.vendorItems)) npc.vendorItems = strArray(n.vendorItems);
  if (n.market === true) npc.market = true;
  if (n.dynamic === true) npc.dynamic = true;
  return npc;
}

// Each position spawns one ground-object entity, so the list is bounded and
// every point must be a finite, in-bounds coordinate.
function sanitizeGroundObject(v: unknown): GroundObjectDef | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const itemId = idStr(o.itemId);
  if (!itemId) return null;
  const positions: { x: number; z: number }[] = [];
  for (const p of arr(o.positions).slice(0, MAX_OBJECT_POSITIONS)) {
    const pt = p as Record<string, unknown> | null;
    if (pt && typeof pt === 'object' && finiteNum(pt.x) && finiteNum(pt.z)) {
      positions.push({ x: coord(pt.x), z: coord(pt.z) });
    }
  }
  return { itemId, name: str(o.name, '').slice(0, MAX_NAME_LENGTH), positions };
}

// A zone must at least have a finite z-band and a hub to shape terrain.
function zoneIsUsable(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const z = v as Record<string, unknown>;
  const hub = z.hub as Record<string, unknown> | undefined;
  return finiteNum(z.zMin) && finiteNum(z.zMax) && !!hub && finiteNum(hub.x) && finiteNum(hub.z);
}

// Def-fill the nested zone sub-fields the terrain function and the editor
// model iterate (lakes/pois arrays, hub radius/name, a valid biome), keeping
// the never-throws contract: a minimal-but-usable zone loads instead of
// crashing a viewer's editor tab. Mutates the zone object in place (it was
// freshly JSON.parsed; nothing else holds a reference).
function fillZoneDefaults(v: unknown): ZoneDef {
  const z = v as Record<string, unknown>;
  if (typeof z.id !== 'string') z.id = 'zone';
  if (typeof z.name !== 'string') z.name = 'Zone';
  // The z-band drives the decoration generator's loop bounds and the world
  // extents: clamp its magnitude or a stored map can make a viewer's tab
  // iterate an effectively unbounded grid.
  z.zMin = coord(z.zMin as number);
  z.zMax = coord(z.zMax as number);
  // Lakes and POIs feed the terrain function and the editor overlay directly:
  // drop any entry whose numbers are not finite, clamp the survivors, and cap
  // the counts (lakes multiply per-vertex terrain cost).
  z.lakes = arr(z.lakes)
    .filter((l) => {
      const lake = l as Record<string, unknown> | null;
      return (
        !!lake &&
        typeof lake === 'object' &&
        finiteNum(lake.x) &&
        finiteNum(lake.z) &&
        finiteNum(lake.radius)
      );
    })
    .slice(0, MAX_ZONE_LAKES)
    .map((l) => {
      const lake = l as Record<string, unknown>;
      lake.x = coord(lake.x as number);
      lake.z = coord(lake.z as number);
      lake.radius = clamp(lake.radius as number, 0.5, 200);
      return lake;
    });
  z.pois = arr(z.pois)
    .filter((p) => {
      const poi = p as Record<string, unknown> | null;
      return !!poi && typeof poi === 'object' && finiteNum(poi.x) && finiteNum(poi.z);
    })
    .slice(0, MAX_ZONE_POIS)
    .map((p) => {
      const poi = p as Record<string, unknown>;
      poi.x = coord(poi.x as number);
      poi.z = coord(poi.z as number);
      return poi;
    });
  if (typeof z.welcome !== 'string') z.welcome = '';
  if (typeof z.biome !== 'string' || !BIOME_BY_ID.includes(z.biome as ZoneDef['biome'])) {
    z.biome = 'vale';
  }
  const lr = z.levelRange as unknown[] | undefined;
  if (!Array.isArray(lr) || !finiteNum(lr[0]) || !finiteNum(lr[1])) z.levelRange = [1, 10];
  else z.levelRange = [clamp(Math.floor(lr[0]), 1, 60), clamp(Math.floor(lr[1]), 1, 60)];
  const hub = z.hub as Record<string, unknown>;
  hub.x = coord(hub.x as number);
  hub.z = coord(hub.z as number);
  if (!finiteNum(hub.radius)) hub.radius = 20;
  else hub.radius = clamp(hub.radius, 1, 200);
  if (typeof hub.name !== 'string') hub.name = '';
  const gy = z.graveyard as Record<string, unknown> | undefined;
  if (!gy || !finiteNum(gy.x) || !finiteNum(gy.z)) {
    z.graveyard = { x: hub.x, z: hub.z };
  } else {
    gy.x = coord(gy.x as number);
    gy.z = coord(gy.z as number);
  }
  return z as unknown as ZoneDef;
}

function sanitizeRoads(v: unknown): { x: number; z: number }[][] {
  const roads: { x: number; z: number }[][] = [];
  for (const road of arr(v).slice(0, MAX_ROADS)) {
    if (!Array.isArray(road)) continue;
    const pts: { x: number; z: number }[] = [];
    for (const p of road.slice(0, MAX_ROAD_POINTS)) {
      const pt = p as Record<string, unknown> | null;
      if (pt && finiteNum(pt.x) && finiteNum(pt.z)) {
        pts.push({ x: pt.x, z: pt.z });
      }
    }
    if (pts.length >= 2) roads.push(pts);
  }
  return roads;
}

// Parse anything (JSON string or already-parsed object, trusted or not) into a
// MapDoc, or null if it cannot be salvaged (no usable zones). Server routes and
// the editor's import path both call THIS; there is no other validation layer.
export function sanitizeMapDoc(raw: unknown): MapDoc | null {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const content = (o.content && typeof o.content === 'object' ? o.content : {}) as Record<
    string,
    unknown
  >;
  const zones = arr(content.zones).filter(zoneIsUsable).slice(0, MAX_ZONES).map(fillZoneDefaults);
  if (zones.length === 0) return null; // nothing to render/play
  const npcsRaw = content.npcs && typeof content.npcs === 'object' ? (content.npcs as object) : {};
  const npcs: Record<string, NpcDef> = {};
  for (const [key, value] of Object.entries(npcsRaw).slice(0, MAX_NPCS)) {
    const npc = sanitizeNpc(value);
    if (npc) npcs[key.slice(0, MAX_ID_LENGTH)] = npc;
  }
  const doc: MapDoc = {
    // The sanitizer always produces v2 semantics, so the stored version is
    // always 2 (never a client-supplied value round-tripped verbatim).
    version: MAP_DOC_VERSION,
    meta: sanitizeMeta(o.meta),
    content: {
      // Zones keep their full shape beyond the load-bearing fields gated
      // above; camps/npcs/objects are rebuilt field by field (the Sim spawn
      // loop trusts every number in them).
      zones,
      camps: arr(content.camps)
        .slice(0, MAX_CAMPS)
        .map(sanitizeCamp)
        .filter((c): c is CampDef => c !== null),
      npcs,
      objects: arr(content.objects)
        .slice(0, MAX_OBJECTS)
        .map(sanitizeGroundObject)
        .filter((g): g is GroundObjectDef => g !== null),
      roads: sanitizeRoads(content.roads),
    },
    terrainEdits: arr(o.terrainEdits)
      .slice(0, MAX_TERRAIN_EDITS)
      .map(sanitizeStamp)
      .filter((s): s is HeightStamp => s !== null),
    placements: arr(o.placements)
      .slice(0, MAX_PLACEMENTS)
      .map(sanitizePlacement)
      .filter((p): p is MapPlacement => p !== null),
    biomePaint: sanitizeBiomePaint(o.biomePaint),
  };
  const blockers = arr(o.blockers)
    .slice(0, MAX_BLOCKERS)
    .map(sanitizeBlocker)
    .filter((b): b is BlockerDef => b !== null);
  if (blockers.length > 0) doc.blockers = blockers;
  if (finiteNum(o.waterLevel)) {
    doc.waterLevel = clamp(o.waterLevel, MIN_WATER_LEVEL, MAX_WATER_LEVEL);
  }
  if (finiteNum(o.worldHalfX)) {
    doc.worldHalfX = clamp(o.worldHalfX, 20, MAX_WORLD_COORD);
  }
  const ps = o.playerStart as Record<string, unknown> | undefined;
  if (ps && typeof ps === 'object' && finiteNum(ps.x) && finiteNum(ps.z)) {
    doc.playerStart = { x: ps.x, z: ps.z };
  }
  if (o.propsMode === 'empty') doc.propsMode = 'empty';
  if (o.decorationsMode === 'empty') doc.decorationsMode = 'empty';
  if (o.presentationMode === 'blank') doc.presentationMode = 'blank';
  // Skybox token: 'builtin:<id>' or 'custom:<sha256>' (bounded; resolution
  // and fallback live render-side).
  if (
    typeof o.skybox === 'string' &&
    o.skybox.length <= 80 &&
    (o.skybox.startsWith('builtin:') || o.skybox.startsWith('custom:'))
  ) {
    doc.skybox = o.skybox;
  }
  const locations = arr(o.locations)
    .slice(0, MAX_LOCATIONS)
    .map((v): MapLocation | null => {
      const l = v as Record<string, unknown>;
      if (!l || typeof l !== 'object' || typeof l.name !== 'string') return null;
      if (!finiteNum(l.minX) || !finiteNum(l.minZ) || !finiteNum(l.maxX) || !finiteNum(l.maxZ)) {
        return null;
      }
      const name = l.name.trim().slice(0, MAX_LOCATION_NAME);
      if (!name) return null;
      return {
        name,
        minX: Math.min(l.minX, l.maxX),
        minZ: Math.min(l.minZ, l.maxZ),
        maxX: Math.max(l.minX, l.maxX),
        maxZ: Math.max(l.minZ, l.maxZ),
      };
    })
    .filter((l): l is MapLocation => l !== null);
  if (locations.length > 0) doc.locations = locations;
  const markers = arr(o.markers)
    .slice(0, MAX_MARKERS)
    .map((v): MapMarker | null => {
      const m = v as Record<string, unknown>;
      if (!m || typeof m !== 'object' || typeof m.name !== 'string') return null;
      if (!finiteNum(m.x) || !finiteNum(m.z)) return null;
      const name = m.name.trim().slice(0, MAX_LOCATION_NAME);
      if (!name) return null;
      return { name, kind: m.kind === 'object' ? 'object' : 'npc', x: m.x, z: m.z };
    })
    .filter((m): m is MapMarker => m !== null);
  if (markers.length > 0) doc.markers = markers;
  const lights = arr(o.lights)
    .slice(0, MAX_LIGHTS)
    .map((v): MapLight | null => {
      const l = v as Record<string, unknown>;
      if (!l || typeof l !== 'object') return null;
      if (!finiteNum(l.x) || !finiteNum(l.z)) return null;
      return {
        x: l.x,
        z: l.z,
        y: finiteNum(l.y) ? clamp(l.y, 0, 60) : 2,
        color: finiteNum(l.color) ? Math.round(clamp(l.color, 0, 0xffffff)) : 0xffb46a,
        intensity: finiteNum(l.intensity) ? clamp(l.intensity, 0.1, 30) : 6,
        range: finiteNum(l.range) ? clamp(l.range, 2, 120) : 32,
      };
    })
    .filter((l): l is MapLight => l !== null);
  if (lights.length > 0) doc.lights = lights;
  const style = sanitizeTerrainStyle(o.terrainStyle);
  if (style) doc.terrainStyle = style;
  if (finiteNum(o.timeScale)) {
    const ts = clamp(o.timeScale, MIN_TIME_SCALE, MAX_TIME_SCALE);
    if (ts !== 1) doc.timeScale = ts;
  }
  if (finiteNum(o.assetViewDistance)) {
    const d = clamp(o.assetViewDistance, MIN_ASSET_VIEW_DISTANCE, MAX_ASSET_VIEW_DISTANCE);
    if (d !== DEFAULT_ASSET_VIEW_DISTANCE) doc.assetViewDistance = d;
  }
  const weather = sanitizeWeather(o.weather);
  if (weather) doc.weather = weather;
  const music = sanitizeMusic(o.music);
  if (music) doc.music = music;
  return doc;
}

export const MAX_MUSIC_AREAS = 24;
const MAX_TRACK_ID_LENGTH = 40;

// Track ids are validated for SHAPE only (sim code cannot import the game's
// track list); the client ignores unknown ids at play time.
function sanitizeMusic(v: unknown): MapMusic | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const m = v as Record<string, unknown>;
  const out: MapMusic = {};
  if (typeof m.zoneTrack === 'string' && m.zoneTrack.length > 0) {
    out.zoneTrack = m.zoneTrack.slice(0, MAX_TRACK_ID_LENGTH);
  }
  if (Array.isArray(m.areas)) {
    const areas = m.areas
      .slice(0, MAX_MUSIC_AREAS)
      .map((raw): NonNullable<MapMusic['areas']>[number] | null => {
        if (!raw || typeof raw !== 'object') return null;
        const a = raw as Record<string, unknown>;
        if (
          !finiteNum(a.minX) ||
          !finiteNum(a.minZ) ||
          !finiteNum(a.maxX) ||
          !finiteNum(a.maxZ) ||
          typeof a.track !== 'string' ||
          a.track.length === 0
        ) {
          return null;
        }
        const minX = Math.min(a.minX, a.maxX);
        const maxX = Math.max(a.minX, a.maxX);
        const minZ = Math.min(a.minZ, a.maxZ);
        const maxZ = Math.max(a.minZ, a.maxZ);
        if (maxX - minX < 1 || maxZ - minZ < 1) return null;
        return { minX, minZ, maxX, maxZ, track: a.track.slice(0, MAX_TRACK_ID_LENGTH) };
      })
      .filter((a): a is NonNullable<MapMusic['areas']>[number] => a !== null);
    if (areas.length > 0) out.areas = areas;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const WEATHER_MODES = new Set(['auto', 'clear', 'rain', 'snow', 'sparkle']);
export const MAX_WEATHER_SCHEDULE = 12;

function sanitizeWeather(v: unknown): MapWeather | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const w = v as Record<string, unknown>;
  const out: MapWeather = {};
  if (typeof w.mode === 'string' && WEATHER_MODES.has(w.mode) && w.mode !== 'auto') {
    out.mode = w.mode as MapWeather['mode'];
  }
  if (finiteNum(w.intensity) && w.intensity !== 1) out.intensity = clamp(w.intensity, 0, 1);
  const clouds = w.clouds as Record<string, unknown> | undefined;
  if (clouds && typeof clouds === 'object' && finiteNum(clouds.coverage) && clouds.coverage > 0) {
    out.clouds = {
      coverage: clamp(clouds.coverage, 0, 1),
      height: finiteNum(clouds.height) ? clamp(clouds.height, 0, 200) : 60,
    };
  }
  if (Array.isArray(w.schedule)) {
    const steps = w.schedule
      .slice(0, MAX_WEATHER_SCHEDULE)
      .map((raw): { mode: 'clear' | 'rain' | 'snow' | 'sparkle'; minutes: number } | null => {
        if (!raw || typeof raw !== 'object') return null;
        const s = raw as Record<string, unknown>;
        if (typeof s.mode !== 'string' || !WEATHER_MODES.has(s.mode) || s.mode === 'auto') {
          return null;
        }
        return {
          mode: s.mode as 'clear' | 'rain' | 'snow' | 'sparkle',
          minutes: finiteNum(s.minutes) ? clamp(s.minutes, 0.1, 120) : 5,
        };
      })
      .filter((s): s is { mode: 'clear' | 'rain' | 'snow' | 'sparkle'; minutes: number } => {
        return s !== null;
      });
    if (steps.length > 0) out.schedule = steps;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Keep only explicit FALSE flags (absent = rule on), so a default document
// round-trips without the field at all.
function sanitizeTerrainStyle(v: unknown): TerrainStyle | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const s = v as Record<string, unknown>;
  const out: TerrainStyle = {};
  if (s.slopeRock === false) out.slopeRock = false;
  if (s.snowCaps === false) out.snowCaps = false;
  if (s.rimMountains === false) out.rimMountains = false;
  if (s.shoreSand === false) out.shoreSand = false;
  return Object.keys(out).length > 0 ? out : undefined;
}
