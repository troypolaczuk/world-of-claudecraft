// Renderer for the map editor's freely placed GLB assets (WorldContent.placements).
// Cosmetic and play-test-only: each placement names a public GLB path; we load it
// once, clone it per placement, normalize its size, and seat it on the terrain.
// Loads are async (the initial batch is registered as preloads); models pop in
// when ready, which is fine because placements never affect gameplay.
//
// The view is a small live instancer keyed by the editor's DOCUMENT placement
// index (an unresolvable id leaves its slot empty rather than shifting later
// ones): addPlacement / updatePlacement / removePlacement mutate one entry,
// removePlacementAt additionally reindexes the survivors after a single doc
// removal, reSeat(region?) re-samples the ground after a sculpt (region-scoped
// at stroke end, everything on load/undo), setSelected() drapes a gold ring
// under one asset, and showFootprints() drapes the collideRadius circle under
// every colliding placement. Everything editor-facing is opt-in; the shipped
// game only ever runs the constructor build.

import * as THREE from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { GRASS_PATCH_PATH, WATERFALL_PATH } from '../sim/map_doc';
import type { PlacedAsset } from '../sim/types';
import { terrainHeight } from '../sim/world';
import { loadGltf } from './assets/loader';
import { registerPreload } from './assets/preload';
import {
  buildGrassPatchModel,
  DEFAULT_TUFTS_PER_PATCH,
  grassPatchRadius,
  grassPatchSeed,
} from './grass_patch';
import { buildWaterfallModel } from './waterfall';

// Height (yards) a placed model is normalized to before its per-placement scale,
// so arbitrary catalogue GLBs (which vary wildly in source units) land sanely.
const TARGET_HEIGHT = 2.2;
const RING_SEGMENTS = 40;
const RING_LIFT = 0.08; // yards above the sampled ground, against z-fighting
const SELECTION_COLOR = 0xd4af37; // the classic target-reticle gold
const FOOTPRINT_COLOR = 0xe0503c;
// Extra yards around a sculpt region whose placements still get re-seated: the
// brush falloff softens past its nominal bounds, so seat a small margin too.
const RESEAT_MARGIN = 2;
// GLB emissive channels usually author intensity 1, which lands under the
// bloom threshold (0.85 post-ACES) and reads flat; lift weak ones once per
// template so "glowy" materials actually glow, editor and playtest alike.
const MIN_NATIVE_EMISSIVE_INTENSITY = 2.2;
// Distance culling (the base game's foliage/props hide by distance; placed
// assets get the same treatment so thousands of decor placements stay cheap).
// Placements cull with the terrain, at the fog/draw distance measured from the
// camera (see updateLod), so nothing renders past where the ground has fogged
// out. Grass is the one class that culls SOONER than the fog: it is dense and
// cheap to lose, so it hides within this range to save draw calls.
const LOD_RANGE_GRASS = 130;
const LOD_HYSTERESIS = 1.12; // re-show at range, re-hide at range * this
// Fraction of the range over which a placement fades from fully opaque to
// invisible before it is culled (base-game foliage fades near its far edge
// instead of popping). Only the thin shell of placements currently inside this
// band pays the transparency cost; nearer ones stay opaque, farther ones hide.
const LOD_FADE_BAND = 0.3;
// Opacity deltas under this are not worth re-touching the materials for.
const LOD_FADE_EPSILON = 0.02;
// Spread the distance checks: at most this many entries re-test per frame.
const LOD_BUDGET_PER_FRAME = 400;

/** World-space XZ bounds of a terrain edit (the sculpt stroke region). */
export interface SeatRegion {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** Whether a placement anchored at (x, z) needs re-seating after a sculpt over `region`. */
export function needsReSeat(
  x: number,
  z: number,
  region: SeatRegion,
  margin = RESEAT_MARGIN,
): boolean {
  return (
    x >= region.minX - margin &&
    x <= region.maxX + margin &&
    z >= region.minZ - margin &&
    z <= region.maxZ + margin
  );
}

/** Grow a running union of edit regions (null accumulator starts the union). */
export function unionRegion(acc: SeatRegion | null, region: SeatRegion): SeatRegion {
  if (!acc) return { ...region };
  return {
    minX: Math.min(acc.minX, region.minX),
    minZ: Math.min(acc.minZ, region.minZ),
    maxX: Math.max(acc.maxX, region.maxX),
    maxZ: Math.max(acc.maxZ, region.maxZ),
  };
}

/**
 * After removing document index `removed` (the key itself must already be
 * deleted), shift every Map key above it down by one so view slots stay in
 * lockstep with document indices. Pure bookkeeping; exported for unit tests.
 */
export function reindexAfterRemoval<T>(entries: Map<number, T>, removed: number): void {
  const above = [...entries.keys()].filter((k) => k > removed).sort((a, b) => a - b);
  for (const k of above) {
    const v = entries.get(k) as T;
    entries.delete(k);
    entries.set(k - 1, v);
  }
}

// Shared flame profile for the placement fire effect (the campfire recipe in
// props.ts); one geometry for every burning placement.
let flameGeo: THREE.LatheGeometry | null = null;
function flameGeometry(): THREE.LatheGeometry {
  if (!flameGeo) {
    const pts = [
      [0, 0],
      [0.16, 0.1],
      [0.27, 0.28],
      [0.3, 0.45],
      [0.22, 0.66],
      [0.1, 0.84],
      [0.001, 0.95],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    flameGeo = new THREE.LatheGeometry(pts, 7);
  }
  return flameGeo;
}

// One template per GLB path: the cached scene (cloned per placement, per the
// loader's cache-immutability rule) plus its source-unit bounds.
interface TemplateInfo {
  object: THREE.Object3D;
  norm: number; // source units -> TARGET_HEIGHT normalization factor
  minY: number; // source-unit base offset (seat the lowest point on the ground)
  maxY: number; // source-unit top (fire-effect anchor)
  radiusSrc: number; // source-unit horizontal half-extent (selection ring)
}

interface Entry {
  placement: PlacedAsset;
  model: THREE.Object3D | null; // null until the GLB resolves (async pop-in)
  info: TemplateInfo | null;
  footprint: THREE.Mesh | null;
  // Per-entry material clones (created lazily when a shader tweak is set;
  // clones the shared template materials ONCE so overrides never leak).
  ownMats: THREE.Material[] | null;
  // Animated fire effect (placement.fire): flame mesh + ember glow.
  fireFx: THREE.Group | null;
  // Distance-culled this frame (model kept, just hidden).
  lodHidden: boolean;
  // Distance fade multiplier applied on top of any authored opacity: 1 = fully
  // visible, 0 = about to cull. Drives the material opacity via
  // applyMaterialOverride so it composes with a placement's own opacity.
  lodFade: number;
  // Set by removePlacement so an in-flight GLB load drops its clone. Checked by
  // IDENTITY (not slot) because removePlacementAt reindexes surviving entries.
  removed: boolean;
}

export class PlacedAssetsView {
  readonly group: THREE.Group;
  // Ambience animation speed (map "world speed"): scales the placed-fire flicker
  // so authored fire matches the rest of the ambient motion. 1 = shipped speed.
  ambienceScale = 1;
  private readonly seed: number;
  private readonly entries = new Map<number, Entry>();
  private readonly templates = new Map<string, Promise<TemplateInfo | null>>();
  private footprintsOn = false;
  private selected: number | null = null;
  private selectionRing: THREE.Mesh | null = null;
  private lodCursor = 0;
  // Cached document-index list for the per-frame LOD stride. Rebuilt ONLY when
  // the placement set changes (add/remove/reindex/rebuild), never per frame, so
  // updateLod allocates nothing on the hot path (thousands of brushed foliage
  // placements used to churn GC by materializing the key set every frame).
  private lodKeys: number[] = [];
  private lodKeysDirty = true;
  // The selection ring + footprint rings are editor overlays parented under this
  // (props-categorized) group; noWireframe keeps the editor's Wireframe mode from
  // drawing them as wireframe (viewport applyWireframe honors this flag).
  private readonly selectionMat = new THREE.MeshBasicMaterial({
    color: SELECTION_COLOR,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    side: THREE.DoubleSide,
    userData: { noWireframe: true },
  });
  private readonly footprintMat = new THREE.MeshBasicMaterial({
    color: FOOTPRINT_COLOR,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    side: THREE.DoubleSide,
    userData: { noWireframe: true },
  });

  constructor(placements: readonly (PlacedAsset | null)[], seed: number) {
    this.group = new THREE.Group();
    this.group.name = 'placed-assets';
    this.seed = seed;
    this.rebuildAll(placements, true);
  }

  /** Insert (or replace) the placement rendered at this editor index. */
  addPlacement(index: number, placedAsset: PlacedAsset, preload = false): void {
    this.removePlacement(index);
    const entry: Entry = {
      placement: { ...placedAsset },
      model: null,
      info: null,
      footprint: null,
      ownMats: null,
      fireFx: null,
      lodHidden: false,
      lodFade: 1,
      removed: false,
    };
    this.entries.set(index, entry);
    this.lodKeysDirty = true;
    // The collide footprint only needs the record, not the GLB: show it now.
    this.refreshFootprint(entry);
    // Procedural grass patches skip the GLB pipeline entirely: built here,
    // synchronously, with norm 1 (the patch authors its own source-unit size).
    if (entry.placement.path === GRASS_PATCH_PATH) {
      const p = entry.placement;
      const model = buildGrassPatchModel(p.hue, p.lum, p.clump, grassPatchSeed(p.x, p.z));
      entry.model = model;
      entry.info = {
        object: model,
        norm: 1,
        minY: 0,
        maxY: 0.6,
        radiusSrc: Math.max(0.6, grassPatchRadius(p.clump ?? DEFAULT_TUFTS_PER_PATCH)),
      };
      this.group.add(model);
      this.applyTransform(entry);
      if (this.selected === index) this.refreshSelection();
      return;
    }
    // Procedural waterfalls likewise (see render/waterfall.ts): the animated
    // sheet + pool, authored in source units, stretched by scale/scaleY.
    if (entry.placement.path === WATERFALL_PATH) {
      const model = buildWaterfallModel();
      entry.model = model;
      entry.info = { object: model, norm: 1, minY: 0, maxY: 5, radiusSrc: 2 };
      this.group.add(model);
      this.applyTransform(entry);
      if (this.selected === index) this.refreshSelection();
      return;
    }
    const task = this.template(entry.placement.path).then((info) => {
      // Removed or replaced while the GLB was in flight: drop the clone.
      if (!info || entry.removed) return;
      // Rigged models (characters) need SkeletonUtils.clone: a naive clone
      // shares bind state with the template and renders nothing. Skinned
      // meshes also skip frustum culling (their bounds ignore the bind pose).
      let skinned = false;
      info.object.traverse((o) => {
        if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned = true;
      });
      const model = skinned ? skeletonClone(info.object) : info.object.clone(true);
      model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = true;
          m.receiveShadow = true;
          if ((m as unknown as THREE.SkinnedMesh).isSkinnedMesh) m.frustumCulled = false;
        }
      });
      entry.model = model;
      entry.info = info;
      this.group.add(model);
      this.applyTransform(entry);
      this.applyMaterialOverride(entry);
      this.applyFireFx(entry);
      this.refreshFootprint(entry);
      // By identity, not the captured slot: reindexing may have shifted it.
      if (this.selected !== null && this.entries.get(this.selected) === entry) {
        this.refreshSelection();
      }
    });
    // Boot-time builds gate the loading screen; live editor adds do not.
    if (preload) registerPreload(task);
  }

  /** Move/rotate/rescale the placement at `index` (fields left undefined keep).
   *  `collideRadius` is the EFFECTIVE footprint radius (0 or less = none), so
   *  the editor's collide/radius edits repaint the ring without a rebuild. */
  updatePlacement(
    index: number,
    change: {
      x?: number;
      z?: number;
      rotY?: number;
      scale?: number;
      collideRadius?: number;
      collideShape?: 'square' | null;
      rotX?: number;
      rotZ?: number;
      scaleX?: number;
      scaleY?: number;
      scaleZ?: number;
      y?: number;
      detached?: boolean;
      groundY?: number;
      tint?: number | null;
      opacity?: number | null;
      glow?: number | null;
      glowStrength?: number | null;
      fire?: boolean | null;
    },
  ): void {
    const entry = this.entries.get(index);
    if (!entry) return;
    const p = entry.placement;
    if (change.detached !== undefined) p.detached = change.detached;
    if (change.groundY !== undefined) p.groundY = change.groundY;
    if (change.x !== undefined) p.x = change.x;
    if (change.z !== undefined) p.z = change.z;
    if (change.rotY !== undefined) p.rotY = change.rotY;
    if (change.collideShape !== undefined) {
      if (change.collideShape === 'square') p.collideShape = 'square';
      else delete p.collideShape;
    }
    let matsTouched = false;
    for (const key of ['tint', 'opacity', 'glow', 'glowStrength'] as const) {
      if (change[key] === undefined) continue;
      matsTouched = true;
      const v = change[key];
      if (v === null) delete p[key];
      else p[key] = v;
    }
    if (matsTouched) this.applyMaterialOverride(entry);
    if (change.fire !== undefined) {
      if (change.fire) p.fire = true;
      else delete p.fire;
      this.applyFireFx(entry);
    }
    if (change.scale !== undefined) p.scale = change.scale;
    if (change.rotX !== undefined) p.rotX = change.rotX;
    if (change.rotZ !== undefined) p.rotZ = change.rotZ;
    if (change.scaleX !== undefined) p.scaleX = change.scaleX;
    if (change.scaleY !== undefined) p.scaleY = change.scaleY;
    if (change.scaleZ !== undefined) p.scaleZ = change.scaleZ;
    if (change.y !== undefined) p.y = change.y;
    if (change.collideRadius !== undefined) {
      if (change.collideRadius > 0) p.collideRadius = change.collideRadius;
      else delete p.collideRadius;
    }
    this.applyTransform(entry);
    this.refreshFootprint(entry);
    if (this.selected === index) this.refreshSelection();
  }

  removePlacement(index: number): void {
    const entry = this.entries.get(index);
    if (!entry) return;
    entry.removed = true;
    this.entries.delete(index);
    this.lodKeysDirty = true;
    if (entry.model) this.group.remove(entry.model);
    // Clones share the loader-cached template geometry/materials: never dispose
    // them here. The draped rings are per-entry allocations, so those we do,
    // and a grass patch's instance buffers are per-entry too (its geometry and
    // material stay shared).
    if (entry.placement.path === GRASS_PATCH_PATH && entry.model) {
      (entry.model as THREE.InstancedMesh).dispose();
    }
    // A waterfall's sheet/pool geometry + materials are module-shared; only
    // its mist sprite materials are per-model.
    if (entry.placement.path === WATERFALL_PATH && entry.model) {
      entry.model.traverse((o) => {
        if ((o as THREE.Sprite).isSprite) (o as THREE.Sprite).material.dispose();
      });
    }
    if (entry.ownMats) for (const m of entry.ownMats) m.dispose();
    this.dropFireFx(entry);
    this.dropFootprint(entry);
    if (this.selected === index) this.setSelected(null);
  }

  /**
   * Surgical single removal at a DOCUMENT index: drop the entry (if the id ever
   * resolved) and shift every entry above it down by one so view slots stay in
   * lockstep with document indices, without re-cloning the untouched models.
   * Bulk structural changes (load/paste/undo/mid-list insert) use rebuildAll.
   */
  removePlacementAt(index: number): void {
    this.removePlacement(index);
    reindexAfterRemoval(this.entries, index);
    this.lodKeysDirty = true;
    if (this.selected !== null && this.selected > index) {
      this.selected--;
      this.refreshSelection();
    }
  }

  /** Drape a gold ring under one placement (null clears). */
  setSelected(index: number | null): void {
    this.selected = index;
    this.refreshSelection();
  }

  /** Editor-only: show/hide every colliding placement's collideRadius circle. */
  showFootprints(on: boolean): void {
    if (this.footprintsOn === on) return;
    this.footprintsOn = on;
    for (const entry of this.entries.values()) this.refreshFootprint(entry);
  }

  /**
   * Re-seat placements on the CURRENT terrainHeight (after a sculpt). With a
   * `region` (the stroke bounds), only placements anchored inside it (plus a
   * small margin) re-sample the ground and re-drape their footprint; the rest
   * are untouched, so a stroke-end never scans every placement on a big map.
   * Without one, everything re-seats (map load / undo paths).
   */
  reSeat(region?: SeatRegion): void {
    for (const entry of this.entries.values()) {
      const p = entry.placement;
      if (region && !needsReSeat(p.x, p.z, region)) continue;
      // Detached placements float free: a nearby sculpt must not re-glue the model
      // to the new ground. The footprint ring still re-drapes (collision is 2D).
      if (!p.detached) this.applyTransform(entry);
      this.refreshFootprint(entry);
    }
    this.refreshSelection();
  }

  /**
   * Replace the whole placement set (map load / undo). The array is INDEX-
   * ALIGNED with the editor document: a null hole (unresolvable asset id)
   * renders nothing but still occupies its slot, so later document indices
   * keep addressing the right meshes.
   */
  rebuildAll(placements: readonly (PlacedAsset | null)[], preload = false): void {
    for (const index of [...this.entries.keys()]) this.removePlacement(index);
    this.setSelected(null);
    for (let index = 0; index < placements.length; index++) {
      const placed = placements[index];
      if (placed) this.addPlacement(index, placed, preload);
    }
  }

  private template(path: string): Promise<TemplateInfo | null> {
    let cached = this.templates.get(path);
    if (!cached) {
      cached = loadGltf(path)
        .then((gltf) => {
          const object = gltf.scene;
          // Weakly authored emissive channels never cross the bloom threshold;
          // lift them once on the shared template so "glowy" GLB materials
          // actually glow (clones inherit it).
          object.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            for (const raw of mats) {
              const m = raw as THREE.MeshStandardMaterial;
              if (
                m.emissive &&
                (m.emissive.r > 0 || m.emissive.g > 0 || m.emissive.b > 0) &&
                m.emissiveIntensity > 0 &&
                m.emissiveIntensity < MIN_NATIVE_EMISSIVE_INTENSITY
              ) {
                m.emissiveIntensity = MIN_NATIVE_EMISSIVE_INTENSITY;
              }
            }
          });
          const box = new THREE.Box3().setFromObject(object);
          const size = new THREE.Vector3();
          box.getSize(size);
          const maxDim = Math.max(size.x, size.y, size.z) || 1;
          return {
            object,
            norm: TARGET_HEIGHT / maxDim,
            minY: box.min.y,
            maxY: box.max.y,
            radiusSrc: Math.max(size.x, size.z) / 2 || 1,
          };
        })
        .catch(() => {
          // Missing or unreadable GLB: skip. The editor catalogue may list a
          // model that is not present in a given build; one bad asset must not
          // blank the whole scene.
          return null;
        });
      this.templates.set(path, cached);
    }
    return cached;
  }

  /**
   * Shader tweaks: tint multiplies the albedo, opacity fades the whole model,
   * glow adds emissive. The shared template materials are cloned ONCE per
   * entry on the first tweak; clearing every field restores the shared ones.
   */
  private applyMaterialOverride(entry: Entry): void {
    const model = entry.model;
    if (!model) return;
    // Procedural models (grass, waterfalls) own their shared shader materials;
    // the per-placement tweak pipeline never touches them.
    if (entry.placement.path === GRASS_PATCH_PATH || entry.placement.path === WATERFALL_PATH) {
      return;
    }
    const p = entry.placement;
    const has =
      p.tint !== undefined ||
      p.opacity !== undefined ||
      p.glow !== undefined ||
      p.glowStrength !== undefined ||
      // A distance fade in progress also needs the per-entry material clones so
      // its opacity write never leaks into the shared template.
      entry.lodFade < 1;
    if (!has && !entry.ownMats) return;
    if (!entry.ownMats) {
      const clones: THREE.Material[] = [];
      model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        const cloned = mats.map((mat) => {
          const c = (mat as THREE.Material).clone();
          clones.push(c);
          return c;
        });
        m.material = Array.isArray(m.material) ? cloned : cloned[0];
        (m.userData as { wocBaseColor?: number[] }).wocBaseColor = cloned.map((c) =>
          (c as THREE.MeshStandardMaterial).color?.getHex?.(),
        ) as number[];
        // Baseline emissive too, so a tint/opacity tweak (or clearing a glow)
        // restores the model's OWN glow instead of silencing it to black.
        (m.userData as { wocBaseEmissive?: (number | undefined)[] }).wocBaseEmissive = cloned.map(
          (c) => (c as THREE.MeshStandardMaterial).emissive?.getHex?.(),
        );
        (m.userData as { wocBaseEmissiveI?: (number | undefined)[] }).wocBaseEmissiveI = cloned.map(
          (c) => (c as THREE.MeshStandardMaterial).emissiveIntensity,
        );
      });
      entry.ownMats = clones;
    }
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      const ud = m.userData as {
        wocBaseColor?: (number | undefined)[];
        wocBaseEmissive?: (number | undefined)[];
        wocBaseEmissiveI?: (number | undefined)[];
      };
      const bases = ud.wocBaseColor ?? [];
      const baseEm = ud.wocBaseEmissive ?? [];
      const baseEmI = ud.wocBaseEmissiveI ?? [];
      mats.forEach((raw, i) => {
        const mat = raw as THREE.MeshStandardMaterial;
        if (mat.color) {
          const base = bases[i];
          if (base !== undefined) mat.color.setHex(base);
          if (p.tint !== undefined) mat.color.multiply(new THREE.Color(p.tint));
        }
        // Authored opacity times the distance-fade multiplier.
        const op = (p.opacity ?? 1) * entry.lodFade;
        mat.transparent = op < 1;
        mat.opacity = op;
        mat.depthWrite = op >= 0.99;
        if (mat.emissive) {
          if (p.glow !== undefined) {
            mat.emissive.setHex(p.glow);
            mat.emissiveIntensity = p.glowStrength ?? 1;
          } else {
            mat.emissive.setHex(baseEm[i] ?? 0x000000);
            mat.emissiveIntensity = baseEmI[i] ?? 1;
          }
        }
        mat.needsUpdate = true;
      });
    });
  }

  // ---- fire effect (placement.fire) ---------------------------------------------

  /** Animated flame + hot glow anchored at the model's top. Same recipe as the
   *  campfires (props.ts); the wobble drives itself via onBeforeRender so the
   *  view needs no per-frame tick of its own. */
  private applyFireFx(entry: Entry): void {
    const wants = entry.placement.fire === true && !!entry.model && !!entry.info;
    if (!wants) {
      this.dropFireFx(entry);
      return;
    }
    if (!entry.fireFx) {
      const g = new THREE.Group();
      g.name = 'placed-fire';
      const flame = new THREE.Mesh(
        flameGeometry(),
        new THREE.MeshLambertMaterial({
          color: 0xffaa33,
          emissive: 0xff6600,
          emissiveIntensity: 2.4,
          transparent: true,
          opacity: 0.92,
        }),
      );
      const phase = Math.abs(entry.placement.x * 7.3 + entry.placement.z * 3.1) % 6.28;
      flame.onBeforeRender = () => {
        // Ambience-scaled clock so the flicker tracks the map's world speed.
        const tt = (performance.now() / 1000) * this.ambienceScale;
        const fl = 0.85 + Math.sin(tt * 9 + phase) * 0.12 + Math.sin(tt * 23 + phase * 2) * 0.06;
        flame.scale.set(fl, fl * (1 + Math.sin(tt * 13 + phase) * 0.12), fl);
      };
      const ember = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xffc465, transparent: true, opacity: 0.85 }),
      );
      ember.position.y = 0.12;
      g.add(flame, ember);
      this.group.add(g);
      entry.fireFx = g;
    }
    this.placeFireFx(entry);
  }

  /** Seat the flame on the model's top (scaled), at the placement anchor. */
  private placeFireFx(entry: Entry): void {
    const g = entry.fireFx;
    const info = entry.info;
    if (!g || !info) return;
    const p = entry.placement;
    const s = this.worldScale(entry);
    const topY = (info.maxY - info.minY) * s * (p.scaleY ?? 1);
    const ground = terrainHeight(p.x, p.z, this.seed);
    g.position.set(p.x, ground + topY * 0.82 + (p.y ?? 0), p.z);
    // Flame size tracks the model's world size a little, clamped sane.
    const fs = Math.min(2.4, Math.max(0.7, s * 0.5));
    g.scale.setScalar(fs);
  }

  private dropFireFx(entry: Entry): void {
    if (!entry.fireFx) return;
    this.group.remove(entry.fireFx);
    entry.fireFx.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        // The flame lathe geometry is the shared cached one; the ember sphere
        // and both materials are per-entry.
        if (m.geometry !== flameGeometry()) m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
    entry.fireFx = null;
  }

  private worldScale(entry: Entry): number {
    const p = entry.placement;
    return (entry.info?.norm ?? 1) * (p.scale > 0 ? p.scale : 1);
  }

  private applyTransform(entry: Entry): void {
    if (!entry.model || !entry.info) return;
    const p = entry.placement;
    const s = this.worldScale(entry);
    // Per-axis multipliers (editor gizmo) ride on top of the uniform scale.
    const sy = s * (p.scaleY ?? 1);
    entry.model.scale.set(s * (p.scaleX ?? 1), sy, s * (p.scaleZ ?? 1));
    // Seat the model base on the ground (lift by -minY*scale so its lowest
    // point rests at terrainHeight; approximate under a gizmo tilt), plus the
    // authored vertical offset (the gizmo's Y arrow). A DETACHED placement floats
    // at a frozen ground height instead of tracking the live terrain (Move tool).
    const groundY = p.detached ? (p.groundY ?? 0) : terrainHeight(p.x, p.z, this.seed);
    entry.model.position.set(p.x, groundY - entry.info.minY * sy + (p.y ?? 0), p.z);
    entry.model.rotation.set(p.rotX ?? 0, p.rotY, p.rotZ ?? 0);
    if (entry.fireFx) this.placeFireFx(entry);
  }

  /**
   * Distance culling, called once per frame by the renderer: placements past
   * the view distance (or the fog, whichever is nearer) fade out and stop
   * rendering. `maxFar` is the maker's chosen asset view distance; the fog cap
   * keeps a placement from ever drawing past the terrain. Grass culls sooner
   * still. Checks are strided so huge maps never spend more than
   * LOD_BUDGET_PER_FRAME tests a frame.
   */
  updateLod(camX: number, camZ: number, fogFar: number, maxFar = Number.POSITIVE_INFINITY): void {
    // Rebuild the stride list only when the placement set changed; between
    // structural edits this is allocation-free every frame.
    if (this.lodKeysDirty) {
      this.lodKeys = [...this.entries.keys()];
      this.lodKeysDirty = false;
      if (this.lodCursor >= this.lodKeys.length) this.lodCursor = 0;
    }
    const keys = this.lodKeys;
    if (keys.length === 0) return;
    const budget = Math.min(keys.length, LOD_BUDGET_PER_FRAME);
    for (let n = 0; n < budget; n++) {
      this.lodCursor = (this.lodCursor + 1) % keys.length;
      const entry = this.entries.get(keys[this.lodCursor]);
      if (!entry?.model) continue;
      const p = entry.placement;
      const isGrass = p.path === GRASS_PATCH_PATH;
      // The maker's view distance, but never past the fog (a placement must not
      // render where the ground has fogged out). Grass culls sooner still.
      const far = Math.min(fogFar + 60, maxFar);
      const range = isGrass ? Math.min(far, LOD_RANGE_GRASS) : far;
      const dx = p.x - camX;
      const dz = p.z - camZ;
      const d2 = dx * dx + dz * dz;
      const limit = entry.lodHidden ? range : range * LOD_HYSTERESIS;
      const hide = d2 > limit * limit;
      if (hide !== entry.lodHidden) {
        entry.lodHidden = hide;
        entry.model.visible = !hide;
        if (entry.fireFx) entry.fireFx.visible = !hide;
      }
      // Distance fade for GLB placements: opaque up to the fade band, then fades
      // to invisible by `range` (base-game foliage feel) before the hard cull.
      // Grass/waterfalls share their materials, so they hard-cull only (above).
      if (!isGrass && p.path !== WATERFALL_PATH && !hide) {
        const fadeStart = range * (1 - LOD_FADE_BAND);
        let fade = 1;
        if (d2 > fadeStart * fadeStart) {
          const d = Math.sqrt(d2);
          fade = (range - d) / (range - fadeStart);
          fade = fade < 0 ? 0 : fade > 1 ? 1 : fade;
        }
        this.setLodFade(entry, fade);
      }
    }
  }

  /** Set a placement's distance-fade multiplier and re-apply its materials.
   *  Cheap-guarded: tiny sub-visible changes that stay inside the fade band are
   *  skipped, but a return to (or departure from) fully opaque always applies
   *  (it toggles material transparency). Procedural models (grass/waterfall) are
   *  no-ops in applyMaterialOverride, so this never touches their shared mats. */
  private setLodFade(entry: Entry, fade: number): void {
    const clamped = fade < 0 ? 0 : fade > 1 ? 1 : fade;
    if (entry.lodFade === clamped) return;
    if (clamped < 1 && entry.lodFade < 1 && Math.abs(entry.lodFade - clamped) < LOD_FADE_EPSILON) {
      return;
    }
    entry.lodFade = clamped;
    this.applyMaterialOverride(entry);
  }

  // A flat ring whose vertices are draped onto the terrain: each vertex takes
  // the ground height under it, so the ring hugs slopes instead of clipping.
  private drapedRingGeometry(x: number, z: number, radius: number): THREE.RingGeometry {
    const width = Math.max(0.06, radius * 0.08);
    const geo = new THREE.RingGeometry(Math.max(0.05, radius - width), radius, RING_SEGMENTS);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, terrainHeight(x + pos.getX(i), z + pos.getZ(i), this.seed) + RING_LIFT);
    }
    geo.computeBoundingSphere();
    return geo;
  }

  // The square-footprint outline (collideShape 'square'): a hollow rot-following
  // frame draped onto the terrain like the circle ring.
  private drapedSquareGeometry(
    x: number,
    z: number,
    half: number,
    rotY: number,
  ): THREE.BufferGeometry {
    const width = Math.max(0.06, half * 0.08);
    const outer = new THREE.Shape();
    outer.moveTo(-half, -half);
    outer.lineTo(half, -half);
    outer.lineTo(half, half);
    outer.lineTo(-half, half);
    outer.closePath();
    const inner = new THREE.Path();
    const ih = Math.max(0.05, half - width);
    inner.moveTo(-ih, -ih);
    inner.lineTo(ih, -ih);
    inner.lineTo(ih, ih);
    inner.lineTo(-ih, ih);
    inner.closePath();
    outer.holes.push(inner);
    const geo = new THREE.ShapeGeometry(outer);
    geo.rotateX(-Math.PI / 2);
    // The sim OBB rotates by rotY in three.js convention; match it.
    geo.rotateY(rotY);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, terrainHeight(x + pos.getX(i), z + pos.getZ(i), this.seed) + RING_LIFT);
    }
    geo.computeBoundingSphere();
    return geo;
  }

  private refreshFootprint(entry: Entry): void {
    const r = entry.placement.collideRadius ?? 0;
    if (!this.footprintsOn || r <= 0) {
      this.dropFootprint(entry);
      return;
    }
    const geo =
      entry.placement.collideShape === 'square'
        ? this.drapedSquareGeometry(entry.placement.x, entry.placement.z, r, entry.placement.rotY)
        : this.drapedRingGeometry(entry.placement.x, entry.placement.z, r);
    if (entry.footprint) {
      entry.footprint.geometry.dispose();
      entry.footprint.geometry = geo;
    } else {
      entry.footprint = new THREE.Mesh(geo, this.footprintMat);
      this.group.add(entry.footprint);
    }
    entry.footprint.position.set(entry.placement.x, 0, entry.placement.z);
  }

  private dropFootprint(entry: Entry): void {
    if (!entry.footprint) return;
    this.group.remove(entry.footprint);
    entry.footprint.geometry.dispose();
    entry.footprint = null;
  }

  private refreshSelection(): void {
    const entry = this.selected === null ? undefined : this.entries.get(this.selected);
    if (!entry) {
      if (this.selectionRing) {
        this.group.remove(this.selectionRing);
        this.selectionRing.geometry.dispose();
        this.selectionRing = null;
      }
      return;
    }
    const p = entry.placement;
    // Before the GLB resolves the footprint radius is unknown: use a stand-in.
    const radius = entry.info
      ? Math.max(0.6, entry.info.radiusSrc * this.worldScale(entry) * 1.15)
      : 1;
    const geo = this.drapedRingGeometry(p.x, p.z, radius);
    if (this.selectionRing) {
      this.selectionRing.geometry.dispose();
      this.selectionRing.geometry = geo;
    } else {
      this.selectionRing = new THREE.Mesh(geo, this.selectionMat);
      this.selectionRing.renderOrder = 2;
      this.group.add(this.selectionRing);
    }
    this.selectionRing.position.set(p.x, 0, p.z);
  }
}

/**
 * Back-compat build-once factory (the pre-live-editing shape): builds a
 * PlacedAssetsView and hands back just its group. Initial GLB loads register
 * with the boot preload gate, matching the old behavior.
 */
export function buildPlacedAssets(
  placements: readonly (PlacedAsset | null)[],
  seed: number,
): THREE.Group {
  return new PlacedAssetsView(placements, seed).group;
}
