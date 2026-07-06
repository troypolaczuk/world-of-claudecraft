// The 3D in-world editor viewport. Reuses the real game Renderer over a frozen Sim
// built from the editor's CustomMap, drives a free editor camera, and applies edits
// through the Renderer's live editing APIs: chunk-local terrain rebuilds during a
// brush stroke (rebuildTerrain(region)) with a macro-normal rebake at stroke end,
// the shader brush ring (setEditorBrush/clearEditorBrush), live water re-seating
// (rebuildWater), and the PlacedAssetsView instancer for placements
// (add/update/remove/select/footprints/reSeat). This is the DEFAULT editor mode.
// Editor-only (dev tooling); imports the heavy Renderer.
//
// Ownership: the APP owns the document and the ACTIVE WorldContent
// (setActiveWorldContent); this viewport only reads terrain via the active
// content and pushes render updates.

import * as THREE from 'three';
import { assetsReady } from '../../render/assets/preload';
import type { EditorLightingProfile } from '../../render/editor_lighting';
import { type SeatRegion, unionRegion } from '../../render/placed_assets';
import { Renderer } from '../../render/renderer';
import {
  COLLIDER_DEFAULT_SIZE,
  type ColliderVolumeKind,
  colliderKindFor,
  colliderVolumeFromPlacement,
} from '../../sim/collider_volumes';
import { FENCE_HALF_DEPTH } from '../../sim/colliders';
import {
  DEFAULT_ASSET_VIEW_DISTANCE,
  MAX_AXIS_SCALE,
  MAX_COLLIDER_SIZE,
  MAX_COLLIDER_SIZE_Y,
  MAX_PLACEMENT_Y_OFFSET,
  MIN_AXIS_SCALE,
  MIN_COLLIDER_SIZE,
  MIN_COLLIDER_SIZE_Y,
} from '../../sim/map_doc';
import { Sim } from '../../sim/sim';
import { type BlockerDef, type ColliderVolume, DT, type MapWeather } from '../../sim/types';
import { terrainHeight } from '../../sim/world';
import { t } from '../../ui/i18n';
import {
  type AssetPlacement,
  type CustomMap,
  customMapToWorldContent,
  mapBounds,
  placementsToRenderAssets,
} from '../custom_map';
import { PLACEMENT_SCALE_MAX, PLACEMENT_SCALE_MIN, wrapAngle } from '../placement_transform_core';
import { EditorCamera } from './editor_camera';
import { EditorPerfOverlay, type PerfOverlayConfig } from './perf_overlay';
import {
  type GizmoAxis,
  type GizmoConfig,
  type GizmoMode,
  gizmoAxisDir,
  TransformGizmo,
} from './transform_gizmo';

export interface EditRegion {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface Editor3DHooks {
  // The active tool wants left-click/drag for editing (so the viewport must not
  // orbit on the left button). Right-drag always orbits; middle/shift-drag pans.
  toolActive(): boolean;
  // The active tool claims Shift+left-drag as an INVERTED edit (sculpt tools:
  // raise<->lower, smooth<->flatten) instead of the default Shift-pan.
  shiftEditsTool(): boolean;
  // Pointer began/continued/ended an edit over the terrain surface (world x/z).
  onEditStart(world: { x: number; z: number }, ev: PointerEvent): void;
  onEditMove(world: { x: number; z: number }, ev: PointerEvent): void;
  onEditEnd(ev: PointerEvent): void;
  // The cursor moved over the surface (for the brush gizmo); null when off-terrain.
  onHover(world: { x: number; z: number } | null): void;
  // A left-click that did not turn into a drag while no edit tool was active
  // (Select mode picking). Client coords + the terrain point under the cursor.
  // `additive` = Shift was held (Blender: extend/toggle the selection).
  onTap(
    clientX: number,
    clientY: number,
    world: { x: number; z: number } | null,
    additive: boolean,
  ): void;
  // Direct manipulation of placements in Select mode. When enabled, a left
  // pointerdown on a pickable placement offers the drag to the app; a true
  // return claims it (the app selects the placement) and the viewport streams
  // the terrain point under the cursor until release. A false return falls
  // back to the normal orbit.
  placementDragEnabled(): boolean;
  onPlacementDragStart(index: number): boolean;
  onPlacementDragMove(world: { x: number; z: number }): void;
  onPlacementDragEnd(): void;
  // Ctrl+left-drag marquee in Select mode: every placement index whose anchor
  // projected inside the released box (empty = clear the selection).
  onBoxSelect(indices: number[]): void;
  // Shift+wheel (rotate) / Alt+wheel (scale) over the stage while a placement
  // is selected. True consumes the event; false falls through to camera zoom.
  onTransformWheel(kind: 'rotate' | 'scale', deltaY: number): boolean;
  // The 3-axis gizmo: which mode to show for the current tool + selection
  // (null hides it), live handle-drag updates, and the end-of-drag commit
  // (ONE undo entry, like every other transform gesture).
  gizmoMode(): GizmoMode | null;
  onGizmoChange(change: GizmoPlacementChange): void;
  onGizmoEnd(): void;
}

/** A live placement edit produced by a gizmo handle drag. */
export interface GizmoPlacementChange {
  x?: number;
  y?: number;
  z?: number;
  rotY?: number;
  rotX?: number;
  rotZ?: number;
  scale?: number;
  scaleX?: number;
  scaleY?: number;
  scaleZ?: number;
  sizeX?: number;
  sizeY?: number;
  sizeZ?: number;
}

const SPAWN_RING_COLOR = 0x3fd0ff;
const SPAWN_RING_SEGMENTS = 40;
// Editor-only blocker-wall overlay: translucent boxes over the collision
// segments (the shipped game renders nothing for a blocker). Height is
// presentational; the wall thickness reuses the sim's fence half-depth so the
// drawn box matches the collider exactly.
const BLOCKER_OVERLAY_HEIGHT = 3;
// Blocker walls that run along the map limits draw as the hard boundary they
// are: a wall too tall to ever jump (collision is height-agnostic either way).
const BOUNDARY_OVERLAY_HEIGHT = 100;
const BLOCKER_COLOR = 0xe0503c;
// Editor-only collider-volume overlay: translucent green volumes over the
// 'collider/<kind>' placements (invisible in playtest, like blockers).
const COLLIDER_COLOR = 0x3ddc6a;
// Wireframe mode (Camera tab) applies to MAP GEOMETRY only — these render
// categories (tagged on the renderer's groups via userData.renderCategory).
// Editor overlays (gizmo, rings, labels, nameplates) carry no category and stay
// solid so the chrome stays legible.
const WIREFRAME_MAP_CATEGORIES = new Set(['terrain', 'water', 'foliage', 'fish', 'props']);
const TAP_SLOP_PX = 5;
// Repeated-click cycling through overlapping placements (DCC style): a second tap
// near the SAME screen point within the window advances to the next candidate
// under the cursor instead of re-picking the nearest one.
const CYCLE_WINDOW_MS = 600;
const CYCLE_SLOP_PX = 6;
// Hover-cursor pick throttle (Select mode only): the placement raycast is the
// same cost as a tap pick, so cap it well below the pointer-move rate.
const HOVER_PICK_MS = 90;
// Analytic surface pick: march the pointer ray against the sim terrainHeight
// (render terrain == sim height invariant) instead of raycasting every terrain
// chunk per pointer-move. Coarse steps find the crossing; bisection refines it.
const MARCH_MAX_T = 1200; // yards along the ray (covers the 600yd max orbit dist)
const MARCH_STEPS = 96;
const MARCH_REFINE = 12;

export class Editor3DViewport {
  private canvas!: HTMLCanvasElement;
  private nameplates!: HTMLDivElement;
  private readonly cam = new EditorCamera();
  private sim: Sim | null = null;
  private renderer: Renderer | null = null;
  private raf = 0;
  private lastT = 0;
  private disposed = false;
  private seed = 20061;
  private map: CustomMap;
  // Bumped by start()/reload()/dispose(); an in-flight start() that awoke with a
  // stale token abandons, so a reload during the assets await never leaves two
  // engines (and two event attachments) running.
  private generation = 0;
  // Visibility gate: while hidden the render loop stops and the edit
  // passthroughs coalesce into dirty flags, flushed on the next setVisible(true).
  private visible = true;
  private hiddenTerrainFull = false;
  private hiddenTerrainRegion: SeatRegion | null = null;
  private hiddenWater = false;
  private hiddenPlacements = false;
  private hiddenSpawn = false;
  // The app's last-told selection, reapplied after a flushed structural rebuild
  // (rebuildAll clears the view's selection).
  private selectedIndex: number | null = null;

  private spawnRing: THREE.Mesh | null = null;
  private spawnPoint: { x: number; z: number } | null = null;
  private readonly spawnMat = new THREE.MeshBasicMaterial({
    color: SPAWN_RING_COLOR,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  // Blocker-wall overlay (spawnRing ownership pattern: build/refresh/dispose).
  private blockersGroup: THREE.Group | null = null;
  private blockerPreviewMesh: THREE.Mesh | null = null;
  private hiddenBlockers = false;
  private readonly blockerMat = new THREE.MeshBasicMaterial({
    color: BLOCKER_COLOR,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private readonly blockerPreviewMat = new THREE.MeshBasicMaterial({
    color: BLOCKER_COLOR,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  // Collider-volume overlay (blocker pattern, but keyed by DOCUMENT index so a
  // live transform drag refreshes one mesh instead of the whole set).
  private collidersGroup: THREE.Group | null = null;
  private readonly colliderMeshes = new Map<number, THREE.Mesh>();
  private hiddenColliders = false;
  // User "hide collision volumes" toggle (Collider tab): keeps the group built
  // (and pickable through the same meshes) but drops it from the scene render.
  private collidersUserHidden = false;
  private readonly colliderMat = new THREE.MeshBasicMaterial({
    color: COLLIDER_COLOR,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private readonly colliderSelMat = new THREE.MeshBasicMaterial({
    color: COLLIDER_COLOR,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private readonly picker = new THREE.Raycaster();
  private readonly pickNdc = new THREE.Vector2(); // scratch, per pointer-move

  // The 3-axis transform gizmo (built on start; posed every frame).
  private gizmo: TransformGizmo | null = null;
  private gizmoDrag: {
    axis: GizmoAxis;
    mode: GizmoMode;
    kind: ColliderVolumeKind | null;
    start: AssetPlacement;
    origin: THREE.Vector3;
    plane: THREE.Plane;
    startHit: THREE.Vector3;
  } | null = null;
  private readonly gizmoOriginV = new THREE.Vector3();
  private readonly planeHitV = new THREE.Vector3();

  // Interaction state.
  private dragMode:
    | 'none'
    | 'orbit'
    | 'pan'
    | 'edit'
    | 'placepending'
    | 'moveplacement'
    | 'gizmo'
    | 'marquee' = 'none';
  // A left press landed on a pickable placement (Select mode). The gesture stays
  // 'placepending' until the pointer passes TAP_SLOP_PX: past it, it promotes to a
  // move-drag; a release before it is a tap (select / overlap-cycle).
  private pendingPlaceIdx: number | null = null;
  // Ctrl+drag box select: client-space corners + the overlay rectangle.
  private marquee: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private marqueeEl: HTMLDivElement | null = null;
  private lastPointer = { x: 0, y: 0 };
  private dragDist = 0;
  private lastHoverPickAt = 0;
  // Click-cycle state for overlapping-placement selection (pickPlacementCycling).
  private tapCycle: {
    x: number;
    y: number;
    candidates: number[];
    cursor: number;
    at: number;
  } | null = null;
  private readonly keys = new Set<string>();
  // Free-Fly mode: WASD/QE move whenever toggled on (not just mid-drag), and a
  // navigation drag mouse-looks (first person) instead of orbiting the target.
  private freeFly = false;
  // Map-authored ambience speed (Lighting tab), reapplied after engine reloads.
  private worldSpeed = 1;
  // Placed-asset view distance (Camera tab), reapplied after engine reloads.
  private assetViewDistance = DEFAULT_ASSET_VIEW_DISTANCE;
  // Performance overlay (Camera tab). Created lazily on first enable; fed a
  // stats snapshot each frame. Editor dev tooling, never in playtest.
  private perfOverlay: EditorPerfOverlay | null = null;
  private perfCfg: PerfOverlayConfig | null = null;
  private perfMsSmoothed = 0;
  private perfUpdateAccum = 0;
  // The app's lighting override, kept so an engine reload reapplies it.
  private lighting: EditorLightingProfile | null = null;
  private birdsCfg: { enabled: boolean; count: number; formation: boolean } | null = null;
  private skyboxUrl: string | null = null;
  private showBoundaryWalls = true;
  // Wireframe render mode (Camera tab): draws map geometry as raw polygons. Applied
  // per frame while on; `wireframeWasOn` runs one final reset traverse after it is
  // turned off so shared/cached materials return to solid.
  private wireframe = false;
  private wireframeWasOn = false;
  private lightPreviewOn = false;
  // Authored-overlay groups: named location rects, AI markers, point lights
  // (live editor preview; playtest builds its own from the projection).
  private locationsGroup: THREE.Group | null = null;
  private markersGroup: THREE.Group | null = null;
  private lightsGroup: THREE.Group | null = null;
  private selectedLightIndex: number | null = null;
  private bulbTexture: THREE.CanvasTexture | null = null;
  private zonePreviewMesh: THREE.Mesh | null = null;
  private readonly locationMat = new THREE.MeshBasicMaterial({
    color: 0x46b1ff,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private musicGroup: THREE.Group | null = null;
  // Music-area overlays draw only while the Music tool is active (the rects
  // are authoring chrome, not world content); the selected one highlights.
  private musicPreviewOn = false;
  private selectedMusicIndex: number | null = null;
  private readonly musicMat = new THREE.MeshBasicMaterial({
    color: 0x35d0a5,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private readonly musicSelMat = new THREE.MeshBasicMaterial({
    color: 0x53f0c2,
    transparent: true,
    opacity: 0.38,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private readonly zonePreviewMat = new THREE.MeshBasicMaterial({
    color: 0xf0c419,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private readonly markerMat = new THREE.MeshBasicMaterial({ color: 0xff8c3a });
  private readonly markerObjMat = new THREE.MeshBasicMaterial({ color: 0x9a6bff });
  // Show the playtest player stand-in. Default OFF: the renderer force-shows
  // the self view every frame (sync's isSelf branch), so hiding it needs the
  // group DETACHED from the scene, enforced per frame in loop().
  private showPlayer = false;
  // Blender Shift+D grab: the fresh duplicates follow the cursor with no
  // button held until a left-click confirms (or the app cancels).
  private grabFollow = false;
  // Extra selection rings for the multi-selection members beyond the active
  // one (the renderer's gold ring marks the active).
  private multiSelGroup: THREE.Group | null = null;
  private multiSelIndices: number[] = [];
  private readonly multiSelMat = new THREE.MeshBasicMaterial({
    color: 0xffa640,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  constructor(
    private readonly parent: HTMLElement,
    map: CustomMap,
    private readonly hooks: Editor3DHooks,
  ) {
    this.map = map;
    this.createSurfaces();
  }

  private createSurfaces(): void {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'editor-3d-canvas';
    this.nameplates = document.createElement('div');
    this.nameplates.className = 'editor-3d-nameplates';
    this.parent.append(this.canvas, this.nameplates);
  }

  /**
   * Boot the engine over the ACTIVE world content (the app has already called
   * setActiveWorldContent with a content built from this.map).
   */
  async start(): Promise<void> {
    // Generation token against the double-start race: a reload()/dispose() that
    // lands while we await assets invalidates this run; the loser abandons
    // before building anything (nothing is half-built before the await).
    const gen = ++this.generation;
    if (!this.canvas.isConnected) this.createSurfaces();
    this.seed = this.map.meta.seed;
    const world = customMapToWorldContent(this.map);
    await assetsReady();
    if (this.disposed || gen !== this.generation) return;
    // The live PlacedAssetsView owns placements, so strip them from the Sim's
    // world or the Renderer ctor would build a second, frozen copy.
    this.sim = new Sim({
      seed: this.seed,
      playerClass: 'warrior',
      world: { ...world, placements: undefined },
    });
    this.renderer = new Renderer(this.sim, this.canvas, this.nameplates);
    this.renderer.placedAssets.rebuildAll(
      placementsToRenderAssets(this.map.placements, { hideHidden: true }),
      true,
    );
    // A fresh build reflects the whole document: drop any hidden-time debts
    // (before the spawn ring below, which must build even while hidden).
    this.clearHiddenWork();
    const start = this.map.playerStart ?? null;
    this.spawnPoint = start ? { x: start.x, z: start.z } : null;
    this.refreshSpawnRing();
    this.rebuildBlockers();
    this.refreshColliderVolumes();
    this.refreshAuthoredOverlays();
    if (this.lighting) this.renderer.setEditorLighting(this.lighting);
    if (this.birdsCfg) this.renderer.setBirdsConfig(this.birdsCfg);
    // Take world speed from the CURRENT document (reload() sets this.map before
    // start()), never a stale prior-map value: the renderer ctor already seeded
    // ambience from the active world's timeScale, so only override when non-1.
    this.worldSpeed = this.map.timeScale ?? 1;
    if (this.worldSpeed !== 1) this.renderer.setAmbienceScale(this.worldSpeed);
    this.renderer.setPlacedAssetViewDistance(this.assetViewDistance);
    if (this.skyboxUrl) this.renderer.setEditorSkybox(this.skyboxUrl);
    this.gizmo = new TransformGizmo();
    this.renderer.scene.add(this.gizmo.group);
    // Frame the world hub to start; a sized map also frames its whole extent
    // (small interior maps open close in, big open worlds pull back).
    const hub = this.map.content.zones[0]?.hub ?? { x: 0, z: 0 };
    this.cam.target.set(hub.x, terrainHeight(hub.x, hub.z, this.seed), hub.z);
    if (this.map.worldHalfX !== undefined) {
      const zones = this.map.content.zones;
      const zSpan = (zones[zones.length - 1]?.zMax ?? 0) - (zones[0]?.zMin ?? 0);
      const extent = Math.max(this.map.worldHalfX * 2, zSpan);
      this.cam.dist = Math.min(500, Math.max(20, extent * 0.6));
    }
    this.attachEvents();
    if (this.visible) {
      this.lastT = performance.now();
      this.loop();
    }
  }

  get ready(): boolean {
    return this.renderer !== null;
  }

  // Terrain point under a cursor position (client coords). Analytic ray-march
  // first (cheap, per pointer-move); the renderer's full terrain-mesh raycast
  // only as a fallback when the march misses (horizon, camera under ground).
  // surfacePoint expects canvas-origin coordinates (the game canvas fills the
  // window; the editor canvas is offset by the top bar + tool rail), so convert.
  surfaceAt(clientX: number, clientY: number): { x: number; z: number } | null {
    if (!this.renderer) return null;
    const marched = this.marchSurface(clientX, clientY);
    if (marched) return marched;
    const r = this.canvas.getBoundingClientRect();
    const p = this.renderer.surfacePoint(clientX - r.left, clientY - r.top);
    return p ? { x: p.x, z: p.z } : null;
  }

  // March the pointer ray against terrainHeight (which the render mesh samples,
  // so the two agree): coarse fixed steps to bracket the first crossing, then a
  // bisection refine. Null when the ray never dips under the terrain in range.
  private marchSurface(clientX: number, clientY: number): { x: number; z: number } | null {
    if (!this.renderer) return null;
    const rect = this.canvas.getBoundingClientRect();
    this.pickNdc.set(
      ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
    );
    this.picker.setFromCamera(this.pickNdc, this.renderer.camera);
    const o = this.picker.ray.origin;
    const d = this.picker.ray.direction;
    if (o.y - terrainHeight(o.x, o.z, this.seed) <= 0) return null; // under ground: fall back
    let prevT = 0;
    for (let i = 1; i <= MARCH_STEPS; i++) {
      const t = (i / MARCH_STEPS) * MARCH_MAX_T;
      const dy = o.y + d.y * t - terrainHeight(o.x + d.x * t, o.z + d.z * t, this.seed);
      if (dy <= 0) {
        let lo = prevT;
        let hi = t;
        for (let j = 0; j < MARCH_REFINE; j++) {
          const mid = (lo + hi) / 2;
          const below =
            o.y + d.y * mid - terrainHeight(o.x + d.x * mid, o.z + d.z * mid, this.seed) <= 0;
          if (below) hi = mid;
          else lo = mid;
        }
        const ft = (lo + hi) / 2;
        return { x: o.x + d.x * ft, z: o.z + d.z * ft };
      }
      prevT = t;
    }
    return null;
  }

  /** True while a pointer drag is navigating (fly keys are live), so the app
   *  suppresses single-key tool shortcuts. */
  isNavigating(): boolean {
    return this.dragMode === 'orbit' || this.dragMode === 'pan';
  }

  /** Current orbit yaw (radians); the app's screen-relative nudges read it. */
  cameraYaw(): number {
    return this.cam.yaw;
  }

  /** Free-Fly camera mode (WASD/QE always live, drags mouse-look). */
  setFreeFly(on: boolean): void {
    this.freeFly = on;
    if (!on) this.keys.clear();
  }

  /** Invert the drag-pan direction (editor preference). */
  setInvertPan(on: boolean): void {
    this.cam.panInverted = on;
  }

  /** Per-user camera speed multipliers (Camera tab sliders). */
  setCameraSpeeds(speeds: { move: number; look: number; pan: number }): void {
    this.cam.moveSpeed = speeds.move;
    this.cam.lookSpeed = speeds.look;
    this.cam.panSpeedMul = speeds.pan;
  }

  /** Configure the viewport performance overlay (Camera tab). The overlay DOM
   *  is built the first time it is enabled and kept thereafter. */
  setPerfOverlay(cfg: PerfOverlayConfig): void {
    this.perfCfg = cfg;
    if (cfg.enabled && !this.perfOverlay) {
      this.perfOverlay = new EditorPerfOverlay(this.parent, {
        fps: t('editor.camera.perfFps'),
        frameMs: t('editor.camera.perfFrameMs'),
        assets: t('editor.camera.perfAssets'),
        terrain: t('editor.camera.perfTerrain'),
      });
    }
    this.perfOverlay?.setConfig(cfg);
  }

  /** Editor lighting override; reapplied after every engine (re)build. */
  setLighting(profile: EditorLightingProfile | null): void {
    this.lighting = profile;
    this.renderer?.setEditorLighting(profile);
  }

  setBirds(cfg: { enabled: boolean; count: number; formation: boolean } | null): void {
    this.birdsCfg = cfg;
    this.renderer?.setBirdsConfig(cfg);
  }

  /** Map ambience speed (world speed); reapplied after every engine (re)build. */
  setWorldSpeed(scale: number): void {
    this.worldSpeed = scale;
    this.renderer?.setAmbienceScale(scale);
  }

  /** Placed-asset view distance; reapplied after every engine (re)build. */
  setAssetViewDistance(distance: number): void {
    this.assetViewDistance = distance;
    this.renderer?.setPlacedAssetViewDistance(distance);
  }

  setSkybox(url: string | null): void {
    this.skyboxUrl = url;
    this.renderer?.setEditorSkybox(url);
  }

  /** Map weather override (null = biome rule); reapplied on engine reload via
   *  the world content the renderer boots from. */
  setWeather(weather: MapWeather | null): void {
    this.renderer?.setEditorWeather(weather);
  }

  /** Show/remove the playtest player model (the loop enforces it per frame). */
  setShowPlayer(on: boolean): void {
    this.showPlayer = on;
  }

  /** Blender Shift+D grab: fresh duplicates track the cursor (no button held)
   *  until a left-click confirms; the app commits via onPlacementDragEnd. */
  startGrabFollow(): void {
    this.grabFollow = true;
    this.canvas.style.cursor = 'grabbing';
  }

  get grabFollowing(): boolean {
    return this.grabFollow;
  }

  /** Stop following without the confirming click (Escape / tool switch). */
  cancelGrabFollow(): void {
    this.grabFollow = false;
    this.canvas.style.cursor = '';
  }

  /** The multi-selection members BEYOND the active one: each gets an orange
   *  ring (the renderer's gold ring marks the active). Rebuilt on any change
   *  (selection edits, group drags, terrain sculpts under a member). */
  setMultiSelection(indices: number[]): void {
    this.multiSelIndices = indices;
    this.refreshMultiSelection();
  }

  private refreshMultiSelection(): void {
    if (this.multiSelGroup) {
      this.renderer?.scene.remove(this.multiSelGroup);
      for (const child of this.multiSelGroup.children) {
        (child as THREE.Mesh).geometry.dispose();
      }
      this.multiSelGroup = null;
    }
    if (!this.renderer || this.multiSelIndices.length === 0) return;
    const group = new THREE.Group();
    group.name = 'editor-multi-selection';
    for (const i of this.multiSelIndices) {
      const p = this.map.placements[i];
      if (!p) continue;
      const radius = Math.max(1, p.scale * 1.4);
      const geo = new THREE.RingGeometry(radius - 0.18, radius, 36);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, this.multiSelMat);
      mesh.position.set(p.x, terrainHeight(p.x, p.z, this.seed) + 0.12, p.z);
      mesh.renderOrder = 2;
      group.add(mesh);
    }
    this.multiSelGroup = group;
    this.renderer.scene.add(group);
  }

  /**
   * Blender-style frame/focus: put the orbit pivot on the point of interest
   * and dolly to fit, so orbiting now revolves around it. `extent` is the
   * subject's rough half-size in yards.
   */
  focusOn(x: number, z: number, extent: number): void {
    const ground = terrainHeight(x, z, this.seed);
    this.cam.target.set(x, ground + Math.min(4, extent * 0.4), z);
    this.cam.dist = Math.min(500, Math.max(6, extent * 4));
  }

  /** Like focusOn but dollies in CLOSE (the Scene Collection pin): frames the
   *  subject tight instead of with headroom. `targetY` overrides the terrain seat
   *  so a detached/floating object is centred at its actual height. */
  focusClose(x: number, z: number, extent: number, targetY?: number): void {
    const base = targetY ?? terrainHeight(x, z, this.seed);
    this.cam.target.set(x, base + Math.min(4, extent * 0.4), z);
    this.cam.dist = Math.min(500, Math.max(3, extent * 1.8));
  }

  /** True when the viewport owns this key right now, so the app must not treat
   *  it as a tool shortcut: any key during a navigation drag, and the WASD/QE
   *  movement keys whenever Free-Fly is on. */
  capturesKey(key: string): boolean {
    return this.isNavigating() || (this.freeFly && key.length === 1 && 'wasdqe'.includes(key));
  }

  // ---- live edit application -----------------------------------------------

  /** Chunk-local terrain re-mesh over the edited region (cheap; per drag sample). */
  rebuildTerrainRegion(region: EditRegion): void {
    if (!this.visible) {
      this.hiddenTerrainRegion = unionRegion(this.hiddenTerrainRegion, region);
      return;
    }
    this.renderer?.rebuildTerrain(region);
  }

  /** Stroke-end work: macro-normal rebake + re-seat the region's placements and
   *  the spawn ring (region-scoped so a stroke never rescans every placement). */
  finishTerrainStroke(region: EditRegion): void {
    if (!this.visible) {
      this.hiddenTerrainRegion = unionRegion(this.hiddenTerrainRegion, region);
      return;
    }
    if (!this.renderer) return;
    this.renderer.rebakeTerrainNormals(region);
    this.renderer.placedAssets.reSeat(region);
    this.refreshSpawnRing();
    this.rebuildBlockers(); // walls sit on terrainHeight: re-seat after a sculpt
    this.refreshColliderVolumes(); // volumes too
    this.refreshMultiSelection();
  }

  /** Full terrain rebuild (map load / clear-all / undo of a large batch). */
  rebuildTerrainFull(): void {
    if (!this.visible) {
      this.hiddenTerrainFull = true;
      return;
    }
    if (!this.renderer) return;
    this.renderer.rebuildTerrain();
    this.renderer.rebuildWater();
    this.renderer.placedAssets.reSeat();
    this.refreshSpawnRing();
    this.rebuildBlockers();
    this.refreshColliderVolumes();
  }

  /** Re-seat the water surface at the ACTIVE waterLevel(). */
  rebuildWater(): void {
    if (!this.visible) {
      this.hiddenWater = true;
      return;
    }
    this.renderer?.rebuildWater();
  }

  /** Project the brush ring at world (x, z); pass per pointer-move. */
  setBrush(x: number, z: number, radius: number, color?: number): void {
    this.renderer?.setEditorBrush(x, z, radius, color);
  }

  clearBrush(): void {
    this.renderer?.clearEditorBrush();
  }

  // Placement passthroughs, keyed by the document index (the app keeps document
  // order and view slots in lockstep; bulk structural changes use
  // rebuildPlacements, a single doc removal uses the surgical placementRemoved).
  placementAdded(index: number): void {
    this.tapCycle = null;
    if (!this.visible) {
      this.hiddenPlacements = true;
      return;
    }
    const asset = placementsToRenderAssets([this.map.placements[index]], { hideHidden: true })[0];
    if (asset) this.renderer?.placedAssets.addPlacement(index, asset);
    this.updateColliderVolume(index);
  }

  placementUpdated(
    index: number,
    change: {
      x?: number;
      y?: number;
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
      detached?: boolean;
      groundY?: number;
      tint?: number | null;
      opacity?: number | null;
      glow?: number | null;
      glowStrength?: number | null;
      fire?: boolean | null;
    },
  ): void {
    if (!this.visible) {
      this.hiddenPlacements = true;
      return;
    }
    this.renderer?.placedAssets.updatePlacement(index, change);
    this.updateColliderVolume(index);
  }

  /** Surgical single removal at a DOCUMENT index: the view drops that slot and
   *  shifts the survivors down by one, without re-cloning every model. */
  placementRemoved(index: number): void {
    this.tapCycle = null;
    if (!this.visible) {
      this.hiddenPlacements = true;
      return;
    }
    this.renderer?.placedAssets.removePlacementAt(index);
    // Later collider indexes shifted down by one: rebuild the keyed overlay.
    this.refreshColliderVolumes();
  }

  /** Full re-instance (mid-list insert / paste / undo / bulk edits). */
  rebuildPlacements(): void {
    this.tapCycle = null;
    if (!this.visible) {
      this.hiddenPlacements = true;
      return;
    }
    this.renderer?.placedAssets.rebuildAll(
      placementsToRenderAssets(this.map.placements, { hideHidden: true }),
    );
    this.refreshColliderVolumes();
  }

  setSelectedPlacement(index: number | null): void {
    const prev = this.selectedIndex;
    this.selectedIndex = index;
    // Collider overlay highlight tracks the selection by material swap.
    if (prev !== null) {
      const m = this.colliderMeshes.get(prev);
      if (m) m.material = this.colliderMat;
    }
    if (index !== null) {
      const m = this.colliderMeshes.get(index);
      if (m) m.material = this.colliderSelMat;
    }
    // A pending hidden structural rebuild means the view's slots are stale:
    // the flush reapplies this selection after its rebuildAll.
    if (!this.visible && this.hiddenPlacements) return;
    this.renderer?.placedAssets.setSelected(index);
  }

  showFootprints(on: boolean): void {
    this.renderer?.placedAssets.showFootprints(on);
  }

  /**
   * Which placement a click lands on: raycast the placed-assets group and take
   * the nearest placement anchor to the hit; fall back to the terrain point.
   * Returns the DOCUMENT index or null.
   */
  pickPlacement(clientX: number, clientY: number): number | null {
    if (!this.renderer) return null;
    const rect = this.canvas.getBoundingClientRect();
    this.pickNdc.set(
      ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
    );
    this.picker.setFromCamera(this.pickNdc, this.renderer.camera);
    // Collider overlay volumes are pickable like models (they ARE the visual
    // for collider placements).
    const targets = [
      ...this.renderer.placedAssets.group.children,
      ...(this.collidersGroup?.children ?? []),
    ];
    const hits = this.picker.intersectObjects(targets, true);
    let probe: { x: number; z: number } | null = null;
    let slack = 1.5;
    if (hits.length > 0 && hits[0].point) {
      // A direct hit on a collider overlay mesh resolves by identity (the hit
      // point on a long wall can be far from its anchor).
      for (const [index, mesh] of this.colliderMeshes) {
        if (mesh === hits[0].object) return index;
      }
      probe = { x: hits[0].point.x, z: hits[0].point.z };
      slack = 4;
    } else {
      probe = this.surfaceAt(clientX, clientY);
    }
    if (!probe) return null;
    let best = -1;
    let bestD2 = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.map.placements.length; i++) {
      const p = this.map.placements[i];
      const dx = probe.x - p.x;
      const dz = probe.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    if (best < 0) return null;
    const maxD = Math.max(slack, (this.map.placements[best].scale || 1) * 2);
    return bestD2 <= maxD * maxD ? best : null;
  }

  /**
   * Every placement under the cursor as an ORDERED candidate list (front-to-back
   * by camera distance), for repeated-click cycling. Collider overlays resolve by
   * mesh identity; model anchors resolve by proximity to the ray hit (or the
   * terrain point under the cursor), mirroring pickPlacement's dual path. Hidden
   * placements are skipped (they have no pickable geometry).
   */
  private pickPlacementCandidates(clientX: number, clientY: number): number[] {
    if (!this.renderer) return [];
    const rect = this.canvas.getBoundingClientRect();
    this.pickNdc.set(
      ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
    );
    this.picker.setFromCamera(this.pickNdc, this.renderer.camera);
    const targets = [
      ...this.renderer.placedAssets.group.children,
      ...(this.collidersGroup?.children ?? []),
    ];
    const hits = this.picker.intersectObjects(targets, true);
    let probe: { x: number; z: number } | null = null;
    let slack = 1.5;
    if (hits.length > 0 && hits[0].point) {
      probe = { x: hits[0].point.x, z: hits[0].point.z };
      slack = 4;
    } else {
      probe = this.surfaceAt(clientX, clientY);
    }
    const cam = this.renderer.camera;
    const found: { index: number; camD2: number }[] = [];
    const seen = new Set<number>();
    const add = (index: number): void => {
      if (seen.has(index)) return;
      const q = this.map.placements[index];
      if (!q || q.hidden) return;
      seen.add(index);
      const anchorY =
        (q.detached ? (q.groundY ?? 0) : terrainHeight(q.x, q.z, this.seed)) + (q.y ?? 0);
      const dx = cam.position.x - q.x;
      const dy = cam.position.y - anchorY;
      const dz = cam.position.z - q.z;
      found.push({ index, camD2: dx * dx + dy * dy + dz * dz });
    };
    // Collider overlays resolve by identity (their meshes ARE the volume).
    for (const h of hits) {
      for (const [index, mesh] of this.colliderMeshes) {
        if (mesh === h.object) add(index);
      }
    }
    // Model/asset anchors near the probe point (same gate as pickPlacement).
    if (probe) {
      for (let i = 0; i < this.map.placements.length; i++) {
        if (seen.has(i)) continue;
        const p = this.map.placements[i];
        if (p.hidden) continue;
        const dx = probe.x - p.x;
        const dz = probe.z - p.z;
        const d2 = dx * dx + dz * dz;
        const maxD = Math.max(slack, (p.scale || 1) * 2);
        if (d2 <= maxD * maxD) add(i);
      }
    }
    found.sort((a, b) => a.camD2 - b.camD2);
    return found.map((f) => f.index);
  }

  /**
   * A Select-mode tap resolved through the overlap cycle: the first tap picks the
   * front-most candidate under the cursor; each repeat tap near the SAME point
   * within CYCLE_WINDOW_MS advances to the next overlapping candidate (wrapping),
   * so stacked objects become reachable. Returns the chosen document index or null.
   */
  pickPlacementCycling(clientX: number, clientY: number): number | null {
    const candidates = this.pickPlacementCandidates(clientX, clientY);
    if (candidates.length === 0) {
      this.tapCycle = null;
      return null;
    }
    const now = performance.now();
    const c = this.tapCycle;
    const sameSpot =
      c !== null &&
      Math.abs(clientX - c.x) <= CYCLE_SLOP_PX &&
      Math.abs(clientY - c.y) <= CYCLE_SLOP_PX;
    const inWindow = c !== null && now - c.at <= CYCLE_WINDOW_MS;
    const sameSet =
      c !== null &&
      c.candidates.length === candidates.length &&
      c.candidates.every((v, i) => v === candidates[i]);
    if (c && sameSpot && inWindow && sameSet && candidates.length > 1) {
      c.cursor = (c.cursor + 1) % candidates.length;
      c.at = now;
      c.x = clientX;
      c.y = clientY;
      return candidates[c.cursor];
    }
    this.tapCycle = { x: clientX, y: clientY, candidates, cursor: 0, at: now };
    return candidates[0];
  }

  /** Drop the click-cycle state (structural placement change shifts indices). */
  resetTapCycle(): void {
    this.tapCycle = null;
  }

  // ---- spawn marker ----------------------------------------------------------

  setSpawnMarker(point: { x: number; z: number } | null): void {
    this.spawnPoint = point ? { x: point.x, z: point.z } : null;
    if (!this.visible) {
      this.hiddenSpawn = true;
      return;
    }
    this.refreshSpawnRing();
  }

  private refreshSpawnRing(): void {
    if (!this.renderer) return;
    if (this.spawnRing) {
      this.renderer.scene.remove(this.spawnRing);
      this.spawnRing.geometry.dispose();
      this.spawnRing = null;
    }
    if (!this.spawnPoint) return;
    const { x, z } = this.spawnPoint;
    const radius = 1.6;
    const geo = new THREE.RingGeometry(radius - 0.22, radius, SPAWN_RING_SEGMENTS);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, terrainHeight(x + pos.getX(i), z + pos.getZ(i), this.seed) + 0.1);
    }
    geo.computeBoundingSphere();
    this.spawnRing = new THREE.Mesh(geo, this.spawnMat);
    this.spawnRing.position.set(x, 0, z);
    this.spawnRing.renderOrder = 2;
    this.renderer.scene.add(this.spawnRing);
  }

  // ---- blocker walls (editor-only overlay) -----------------------------------

  /** Rebuild the translucent wall boxes from this.map.blockers (any change:
   *  add, erase, undo/redo, map load). Disposes the previous geometries. */
  rebuildBlockers(): void {
    if (!this.visible) {
      this.hiddenBlockers = true;
      return;
    }
    if (!this.renderer) return;
    this.disposeBlockers();
    const blockers = this.map.blockers ?? [];
    if (blockers.length === 0) return;
    const group = new THREE.Group();
    group.name = 'editor-blockers';
    for (const b of blockers) {
      // The tall map-limit walls can be hidden (View setting); their collision
      // is untouched — this is overlay visibility only.
      if (!this.showBoundaryWalls && this.isBoundaryBlocker(b)) continue;
      group.add(this.blockerMesh(b, this.blockerMat));
    }
    this.blockersGroup = group;
    this.renderer.scene.add(group);
  }

  /** Rebuild the location/marker/light overlays from the document (editor-only). */
  refreshAuthoredOverlays(): void {
    if (!this.renderer) return;
    const scene = this.renderer.scene;
    const drop = (g: THREE.Group | null): null => {
      if (g) {
        scene.remove(g);
        g.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) m.geometry.dispose();
        });
      }
      return null;
    };
    this.locationsGroup = drop(this.locationsGroup);
    this.markersGroup = drop(this.markersGroup);
    this.musicGroup = drop(this.musicGroup);
    if (this.lightsGroup) {
      scene.remove(this.lightsGroup);
      this.lightsGroup.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
        if ((o as THREE.PointLight).isLight) (o as THREE.PointLight).dispose();
        // Bulb sprites own their material (per-light tint); the texture is the
        // shared cached one and stays alive.
        if ((o as THREE.Sprite).isSprite) (o as THREE.Sprite).material.dispose();
      });
      this.lightsGroup = null;
    }
    const locs = this.map.locations ?? [];
    if (locs.length > 0) {
      const g = new THREE.Group();
      g.name = 'editor-locations';
      for (const l of locs) {
        const geo = new THREE.PlaneGeometry(l.maxX - l.minX, l.maxZ - l.minZ);
        geo.rotateX(-Math.PI / 2);
        const mesh = new THREE.Mesh(geo, this.locationMat);
        const cx = (l.minX + l.maxX) / 2;
        const cz = (l.minZ + l.maxZ) / 2;
        mesh.position.set(cx, terrainHeight(cx, cz, this.seed) + 0.25, cz);
        mesh.renderOrder = 2;
        g.add(mesh);
      }
      this.locationsGroup = g;
      scene.add(g);
    }
    const musicAreas = this.musicPreviewOn ? (this.map.music?.areas ?? []) : [];
    if (musicAreas.length > 0) {
      const g = new THREE.Group();
      g.name = 'editor-music-areas';
      for (let i = 0; i < musicAreas.length; i++) {
        const a = musicAreas[i];
        const geo = new THREE.PlaneGeometry(a.maxX - a.minX, a.maxZ - a.minZ);
        geo.rotateX(-Math.PI / 2);
        const mesh = new THREE.Mesh(
          geo,
          i === this.selectedMusicIndex ? this.musicSelMat : this.musicMat,
        );
        const cx = (a.minX + a.maxX) / 2;
        const cz = (a.minZ + a.maxZ) / 2;
        mesh.position.set(cx, terrainHeight(cx, cz, this.seed) + 0.2, cz);
        mesh.renderOrder = 2;
        g.add(mesh);
      }
      this.musicGroup = g;
      scene.add(g);
    }
    const markers = this.map.markers ?? [];
    if (markers.length > 0) {
      const g = new THREE.Group();
      g.name = 'editor-markers';
      for (const m of markers) {
        const geo = new THREE.ConeGeometry(0.5, 1.6, 8);
        const mesh = new THREE.Mesh(geo, m.kind === 'object' ? this.markerObjMat : this.markerMat);
        mesh.position.set(m.x, terrainHeight(m.x, m.z, this.seed) + 0.8, m.z);
        mesh.renderOrder = 2;
        g.add(mesh);
      }
      this.markersGroup = g;
      scene.add(g);
    }
    const lights = this.map.lights ?? [];
    if (lights.length > 0) {
      const g = new THREE.Group();
      g.name = 'editor-map-lights';
      for (let i = 0; i < lights.length; i++) {
        const l = lights[i];
        const y = terrainHeight(l.x, l.z, this.seed) + l.y;
        // The LIVE lights only shine while the Light tool is active: every
        // change to the scene's point-light count recompiles all lit shaders
        // and raises the per-fragment cost, so normal editing stays light-free
        // (playtest renders them for real via the renderer's fixed boot set).
        if (this.lightPreviewOn) {
          const pl = new THREE.PointLight(l.color, l.intensity, l.range, 1.8);
          pl.position.set(l.x, y, l.z);
          g.add(pl);
        }
        // Always-visible bulb badge: a camera-facing sprite so map lights are
        // findable (and clickable) from any angle and any tool.
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: this.bulbSpriteTexture(),
            color: l.color,
            transparent: true,
            depthWrite: false,
          }),
        );
        sprite.position.set(l.x, y, l.z);
        const selected = i === this.selectedLightIndex;
        sprite.scale.setScalar(selected ? 1.6 : 1.1);
        sprite.renderOrder = 3;
        sprite.userData.lightIndex = i;
        g.add(sprite);
        if (selected) {
          // Ground ring showing the light's RANGE, so power edits read spatially.
          const ring = new THREE.RingGeometry(Math.max(0.5, l.range - 0.25), l.range, 48);
          ring.rotateX(-Math.PI / 2);
          const mesh = new THREE.Mesh(ring, this.multiSelMat);
          mesh.position.set(l.x, terrainHeight(l.x, l.z, this.seed) + 0.15, l.z);
          mesh.renderOrder = 2;
          g.add(mesh);
        }
      }
      this.lightsGroup = g;
      scene.add(g);
    }
  }

  /** Shared white lightbulb sprite texture, tinted per light via material color. */
  private bulbSpriteTexture(): THREE.CanvasTexture {
    if (this.bulbTexture) return this.bulbTexture;
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, 64, 64);
      // Soft halo so the badge reads at range.
      const halo = ctx.createRadialGradient(32, 26, 4, 32, 26, 26);
      halo.addColorStop(0, 'rgba(255,255,255,0.65)');
      halo.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, 64, 64);
      // Glass.
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.beginPath();
      ctx.arc(32, 26, 13, 0, Math.PI * 2);
      ctx.fill();
      // Neck + screw base.
      ctx.fillRect(26, 37, 12, 5);
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillRect(27, 43, 10, 3);
      ctx.fillRect(28, 47, 8, 3);
      // Filament hint (transparent cut so the tint shows through darker).
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(27, 30);
      ctx.lineTo(30, 25);
      ctx.lineTo(34, 29);
      ctx.lineTo(37, 24);
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }
    this.bulbTexture = new THREE.CanvasTexture(c);
    this.bulbTexture.colorSpace = THREE.SRGBColorSpace;
    return this.bulbTexture;
  }

  /** The map-light index under a click (bulb sprites), or null. */
  pickMapLight(clientX: number, clientY: number): number | null {
    if (!this.renderer || !this.lightsGroup) return null;
    const rect = this.canvas.getBoundingClientRect();
    this.pickNdc.set(
      ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
    );
    this.picker.setFromCamera(this.pickNdc, this.renderer.camera);
    const hits = this.picker.intersectObjects(this.lightsGroup.children, false);
    for (const h of hits) {
      const idx = h.object.userData.lightIndex;
      if (typeof idx === 'number') return idx;
    }
    return null;
  }

  /** Editor selection of a map light (bulb enlarges + range ring shows). */
  setSelectedLight(index: number | null): void {
    if (this.selectedLightIndex === index) return;
    this.selectedLightIndex = index;
    this.refreshAuthoredOverlays();
  }

  /** Light-tool preview: shine the authored lights while editing them. */
  setLightPreview(on: boolean): void {
    if (this.lightPreviewOn === on) return;
    this.lightPreviewOn = on;
    this.refreshAuthoredOverlays();
  }

  /** Music-tool preview: the area rects draw only while the tool is active. */
  setMusicPreview(on: boolean): void {
    if (this.musicPreviewOn === on) return;
    this.musicPreviewOn = on;
    this.refreshAuthoredOverlays();
  }

  /** Editor selection of a music area (rect brightens; null clears). */
  setSelectedMusicArea(index: number | null): void {
    if (this.selectedMusicIndex === index) return;
    this.selectedMusicIndex = index;
    this.refreshAuthoredOverlays();
  }

  /** Live drag preview for the Zone tool's naming box (null clears). */
  setZonePreview(rect: { minX: number; minZ: number; maxX: number; maxZ: number } | null): void {
    if (!this.renderer) return;
    if (this.zonePreviewMesh) {
      this.renderer.scene.remove(this.zonePreviewMesh);
      this.zonePreviewMesh.geometry.dispose();
      this.zonePreviewMesh = null;
    }
    if (!rect || rect.maxX - rect.minX < 0.2 || rect.maxZ - rect.minZ < 0.2) return;
    const geo = new THREE.PlaneGeometry(rect.maxX - rect.minX, rect.maxZ - rect.minZ);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, this.zonePreviewMat);
    const cx = (rect.minX + rect.maxX) / 2;
    const cz = (rect.minZ + rect.maxZ) / 2;
    mesh.position.set(cx, terrainHeight(cx, cz, this.seed) + 0.3, cz);
    mesh.renderOrder = 2;
    this.renderer.scene.add(mesh);
    this.zonePreviewMesh = mesh;
  }

  setShowBoundaryWalls(on: boolean): void {
    if (this.showBoundaryWalls === on) return;
    this.showBoundaryWalls = on;
    this.rebuildBlockers();
  }

  /** Wireframe render mode: draw the map's raw polygons with no textures. The
   *  per-frame apply (in loop()) does the material work so newly added/rebuilt
   *  meshes are covered automatically. */
  setWireframe(on: boolean): void {
    this.wireframe = on;
  }

  /** Toggle material.wireframe on every MAP-geometry mesh (terrain/water/foliage/
   *  fish/props), leaving editor overlays untouched. Run each frame while on, and
   *  once after turning off to restore shared/cached materials to solid. */
  private applyWireframe(): void {
    if (!this.renderer) return;
    const on = this.wireframe;
    this.renderer.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      // renderCategory sits on the GROUP, not the leaf mesh: walk ancestors.
      let node: THREE.Object3D | null = o;
      let belongs = false;
      while (node) {
        const cat = node.userData?.renderCategory;
        if (typeof cat === 'string' && WIREFRAME_MAP_CATEGORIES.has(cat)) {
          belongs = true;
          break;
        }
        node = node.parent;
      }
      if (!belongs) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        // Editor overlays parented under a map-geometry group (the selection ring
        // + footprint rings live under the props group) opt out of wireframe.
        if (!m || m.userData?.noWireframe) continue;
        if ('wireframe' in m) (m as THREE.Material & { wireframe: boolean }).wireframe = on;
      }
    });
  }

  /** Live drag preview of the wall being drawn (null clears it). */
  setBlockerPreview(seg: BlockerDef | null): void {
    if (!this.renderer) return;
    if (this.blockerPreviewMesh) {
      this.renderer.scene.remove(this.blockerPreviewMesh);
      this.blockerPreviewMesh.geometry.dispose();
      this.blockerPreviewMesh = null;
    }
    if (!seg) return;
    this.blockerPreviewMesh = this.blockerMesh(seg, this.blockerPreviewMat);
    this.renderer.scene.add(this.blockerPreviewMesh);
  }

  /** A blocker running along the map's world rect is a boundary wall. */
  private isBoundaryBlocker(b: BlockerDef): boolean {
    const { halfW, zMin, zMax } = mapBounds(this.map);
    const eps = 0.5;
    const onX = (v: number): boolean => Math.abs(b.x1 - v) < eps && Math.abs(b.x2 - v) < eps;
    const onZ = (v: number): boolean => Math.abs(b.z1 - v) < eps && Math.abs(b.z2 - v) < eps;
    return onX(halfW) || onX(-halfW) || onZ(zMin) || onZ(zMax);
  }

  // One box per segment: fence-thick, seated on the terrain at the midpoint,
  // yawed with the same convention the sim's OBB collider uses. Boundary
  // segments draw full map-limit height.
  private blockerMesh(b: BlockerDef, mat: THREE.Material): THREE.Mesh {
    const dx = b.x2 - b.x1;
    const dz = b.z2 - b.z1;
    const len = Math.max(0.1, Math.hypot(dx, dz));
    const height = this.isBoundaryBlocker(b) ? BOUNDARY_OVERLAY_HEIGHT : BLOCKER_OVERLAY_HEIGHT;
    const geo = new THREE.BoxGeometry(len, height, FENCE_HALF_DEPTH * 2);
    const mesh = new THREE.Mesh(geo, mat);
    const x = (b.x1 + b.x2) / 2;
    const z = (b.z1 + b.z2) / 2;
    mesh.position.set(x, terrainHeight(x, z, this.seed) + height / 2, z);
    mesh.rotation.y = Math.atan2(-dz, dx);
    mesh.renderOrder = 2;
    return mesh;
  }

  private disposeBlockers(): void {
    if (this.blockersGroup) {
      this.renderer?.scene.remove(this.blockersGroup);
      for (const child of this.blockersGroup.children) {
        (child as THREE.Mesh).geometry.dispose();
      }
      this.blockersGroup = null;
    }
  }

  // ---- transform gizmo ---------------------------------------------------------

  /** Per-frame gizmo pose: at the selection's anchor, camera-distance sized,
   *  hidden when no transform tool + selection is active. */
  private syncGizmo(): void {
    const g = this.gizmo;
    if (!g || !this.renderer) return;
    const mode = this.hooks.gizmoMode();
    const idx = this.selectedIndex;
    const p = idx !== null ? this.map.placements[idx] : undefined;
    if (!mode || !p) {
      g.hide();
      return;
    }
    const kind = colliderKindFor(p.assetId);
    const config: GizmoConfig = {
      mode,
      // The Y move arrow lifts ANY placement off its seat: ordinary assets and
      // box/sphere/wall colliders edit the shared vertical offset (visual only —
      // collision stays 2D), a floor plane shifts its floor-height offset. Every
      // movable object is draggable on all three axes.
      moveY: true,
      // Box/sphere colliders are yaw-only in the sim (OBB), so no tilt rings;
      // planes tilt into sloped floors (ramps), so they get all three.
      rotateXZ: kind === null || kind === 'plane',
      scaleAxes: kind === 'sphere' ? ['x'] : kind === 'plane' ? ['x', 'z'] : ['x', 'y', 'z'],
    };
    const origin = this.gizmoOriginFor(p, kind);
    const dist = this.renderer.camera.position.distanceTo(origin);
    g.show(config, origin, Math.min(40, Math.max(1.2, dist * 0.14)));
  }

  private gizmoOriginFor(p: AssetPlacement, kind: ColliderVolumeKind | null): THREE.Vector3 {
    const ground = p.detached ? (p.groundY ?? 0) : terrainHeight(p.x, p.z, this.seed);
    // A plane's Y handle rides its floor offset (sizeY); every other kind (assets
    // + box/sphere/wall) rides the shared vertical offset, so the gizmo tracks the
    // lifted object instead of staying pinned to the ground.
    const y = kind === 'plane' ? ground + (p.sizeY ?? 0) : ground + (p.y ?? 0);
    return this.gizmoOriginV.set(p.x, y + 0.05, p.z);
  }

  /** The gizmo handle under a pointer position, or null. */
  private gizmoPick(clientX: number, clientY: number): GizmoAxis | null {
    if (!this.gizmo || !this.renderer) return null;
    const rect = this.canvas.getBoundingClientRect();
    this.pickNdc.set(
      ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
    );
    this.picker.setFromCamera(this.pickNdc, this.renderer.camera);
    return this.gizmo.pick(this.picker);
  }

  // ---- Ctrl+drag box select -----------------------------------------------------

  /** Show/refresh (or remove, when no marquee is live) the selection box. */
  private updateMarqueeEl(): void {
    if (!this.marquee) {
      this.marqueeEl?.remove();
      this.marqueeEl = null;
      return;
    }
    if (!this.marqueeEl) {
      const div = document.createElement('div');
      div.className = 'editor-3d-marquee';
      div.style.cssText =
        'position:fixed;pointer-events:none;z-index:30;' +
        'border:1px dashed rgba(240,196,25,0.9);background:rgba(240,196,25,0.12);';
      document.body.appendChild(div);
      this.marqueeEl = div;
    }
    const m = this.marquee;
    this.marqueeEl.style.left = `${Math.min(m.x0, m.x1)}px`;
    this.marqueeEl.style.top = `${Math.min(m.y0, m.y1)}px`;
    this.marqueeEl.style.width = `${Math.abs(m.x1 - m.x0)}px`;
    this.marqueeEl.style.height = `${Math.abs(m.y1 - m.y0)}px`;
  }

  /** Every placement whose anchor projects inside the live marquee box. */
  private placementsInMarquee(): number[] {
    const m = this.marquee;
    if (!m || !this.renderer) return [];
    const minX = Math.min(m.x0, m.x1);
    const maxX = Math.max(m.x0, m.x1);
    const minY = Math.min(m.y0, m.y1);
    const maxY = Math.max(m.y0, m.y1);
    // A click without a real drag clears the selection instead of lassoing a
    // zero-area box.
    if (maxX - minX < 3 && maxY - minY < 3) return [];
    const rect = this.canvas.getBoundingClientRect();
    const cam = this.renderer.camera;
    const v = new THREE.Vector3();
    const out: number[] = [];
    for (let i = 0; i < this.map.placements.length; i++) {
      const p = this.map.placements[i];
      const anchorY =
        (p.detached ? (p.groundY ?? 0) : terrainHeight(p.x, p.z, this.seed)) + (p.y ?? 0);
      v.set(p.x, anchorY, p.z).project(cam);
      if (v.z > 1 || v.z < -1) continue; // behind the camera / past far plane
      const sx = rect.left + ((v.x + 1) / 2) * rect.width;
      const sy = rect.top + ((1 - v.y) / 2) * rect.height;
      if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) out.push(i);
    }
    return out;
  }

  /** Pointer-ray hit on an interaction plane (client coords), or null. */
  private planeHit(clientX: number, clientY: number, plane: THREE.Plane): THREE.Vector3 | null {
    if (!this.renderer) return null;
    const rect = this.canvas.getBoundingClientRect();
    this.pickNdc.set(
      ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
    );
    this.picker.setFromCamera(this.pickNdc, this.renderer.camera);
    return this.picker.ray.intersectPlane(plane, this.planeHitV);
  }

  /** Claim a left-press on a gizmo handle; captures the drag baseline. */
  private beginGizmoDrag(axis: GizmoAxis, clientX: number, clientY: number): boolean {
    const mode = this.hooks.gizmoMode();
    const idx = this.selectedIndex;
    const p = idx !== null ? this.map.placements[idx] : undefined;
    if (!mode || !p || !this.renderer) return false;
    const kind = colliderKindFor(p.assetId);
    const origin = this.gizmoOriginFor(p, kind).clone();
    let plane: THREE.Plane;
    if (mode === 'rotate') {
      // Rotation reads the cursor's angle in the ring's own plane.
      plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
        gizmoAxisDir(axis as 'x' | 'y' | 'z'),
        origin,
      );
    } else if (axis === 'y') {
      // Vertical edits track a camera-facing vertical plane through the origin.
      const n = this.renderer.camera.position.clone().sub(origin);
      n.y = 0;
      if (n.lengthSq() < 1e-6) n.set(0, 0, 1);
      n.normalize();
      plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, origin);
    } else {
      // Ground-plane edits at the gizmo's height.
      plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), origin);
    }
    const hit = this.planeHit(clientX, clientY, plane);
    if (!hit) return false;
    this.gizmoDrag = { axis, mode, kind, start: { ...p }, origin, plane, startHit: hit.clone() };
    this.dragMode = 'gizmo';
    return true;
  }

  /** One gizmo drag sample: constrain the plane hit to the handle's axis and
   *  push the live (uncommitted) placement change to the app. */
  private updateGizmoDrag(clientX: number, clientY: number): void {
    const d = this.gizmoDrag;
    if (!d) return;
    const hit = this.planeHit(clientX, clientY, d.plane);
    if (!hit) return;
    const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
    const round2 = (v: number): number => Math.round(v * 100) / 100;
    let change: GizmoPlacementChange | null = null;
    if (d.mode === 'move') {
      if (d.axis === 'y') {
        const dy = hit.y - d.startHit.y;
        change =
          d.kind === 'plane'
            ? {
                sizeY: round2(
                  clamp((d.start.sizeY ?? 0) + dy, MIN_COLLIDER_SIZE_Y, MAX_COLLIDER_SIZE_Y),
                ),
              }
            : {
                y: round2(
                  clamp((d.start.y ?? 0) + dy, -MAX_PLACEMENT_Y_OFFSET, MAX_PLACEMENT_Y_OFFSET),
                ),
              };
      } else {
        const dx = hit.x - d.startHit.x;
        const dz = hit.z - d.startHit.z;
        if (d.axis === 'x') change = { x: d.start.x + dx };
        else if (d.axis === 'z') change = { z: d.start.z + dz };
        else change = { x: d.start.x + dx, z: d.start.z + dz };
      }
    } else if (d.mode === 'rotate') {
      const v0 = d.startHit.clone().sub(d.origin);
      const v1 = hit.clone().sub(d.origin);
      if (v1.lengthSq() < 1e-4) return;
      if (d.axis === 'y') {
        const delta = Math.atan2(v1.x, v1.z) - Math.atan2(v0.x, v0.z);
        change = { rotY: wrapAngle(d.start.rotY + delta) };
      } else if (d.axis === 'x') {
        const delta = Math.atan2(v1.z, v1.y) - Math.atan2(v0.z, v0.y);
        change = { rotX: wrapAngle((d.start.rotX ?? 0) + delta) };
      } else {
        const delta = Math.atan2(v1.y, v1.x) - Math.atan2(v0.y, v0.x);
        change = { rotZ: wrapAngle((d.start.rotZ ?? 0) + delta) };
      }
    } else {
      // scale
      if (d.axis === 'uniform') {
        const r0 = Math.max(0.2, d.startHit.distanceTo(d.origin));
        const next = d.start.scale * (hit.distanceTo(d.origin) / r0);
        change = { scale: round2(clamp(next, PLACEMENT_SCALE_MIN, PLACEMENT_SCALE_MAX)) };
      } else {
        const dir = gizmoAxisDir(d.axis as 'x' | 'y' | 'z');
        const along0 = Math.abs(d.startHit.clone().sub(d.origin).dot(dir));
        const along1 = Math.abs(hit.clone().sub(d.origin).dot(dir));
        const ratio = along1 / Math.max(0.05, along0);
        if (d.kind) {
          const def = COLLIDER_DEFAULT_SIZE[d.kind];
          if (d.axis === 'x') {
            change = {
              sizeX: round2(
                clamp((d.start.sizeX ?? def.x) * ratio, MIN_COLLIDER_SIZE, MAX_COLLIDER_SIZE),
              ),
            };
          } else if (d.axis === 'z') {
            change = {
              sizeZ: round2(
                clamp((d.start.sizeZ ?? def.z) * ratio, MIN_COLLIDER_SIZE, MAX_COLLIDER_SIZE),
              ),
            };
          } else {
            // Box height scales from its authored (positive) size.
            change = {
              sizeY: round2(
                clamp(
                  Math.max(0.1, d.start.sizeY ?? def.y) * ratio,
                  MIN_COLLIDER_SIZE,
                  MAX_COLLIDER_SIZE_Y,
                ),
              ),
            };
          }
        } else {
          const key = d.axis === 'x' ? 'scaleX' : d.axis === 'z' ? 'scaleZ' : 'scaleY';
          const startV =
            d.axis === 'x'
              ? (d.start.scaleX ?? 1)
              : d.axis === 'z'
                ? (d.start.scaleZ ?? 1)
                : (d.start.scaleY ?? 1);
          change = { [key]: round2(clamp(startV * ratio, MIN_AXIS_SCALE, MAX_AXIS_SCALE)) };
        }
      }
    }
    if (change) this.hooks.onGizmoChange(change);
  }

  // ---- collider volumes (editor-only overlay) ---------------------------------

  /** The overlay volume for a placement index, or null when the placement is
   *  not a collider. Ignores the collide flag so an authored volume can never
   *  become invisible AND unpickable at once. */
  private colliderVolumeAt(index: number): ColliderVolume | null {
    const p = this.map.placements[index];
    if (!p || p.hidden) return null;
    return colliderVolumeFromPlacement({ ...p, collide: true });
  }

  /** Full overlay rebuild from this.map.placements (add/remove/undo/load). */
  refreshColliderVolumes(): void {
    if (!this.visible) {
      this.hiddenColliders = true;
      return;
    }
    if (!this.renderer) return;
    this.disposeColliderVolumes();
    const group = new THREE.Group();
    group.name = 'editor-collider-volumes';
    for (let i = 0; i < this.map.placements.length; i++) {
      const v = this.colliderVolumeAt(i);
      if (!v) continue;
      const mesh = this.colliderVolumeMesh(v, i === this.selectedIndex, this.map.placements[i]);
      this.colliderMeshes.set(i, mesh);
      group.add(mesh);
    }
    group.visible = !this.collidersUserHidden;
    this.collidersGroup = group;
    this.renderer.scene.add(group);
  }

  /** Show/hide the green collider overlays without rebuilding them (Collider
   *  tab toggle). Playtest collision is unaffected; this is editor chrome. */
  setCollidersHidden(hidden: boolean): void {
    this.collidersUserHidden = hidden;
    if (this.collidersGroup) this.collidersGroup.visible = !hidden;
  }

  /** Refresh ONE overlay mesh after a live transform/size edit at `index`. */
  private updateColliderVolume(index: number): void {
    if (!this.renderer || !this.collidersGroup) return;
    const old = this.colliderMeshes.get(index);
    const v = this.colliderVolumeAt(index);
    if (old) {
      this.collidersGroup.remove(old);
      old.geometry.dispose();
      this.colliderMeshes.delete(index);
    }
    if (!v) return;
    const mesh = this.colliderVolumeMesh(
      v,
      index === this.selectedIndex,
      this.map.placements[index],
    );
    this.colliderMeshes.set(index, mesh);
    this.collidersGroup.add(mesh);
  }

  private colliderVolumeMesh(v: ColliderVolume, selected: boolean, p: AssetPlacement): THREE.Mesh {
    // Detached collider overlays float at their frozen ground; every kind adds the
    // shared vertical offset so a lifted wall/box/sphere overlay tracks the gizmo.
    const ground = p.detached ? (p.groundY ?? 0) : terrainHeight(v.x, v.z, this.seed);
    const yOff = p.y ?? 0;
    let geo: THREE.BufferGeometry;
    let y: number;
    if (v.kind === 'sphere') {
      geo = new THREE.SphereGeometry(v.sizeX / 2, 20, 14);
      y = ground + yOff + v.sizeX / 2;
    } else if (v.kind === 'plane') {
      geo = new THREE.BoxGeometry(v.sizeX, 0.12, v.sizeZ);
      y = ground + yOff + v.sizeY + 0.06;
    } else {
      geo = new THREE.BoxGeometry(v.sizeX, v.sizeY, v.sizeZ);
      y = ground + yOff + v.sizeY / 2;
    }
    const mesh = new THREE.Mesh(geo, selected ? this.colliderSelMat : this.colliderMat);
    mesh.position.set(v.x, y, v.z);
    // Euler 'XYZ' (three default), the same composition groundHeight() uses to
    // walk a tilted plane; boxes/spheres never carry rotX/rotZ.
    mesh.rotation.set(v.rotX ?? 0, v.rotY, v.rotZ ?? 0);
    mesh.renderOrder = 2;
    return mesh;
  }

  private disposeColliderVolumes(): void {
    if (this.collidersGroup) {
      this.renderer?.scene.remove(this.collidersGroup);
      for (const child of this.collidersGroup.children) {
        (child as THREE.Mesh).geometry.dispose();
      }
      this.collidersGroup = null;
    }
    this.colliderMeshes.clear();
  }

  // Swap to a different document (load/new/import) without leaking: rebuild the
  // Sim+Renderer since spawns come from the map (and the GL context is replaced).
  // Bumping the generation first abandons any start() still awaiting assets, so
  // a reload during boot can never leave two engines running.
  async reload(map: CustomMap): Promise<void> {
    this.generation++;
    this.map = map;
    this.detachEvents();
    this.teardownEngine();
    await this.start();
  }

  /**
   * Show/hide the viewport. Hidden: the render loop stops (no rAF pending) and
   * the edit passthroughs record dirty flags instead of doing GPU work. Shown:
   * flush the coalesced work, then resume the loop.
   */
  setVisible(v: boolean): void {
    this.parent.style.display = v ? '' : 'none';
    if (v === this.visible) return;
    this.visible = v;
    if (!v) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      return;
    }
    this.flushHiddenWork();
    if (this.renderer) {
      this.lastT = performance.now();
      this.loop();
    }
  }

  /** Apply the edits coalesced while hidden (called on becoming visible). */
  private flushHiddenWork(): void {
    if (!this.renderer) {
      // start() is still pending; it builds from the full document and clears
      // these flags itself.
      return;
    }
    if (this.hiddenTerrainFull) {
      this.hiddenTerrainFull = false;
      this.hiddenTerrainRegion = null;
      this.hiddenWater = false;
      this.hiddenSpawn = false;
      this.rebuildTerrainFull(); // terrain + water + full reSeat + spawn ring
    } else if (this.hiddenTerrainRegion) {
      const region = this.hiddenTerrainRegion;
      this.hiddenTerrainRegion = null;
      this.hiddenSpawn = false;
      this.renderer.rebuildTerrain(region);
      this.renderer.rebakeTerrainNormals(region);
      this.renderer.placedAssets.reSeat(region);
      this.refreshSpawnRing();
    }
    if (this.hiddenWater) {
      this.hiddenWater = false;
      this.renderer.rebuildWater();
    }
    if (this.hiddenPlacements) {
      this.hiddenPlacements = false;
      this.renderer.placedAssets.rebuildAll(
        placementsToRenderAssets(this.map.placements, { hideHidden: true }),
      );
      this.renderer.placedAssets.setSelected(this.selectedIndex);
      this.hiddenColliders = true;
    }
    if (this.hiddenSpawn) {
      this.hiddenSpawn = false;
      this.refreshSpawnRing();
    }
    if (this.hiddenBlockers) {
      this.hiddenBlockers = false;
      this.rebuildBlockers();
    }
    if (this.hiddenColliders) {
      this.hiddenColliders = false;
      this.refreshColliderVolumes();
    }
  }

  private clearHiddenWork(): void {
    this.hiddenTerrainFull = false;
    this.hiddenTerrainRegion = null;
    this.hiddenWater = false;
    this.hiddenPlacements = false;
    this.hiddenSpawn = false;
    this.hiddenBlockers = false;
    this.hiddenColliders = false;
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    cancelAnimationFrame(this.raf);
    this.detachEvents();
    this.teardownEngine();
    this.perfOverlay?.dispose();
    this.perfOverlay = null;
  }

  // Free the GL context and remove the surfaces. A fresh canvas is needed for a
  // later start() because forceContextLoss() permanently kills this context.
  private teardownEngine(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.renderer) {
      try {
        this.renderer.editorCam = null;
        this.renderer.webgl.setAnimationLoop(null);
        this.renderer.webgl.dispose();
        this.renderer.webgl.forceContextLoss();
      } catch {
        // GL teardown is best-effort.
      }
    }
    this.renderer = null;
    this.sim = null;
    this.spawnRing = null;
    // The scene died with the GL context; just drop the overlay handles.
    this.blockersGroup = null;
    this.blockerPreviewMesh = null;
    this.collidersGroup = null;
    this.colliderMeshes.clear();
    this.multiSelGroup = null;
    this.gizmo?.dispose();
    this.gizmo = null;
    this.gizmoDrag = null;
    this.grabFollow = false;
    this.canvas?.remove();
    this.nameplates?.remove();
  }

  // ---- loop ---------------------------------------------------------------

  private loop = (): void => {
    this.raf = 0;
    if (this.disposed || !this.visible || !this.renderer || !this.sim) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastT) / 1000);
    this.lastT = now;

    this.applyKeys(dt);
    // The camera ignores the terrain entirely (Blender-style): the pivot and
    // the camera may pass through or under the ground freely.
    const ground = terrainHeight(this.cam.target.x, this.cam.target.z, this.seed);
    // Teleport the frozen player (hidden below) to the ground under the camera
    // target so foliage/critter LOD stays populated under the cursor (the
    // renderer re-centers dressing on the player).
    const player = this.sim.player;
    if (player) {
      player.pos.x = this.cam.target.x;
      player.pos.z = this.cam.target.z;
      player.pos.y = ground;
    }
    this.renderer.editorCam = this.cam.pose();
    this.syncGizmo();
    // Wireframe applies to freshly added/rebuilt meshes too, so re-run each frame
    // while on, plus once more after it turns off to reset shared materials.
    if (this.wireframe || this.wireframeWasOn) {
      this.applyWireframe();
      this.wireframeWasOn = this.wireframe;
    }
    this.renderer.sync(1, DT, null);
    this.updatePerfOverlay(dt);
    // The player is an LOD anchor, not editable content. sync() force-shows
    // the self view every frame (visible = true), so hiding it means keeping
    // its group DETACHED from the scene; the toggle re-attaches it.
    if (player) {
      const view = this.renderer.views.get(player.id);
      if (view) {
        if (this.showPlayer) {
          if (!view.group.parent) this.renderer.scene.add(view.group);
        } else if (view.group.parent) {
          view.group.parent.remove(view.group);
        }
      }
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  /** Feed the perf overlay a smoothed stats snapshot (throttled to ~6 Hz so the
   *  numbers are readable). Draw calls / triangles come from the WebGLRenderer's
   *  render info for the frame we just drew. */
  private updatePerfOverlay(dt: number): void {
    const overlay = this.perfOverlay;
    if (!overlay || !overlay.enabled || !this.renderer) return;
    // Exponential smoothing on frame time (ms) so FPS is not jittery.
    const frameMs = dt * 1000;
    this.perfMsSmoothed =
      this.perfMsSmoothed === 0
        ? frameMs
        : this.perfMsSmoothed + (frameMs - this.perfMsSmoothed) * 0.1;
    this.perfUpdateAccum += dt;
    if (this.perfUpdateAccum < 1 / 6) return;
    this.perfUpdateAccum = 0;
    overlay.update({
      fps: this.perfMsSmoothed > 0 ? 1000 / this.perfMsSmoothed : 0,
      frameMs: this.perfMsSmoothed,
      assets: this.map.placements.length,
      terrain: this.map.terrainEdits.length,
    });
  }

  private applyKeys(dt: number): void {
    // Fly while a navigation drag is held, or any time in Free-Fly mode: the
    // single-key tool shortcuts own these keys otherwise (see capturesKey).
    if (!this.isNavigating() && !this.freeFly) return;
    const f = (this.keys.has('w') ? 1 : 0) - (this.keys.has('s') ? 1 : 0);
    const r = (this.keys.has('d') ? 1 : 0) - (this.keys.has('a') ? 1 : 0);
    const u = (this.keys.has('e') ? 1 : 0) - (this.keys.has('q') ? 1 : 0);
    if (f || r || u) this.cam.fly(f, r, u, dt);
  }

  // ---- input --------------------------------------------------------------

  private attachEvents(): void {
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    window.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this.onContext);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  private detachEvents(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('contextmenu', this.onContext);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.marquee = null;
    this.updateMarqueeEl();
  }

  private onContext = (e: Event): void => e.preventDefault();

  private onPointerDown = (ev: PointerEvent): void => {
    this.lastPointer = { x: ev.clientX, y: ev.clientY };
    this.dragDist = 0;
    // A Shift+D grab in flight: the next left press confirms where the copies
    // landed (before any navigation/tool routing).
    if (this.grabFollow && ev.button === 0) {
      this.cancelGrabFollow();
      this.hooks.onPlacementDragEnd();
      return;
    }
    // Blender navigation takes precedence over EVERY tool: Shift+drag pans and
    // middle-drag / Alt+drag orbits no matter what is active, so moving around
    // the map never requires leaving the current tool. One exception: the
    // sculpt tools claim Shift+LEFT-drag as the inverted stroke (raise<->lower,
    // smooth<->flatten); Shift with any other button still pans.
    if (ev.shiftKey) {
      const shiftEdit = ev.button === 0 && this.hooks.toolActive() && this.hooks.shiftEditsTool();
      if (!shiftEdit) {
        this.dragMode = 'pan';
        this.canvas.setPointerCapture(ev.pointerId);
        return;
      }
    }
    if (ev.button === 1 || (ev.button === 0 && ev.altKey)) {
      this.dragMode = 'orbit';
      this.canvas.setPointerCapture(ev.pointerId);
      return;
    }
    // The gizmo owns its handles outright: a left-press on one starts an
    // axis-constrained transform drag before the tool routing.
    if (ev.button === 0 && this.gizmo?.group.visible) {
      const axis = this.gizmoPick(ev.clientX, ev.clientY);
      if (axis !== null && this.beginGizmoDrag(axis, ev.clientX, ev.clientY)) {
        this.canvas.setPointerCapture(ev.pointerId);
        return;
      }
    }
    const wantsEdit = ev.button === 0 && this.hooks.toolActive();
    if (wantsEdit) {
      const w = this.surfaceAt(ev.clientX, ev.clientY);
      if (w) {
        this.dragMode = 'edit';
        this.hooks.onEditStart(w, ev);
        this.canvas.setPointerCapture(ev.pointerId);
        return;
      }
    }
    // Ctrl+left-drag in Select mode: marquee box select over the placements.
    if (ev.button === 0 && ev.ctrlKey && !this.hooks.toolActive()) {
      this.dragMode = 'marquee';
      this.marquee = { x0: ev.clientX, y0: ev.clientY, x1: ev.clientX, y1: ev.clientY };
      this.updateMarqueeEl();
      this.canvas.setPointerCapture(ev.pointerId);
      return;
    }
    // Select-mode direct move: a left press on a pickable placement DEFERS —
    // it only becomes a move once the pointer moves past the tap threshold
    // (onPointerMove). A stationary release stays a tap so repeated clicks cycle
    // through overlapping objects (onPointerUp). Empty ground orbits as before.
    if (ev.button === 0 && !this.hooks.toolActive() && this.hooks.placementDragEnabled()) {
      const idx = this.pickPlacement(ev.clientX, ev.clientY);
      if (idx !== null) {
        this.pendingPlaceIdx = idx;
        this.dragMode = 'placepending';
        this.canvas.setPointerCapture(ev.pointerId);
        return;
      }
    }
    // Everything else orbits (left-drag on empty ground in Select, right-drag).
    this.dragMode = 'orbit';
    this.canvas.setPointerCapture(ev.pointerId);
  };

  private onPointerMove = (ev: PointerEvent): void => {
    const dx = ev.clientX - this.lastPointer.x;
    const dy = ev.clientY - this.lastPointer.y;
    this.lastPointer = { x: ev.clientX, y: ev.clientY };
    this.dragDist += Math.abs(dx) + Math.abs(dy);
    if (this.dragMode === 'orbit') {
      if (this.freeFly) this.cam.look(dx, dy);
      else this.cam.orbit(dx, dy);
    } else if (this.dragMode === 'pan') this.cam.pan(dx, dy);
    else if (this.dragMode === 'edit') {
      // Sculpting tanks the frame rate, so queued pointermoves can arrive
      // AFTER the physical button release: without this gate the brush "fires
      // again" at the release point. buttons === 0 means the press is over.
      if (ev.buttons === 0) return;
      const w = this.surfaceAt(ev.clientX, ev.clientY);
      if (w) this.hooks.onEditMove(w, ev);
    } else if (this.dragMode === 'gizmo') {
      this.updateGizmoDrag(ev.clientX, ev.clientY);
    } else if (this.dragMode === 'marquee') {
      if (this.marquee) {
        this.marquee.x1 = ev.clientX;
        this.marquee.y1 = ev.clientY;
        this.updateMarqueeEl();
      }
    } else if (this.dragMode === 'placepending') {
      // Promote a deferred placement press to an actual move once it passes the
      // tap threshold; the app claims it (selecting the placement) and we stream
      // the ground point from here on.
      if (this.dragDist > TAP_SLOP_PX && this.pendingPlaceIdx !== null) {
        const idx = this.pendingPlaceIdx;
        this.pendingPlaceIdx = null;
        if (this.hooks.onPlacementDragStart(idx)) {
          this.dragMode = 'moveplacement';
          this.canvas.style.cursor = 'grabbing';
          const w = this.surfaceAt(ev.clientX, ev.clientY);
          if (w) this.hooks.onPlacementDragMove(w);
        } else {
          this.dragMode = 'orbit';
        }
      }
    } else if (this.dragMode === 'moveplacement') {
      const w = this.surfaceAt(ev.clientX, ev.clientY);
      if (w) this.hooks.onPlacementDragMove(w);
    } else if (this.grabFollow) {
      // Shift+D grab: the duplicates chase the cursor with no button held.
      const w = this.surfaceAt(ev.clientX, ev.clientY);
      if (w) this.hooks.onPlacementDragMove(w);
    } else {
      this.hooks.onHover(this.surfaceAt(ev.clientX, ev.clientY));
      this.updateHoverCursor(ev.clientX, ev.clientY);
    }
  };

  /** Grab-cursor feedback over pickable placements (Select mode, throttled). */
  private updateHoverCursor(clientX: number, clientY: number): void {
    if (!this.hooks.placementDragEnabled()) {
      if (this.canvas.style.cursor) this.canvas.style.cursor = '';
      return;
    }
    const now = performance.now();
    if (now - this.lastHoverPickAt < HOVER_PICK_MS) return;
    this.lastHoverPickAt = now;
    const want = this.pickPlacement(clientX, clientY) !== null ? 'grab' : '';
    if (this.canvas.style.cursor !== want) this.canvas.style.cursor = want;
  }

  private onPointerLeave = (): void => {
    if (this.dragMode === 'none') this.hooks.onHover(null);
  };

  private onPointerUp = (ev: PointerEvent): void => {
    if (this.dragMode === 'marquee') {
      this.hooks.onBoxSelect(this.placementsInMarquee());
      this.marquee = null;
      this.updateMarqueeEl();
    } else if (this.dragMode === 'gizmo') {
      this.gizmoDrag = null;
      this.hooks.onGizmoEnd();
    } else if (this.dragMode === 'edit') {
      this.hooks.onEditEnd(ev);
    } else if (this.dragMode === 'moveplacement') {
      this.hooks.onPlacementDragEnd();
      // The pointer is usually still over the moved placement.
      this.canvas.style.cursor = this.hooks.placementDragEnabled() ? 'grab' : '';
    } else if (this.dragMode === 'placepending' && ev.button === 0) {
      // A press on a placement that never moved past the tap threshold: a
      // Select-mode tap. Route through onTap so repeated clicks on overlapping
      // objects cycle the selection.
      this.pendingPlaceIdx = null;
      this.hooks.onTap(ev.clientX, ev.clientY, this.surfaceAt(ev.clientX, ev.clientY), false);
    } else if (
      (this.dragMode === 'orbit' || this.dragMode === 'pan') &&
      ev.button === 0 &&
      this.dragDist <= TAP_SLOP_PX
    ) {
      // A left tap with no edit tool armed: a Select-mode pick. A tap that
      // began as Shift+drag pan (additive) extends the selection instead.
      this.hooks.onTap(
        ev.clientX,
        ev.clientY,
        this.surfaceAt(ev.clientX, ev.clientY),
        this.dragMode === 'pan',
      );
    }
    this.dragMode = 'none';
  };

  private onWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    // Some platforms report Shift+wheel as a horizontal delta.
    const delta = ev.deltaY !== 0 ? ev.deltaY : ev.deltaX;
    if (delta === 0) return;
    if (
      (ev.shiftKey || ev.altKey) &&
      this.hooks.onTransformWheel(ev.altKey ? 'scale' : 'rotate', delta)
    ) {
      return;
    }
    this.cam.zoom(delta);
  };

  private onKeyDown = (ev: KeyboardEvent): void => {
    // Typing in a field must never start the camera moving (Free-Fly listens
    // even with no drag held).
    const target = ev.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
    ) {
      return;
    }
    const k = ev.key.toLowerCase();
    // Shifted keys are commands (Shift+D duplicates, Shift+F toggles fly),
    // never camera movement; pressing Shift mid-flight also stops the held
    // keys so Shift+D can never strafe the camera while duplicating.
    if (ev.shiftKey) {
      this.keys.clear();
      return;
    }
    if ('wasdqe'.includes(k)) this.keys.add(k);
  };

  private onKeyUp = (ev: KeyboardEvent): void => {
    this.keys.delete(ev.key.toLowerCase());
  };
}
