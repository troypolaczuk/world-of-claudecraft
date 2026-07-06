// The CustomMap document: the editor's canonical, serializable map. The type and
// its sanitizer live in src/sim/map_doc.ts (shared with the server, which
// validates uploaded documents with the SAME code); this module adapts the
// document to the editor's live editing model and projects it onto the engine's
// WorldContent for play-test. Pure: no DOM, Vitest-importable.

import { colliderVolumesFromPlacements } from '../sim/collider_volumes';
import { BUILTIN_WORLD, PLAYER_START, WORLD_MAX_X, WORLD_MAX_Z, WORLD_MIN_Z } from '../sim/data';
import {
  collideRadiusFor,
  GRASS_PATCH_ASSET_ID,
  GRASS_PATCH_PATH,
  MAP_DOC_VERSION,
  MAX_BLOCKER_LENGTH,
  MAX_BLOCKERS,
  type MapDoc,
  type MapDocMeta,
  type MapPlacement,
  WATERFALL_ASSET_ID,
  WATERFALL_PATH,
} from '../sim/map_doc';
import { emptyZoneProps, type PlacedAsset, type WorldContent } from '../sim/types';
import { WATER_LEVEL } from '../sim/world';
import { assetById } from './asset_catalog.generated';
import { isLocalAssetId, localAssetUrl } from './local_assets';
import type { ZoneContent } from './model';
import { userAssetPath } from './user_assets';

export const CUSTOM_MAP_VERSION = MAP_DOC_VERSION;

// Editor-facing aliases: the document shape IS the shared MapDoc.
export type AssetPlacement = MapPlacement;
export type CustomMapMeta = MapDocMeta;
// The editor's in-memory document shares the LIVE ZoneContent ref with the
// marker model (readonly views of the same tables), so content stays readonly
// here; serialization casts back to the mutable MapDoc shape.
export type CustomMap = Omit<MapDoc, 'content'> & { content: ZoneContent };

// The game's fixed offline seed; a fresh map defaults to it so its built-in
// derived terrain matches what the editor previews (mirrors DEFAULT_PLAYTEST_SEED).
const DEFAULT_SEED = 20061;
const FLAT_STAMPS = [
  { x: -WORLD_MAX_X / 2, z: 60, radius: 200, delta: 0, falloff: 'flat', mode: 'level' },
  { x: WORLD_MAX_X / 2, z: 60, radius: 200, delta: 0, falloff: 'flat', mode: 'level' },
  { x: -WORLD_MAX_X / 2, z: 260, radius: 200, delta: 0, falloff: 'flat', mode: 'level' },
  { x: WORLD_MAX_X / 2, z: 260, radius: 200, delta: 0, falloff: 'flat', mode: 'level' },
] satisfies CustomMap['terrainEdits'];

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// A new map seeded from the built-in world content (so it is immediately playable
// and editable). `now` and `id` are injected (no Date.now/Math.random in callers
// that want determinism; the DOM app passes real values).
export function newCustomMap(name: string, id: string, now: number): CustomMap {
  return {
    version: CUSTOM_MAP_VERSION,
    meta: {
      id,
      name,
      description: '',
      createdAt: now,
      updatedAt: now,
      seed: DEFAULT_SEED,
      parentId: '',
    },
    content: {
      zones: deepClone(BUILTIN_WORLD.zones as CustomMap['content']['zones']),
      camps: deepClone(BUILTIN_WORLD.camps as CustomMap['content']['camps']),
      npcs: deepClone(BUILTIN_WORLD.npcs as CustomMap['content']['npcs']),
      objects: deepClone(BUILTIN_WORLD.groundObjects as CustomMap['content']['objects']),
      roads: deepClone(BUILTIN_WORLD.roads as CustomMap['content']['roads']),
    },
    terrainEdits: [],
    placements: [],
  };
}

/** Requested dimensions for a sized blank map (yards). */
export interface NewMapSize {
  width: number;
  height: number;
}

export const NEW_MAP_MIN_SIDE = 40;
export const NEW_MAP_MAX_SIDE = 2000;

/**
 * The level-to-zero stamp grid that keeps a sized blank map flat: 'level' +
 * 'flat' stamps set the heightfield to 0 across their disc, so a grid of them
 * (spacing under radius*sqrt(2)) covers the whole play rect. Bounded well
 * under MAX_TERRAIN_EDITS even at the maximum size (2000yd -> 81 stamps).
 */
function flatStampGrid(halfW: number, halfH: number): CustomMap['terrainEdits'] {
  const radius = 200;
  const step = 260;
  const out: CustomMap['terrainEdits'] = [];
  const cols = Math.max(1, Math.ceil((halfW * 2) / step));
  const rows = Math.max(1, Math.ceil((halfH * 2) / step));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push({
        x: -halfW + ((c + 0.5) * (halfW * 2)) / cols,
        z: -halfH + ((r + 0.5) * (halfH * 2)) / rows,
        radius,
        delta: 0,
        falloff: 'flat',
        mode: 'level',
      });
    }
  }
  return out;
}

/** Split one boundary edge into blocker segments no longer than the cap. */
function boundaryEdge(
  out: NonNullable<CustomMap['blockers']>,
  x1: number,
  z1: number,
  x2: number,
  z2: number,
): void {
  const len = Math.hypot(x2 - x1, z2 - z1);
  const parts = Math.max(1, Math.ceil(len / MAX_BLOCKER_LENGTH));
  for (let i = 0; i < parts; i++) {
    out.push({
      x1: x1 + ((x2 - x1) * i) / parts,
      z1: z1 + ((z2 - z1) * i) / parts,
      x2: x1 + ((x2 - x1) * (i + 1)) / parts,
      z2: z1 + ((z2 - z1) * (i + 1)) / parts,
    });
  }
}

/** Invisible perimeter walls at the exact map bounds, split into segments no
 *  longer than the blocker cap, so a small map is genuinely small in playtest. */
function perimeterBlockers(halfW: number, halfH: number): CustomMap['blockers'] {
  const out: NonNullable<CustomMap['blockers']> = [];
  boundaryEdge(out, -halfW, -halfH, halfW, -halfH);
  boundaryEdge(out, halfW, -halfH, halfW, halfH);
  boundaryEdge(out, halfW, halfH, -halfW, halfH);
  boundaryEdge(out, -halfW, halfH, -halfW, -halfH);
  return out.slice(0, MAX_BLOCKERS);
}

/** The map's playable rect: worldHalfX wide, the zone band tall. */
export function mapBounds(map: CustomMap): {
  halfW: number;
  zMin: number;
  zMax: number;
} {
  const halfW = map.worldHalfX ?? WORLD_MAX_X;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const z of map.content.zones) {
    zMin = Math.min(zMin, z.zMin);
    zMax = Math.max(zMax, z.zMax);
  }
  if (!Number.isFinite(zMin) || !Number.isFinite(zMax)) {
    zMin = WORLD_MIN_Z;
    zMax = WORLD_MAX_Z;
  }
  return { halfW, zMin, zMax };
}

/** True when a blocker runs along the given axis-aligned boundary line. */
function blockerOnLine(
  b: { x1: number; z1: number; x2: number; z2: number },
  axis: 'x' | 'z',
  v: number,
): boolean {
  const eps = 0.5;
  return axis === 'x'
    ? Math.abs(b.x1 - v) < eps && Math.abs(b.x2 - v) < eps
    : Math.abs(b.z1 - v) < eps && Math.abs(b.z2 - v) < eps;
}

/**
 * Perimeter walls for the play-test projection: EVERY custom map gets a hard,
 * unjumpable boundary at its world rect (blocker collision is height-agnostic
 * in the sim, so nothing clears it). Edges the document already walls off
 * (sized flat maps store their own perimeter) are skipped.
 */
export function boundaryBlockers(map: CustomMap): NonNullable<CustomMap['blockers']> {
  const { halfW, zMin, zMax } = mapBounds(map);
  const existing = map.blockers ?? [];
  const out: NonNullable<CustomMap['blockers']> = [];
  if (!existing.some((b) => blockerOnLine(b, 'z', zMin))) {
    boundaryEdge(out, -halfW, zMin, halfW, zMin);
  }
  if (!existing.some((b) => blockerOnLine(b, 'x', halfW))) {
    boundaryEdge(out, halfW, zMin, halfW, zMax);
  }
  if (!existing.some((b) => blockerOnLine(b, 'z', zMax))) {
    boundaryEdge(out, halfW, zMax, -halfW, zMax);
  }
  if (!existing.some((b) => blockerOnLine(b, 'x', -halfW))) {
    boundaryEdge(out, -halfW, zMax, -halfW, zMin);
  }
  return out;
}

/**
 * A blank flat authoring map. With `size`, the world is bounded to the chosen
 * rect: the zone band carries the z extent, worldHalfX the x extent (terrain
 * rim walls + decoration bounds), the stamp grid flattens the interior, and
 * perimeter blockers make the bounds collide. Without `size`, the legacy
 * world-sized flat map (unchanged) for older call sites.
 */
export function newFlatCustomMap(
  name: string,
  id: string,
  now: number,
  size?: NewMapSize,
): CustomMap {
  const clampSide = (v: number): number =>
    Math.min(NEW_MAP_MAX_SIDE, Math.max(NEW_MAP_MIN_SIDE, v));
  const halfW = size ? clampSide(size.width) / 2 : WORLD_MAX_X;
  const halfH = size ? clampSide(size.height) / 2 : 0; // legacy path ignores this
  const zMin = size ? -halfH : WORLD_MIN_Z;
  const zMax = size ? halfH : WORLD_MAX_Z;
  const map: CustomMap = {
    version: CUSTOM_MAP_VERSION,
    meta: {
      id,
      name,
      description: '',
      createdAt: now,
      updatedAt: now,
      seed: DEFAULT_SEED,
      parentId: '',
    },
    content: {
      zones: [
        {
          id: 'blank_world',
          // Deliberately UNNAMED: a blank map shows no location name in
          // playtest until the maker authors locations with the Zone tool.
          name: '',
          zMin,
          zMax,
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
    terrainEdits: size ? flatStampGrid(halfW, halfH) : deepClone(FLAT_STAMPS),
    placements: [],
    waterLevel: -40,
    playerStart: { x: 0, z: 0 },
    propsMode: 'empty',
    decorationsMode: 'empty',
    presentationMode: 'blank',
    // A blank map starts with every automatic-texturing rule OFF: makers paint
    // and sculpt on a clean slate, so nothing repaints their cliffs or shores
    // until they opt in from the Biome tab's Auto textures section.
    terrainStyle: { slopeRock: false, snowCaps: false, rimMountains: false, shoreSand: false },
  };
  if (size) {
    map.worldHalfX = halfW;
    map.blockers = perimeterBlockers(halfW, halfH);
  }
  return map;
}

// Build a CustomMap from a live ZoneContent (the editor's current edits) plus the
// authoring layers. Deep-cloned so the document is independent of further edits.
export function customMapFromContent(
  content: ZoneContent,
  layers: {
    terrainEdits?: CustomMap['terrainEdits'];
    placements?: AssetPlacement[];
    blockers?: CustomMap['blockers'];
    meta: CustomMapMeta;
    waterLevel?: number;
    playerStart?: { x: number; z: number };
  },
): CustomMap {
  const map: CustomMap = {
    version: CUSTOM_MAP_VERSION,
    meta: { ...layers.meta },
    content: {
      zones: deepClone(content.zones as CustomMap['content']['zones']),
      camps: deepClone(content.camps as CustomMap['content']['camps']),
      npcs: deepClone(content.npcs as CustomMap['content']['npcs']),
      objects: deepClone(content.objects as CustomMap['content']['objects']),
      roads: deepClone((content.roads ?? []) as CustomMap['content']['roads']),
    },
    terrainEdits: deepClone(layers.terrainEdits ?? []),
    placements: deepClone(layers.placements ?? []),
  };
  if (layers.blockers && layers.blockers.length > 0) map.blockers = deepClone(layers.blockers);
  if (layers.waterLevel !== undefined && layers.waterLevel !== WATER_LEVEL) {
    map.waterLevel = layers.waterLevel;
  }
  if (layers.playerStart) map.playerStart = { ...layers.playerStart };
  return map;
}

// Project a CustomMap onto the engine's WorldContent for play-testing. Props
// come from the built-in world (the editor does not author them yet); free
// placements carry their collide footprint so the Sim's colliders and the
// renderer read the SAME records.
export function customMapToWorldContent(map: CustomMap): WorldContent {
  const start = map.playerStart ?? PLAYER_START;
  const world: WorldContent = {
    zones: deepClone(map.content.zones as WorldContent['zones']),
    camps: deepClone(map.content.camps as WorldContent['camps']),
    npcs: deepClone(map.content.npcs as WorldContent['npcs']),
    groundObjects: deepClone(map.content.objects as WorldContent['groundObjects']),
    roads: deepClone((map.content.roads ?? BUILTIN_WORLD.roads) as WorldContent['roads']),
    props: map.propsMode === 'empty' ? emptyZoneProps() : deepClone(BUILTIN_WORLD.props),
    playerStart: { x: start.x, z: start.z },
    terrainEdits: deepClone(map.terrainEdits),
    placements: placementsToPlayAssets(map.placements),
    biomePaint: map.biomePaint ? deepClone(map.biomePaint) : undefined,
  };
  if (map.blockers && map.blockers.length > 0) world.blockers = deepClone(map.blockers);
  // The map limits are ALWAYS a hard boundary in playtest: wall off any edge
  // of the world rect the document does not already cover. Projection-only:
  // these never enter the stored document.
  const boundary = boundaryBlockers(map);
  if (boundary.length > 0) world.blockers = [...(world.blockers ?? []), ...boundary];
  // Collider-volume placements (assetId 'collider/<kind>') resolve to no model
  // (invisible in playtest) but DO block: project them into sim volumes here.
  const colliderVolumes = colliderVolumesFromPlacements(map.placements);
  if (colliderVolumes.length > 0) world.colliderVolumes = colliderVolumes;
  if (map.waterLevel !== undefined) world.waterLevel = map.waterLevel;
  if (map.worldHalfX !== undefined) world.worldHalfX = map.worldHalfX;
  if (map.decorationsMode === 'empty') world.decorationsMode = 'empty';
  if (map.presentationMode === 'blank') world.presentationMode = 'blank';
  if (map.skybox !== undefined) world.skybox = map.skybox;
  if (map.terrainStyle) world.terrainStyle = { ...map.terrainStyle };
  if (map.timeScale !== undefined) world.timeScale = map.timeScale;
  if (map.assetViewDistance !== undefined) world.assetViewDistance = map.assetViewDistance;
  if (map.weather) world.weather = deepClone(map.weather);
  if (map.music) world.music = deepClone(map.music);
  if (map.locations && map.locations.length > 0) world.locations = deepClone(map.locations);
  if (map.lights && map.lights.length > 0) world.lights = deepClone(map.lights);
  // map.markers are deliberately NOT projected: they are editor/AI notes only.
  return world;
}

// The collision radius a colliding placement actually gets: the per-placement
// override when authored, else the scale- and family-derived default. The ONE
// resolution used by both the render footprint and the playtest colliders.
export function effectiveCollideRadius(
  p: Pick<MapPlacement, 'assetId' | 'scale' | 'collideRadius'>,
): number {
  return p.collideRadius ?? collideRadiusFor(p.scale, p.assetId);
}

// Resolve editor placements (catalogue id, or an uploaded 'user/<sha256>' id)
// into render-ready PlacedAssets (GLB path). INDEX-ALIGNED with the document:
// slot i always describes placement i, and a placement with an unknown id
// becomes a null hole instead of being dropped, so the 3D view (which keys
// meshes by DOCUMENT index) never drifts one slot after an unresolvable id.
// Colliding placements get their authored collideRadius override, else the
// scale-proportional default (see effectiveCollideRadius above).
export function placementsToRenderAssets(
  placements: readonly AssetPlacement[],
  opts?: { keepLocalIds?: boolean; hideHidden?: boolean },
): (PlacedAsset | null)[] {
  return placements.map((p) => {
    // Editor-only Scene Collection hide: a null slot renders nothing but keeps
    // the index aligned. Playtest/export never passes hideHidden, so a hidden
    // object still exists in the game — it is only skipped in the editor view.
    if (opts?.hideHidden && p.hidden) return null;
    // keepLocalIds: playtest hand-off keeps the logical 'local/<sha256>' id.
    // The editor's object URLs die when the page navigates to the game, so the
    // game re-resolves the id against the shared IndexedDB store on boot
    // (game/editor_playtest.ts) instead of receiving a dead blob: URL.
    const path =
      p.assetId === GRASS_PATCH_ASSET_ID
        ? GRASS_PATCH_PATH
        : p.assetId === WATERFALL_ASSET_ID
          ? WATERFALL_PATH
          : opts?.keepLocalIds && isLocalAssetId(p.assetId)
            ? p.assetId
            : (localAssetUrl(p.assetId) ?? userAssetPath(p.assetId) ?? assetById(p.assetId)?.path);
    if (!path) return null;
    const placed: PlacedAsset = { path, x: p.x, z: p.z, rotY: p.rotY, scale: p.scale };
    if (p.hue !== undefined) placed.hue = p.hue;
    if (p.lum !== undefined) placed.lum = p.lum;
    if (p.clump !== undefined) placed.clump = p.clump;
    if (p.tint !== undefined) placed.tint = p.tint;
    if (p.opacity !== undefined) placed.opacity = p.opacity;
    if (p.glow !== undefined) placed.glow = p.glow;
    if (p.glowStrength !== undefined) placed.glowStrength = p.glowStrength;
    if (p.fire === true) placed.fire = true;
    if (p.collide) {
      placed.collideRadius = effectiveCollideRadius(p);
      if (p.collideShape === 'square') placed.collideShape = 'square';
    }
    // Gizmo transform axes (visual): carried through so tilts, per-axis scale,
    // and the vertical offset render identically in the editor and playtest.
    if (p.rotX !== undefined) placed.rotX = p.rotX;
    if (p.rotZ !== undefined) placed.rotZ = p.rotZ;
    if (p.scaleX !== undefined) placed.scaleX = p.scaleX;
    if (p.scaleY !== undefined) placed.scaleY = p.scaleY;
    if (p.scaleZ !== undefined) placed.scaleZ = p.scaleZ;
    if (p.y !== undefined) placed.y = p.y;
    if (p.detached) {
      placed.detached = true;
      if (p.groundY !== undefined) placed.groundY = p.groundY;
    }
    return placed;
  });
}

// The compact (hole-free) resolution, for consumers that do not key by document
// index: the play-test WorldContent (sim colliders + the game renderer's
// constructor build) only needs the resolvable placements.
export function placementsToPlayAssets(placements: readonly AssetPlacement[]): PlacedAsset[] {
  return placementsToRenderAssets(placements, { keepLocalIds: true }).filter(
    (a): a is PlacedAsset => a !== null,
  );
}
