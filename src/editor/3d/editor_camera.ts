// Free/orbit editor camera for the 3D map editor, tuned to feel like Blender's
// viewport: turntable orbit around a free pivot with a near-full pitch range
// (look up from under the world to almost straight down), view-plane panning
// that grabs the world 1:1, and a wide dolly range. Terrain-agnostic BY DESIGN:
// nothing clamps the pivot or the camera to the ground. Hand-rolled (not
// OrbitControls) so it never fights the Renderer's own camera writes.

import * as THREE from 'three';

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export class EditorCamera {
  // The orbit pivot; free-floating in all three axes.
  target = new THREE.Vector3(0, 0, 0);
  yaw = Math.PI; // azimuth (matches the game's default behind-the-player yaw)
  pitch = 0.62; // elevation, radians; negative looks up from below the pivot
  dist = 70;

  /** Drag-pan direction preference (Invert pan setting). Default (false) is
   *  Blender-style grab: the world follows the cursor. */
  panInverted = false;

  /** Per-user speed multipliers (Camera tab sliders), 1 = the shipped feel.
   *  moveSpeed scales WASD/QE fly, lookSpeed scales orbit + mouse-look,
   *  panSpeedMul scales drag-pan. */
  moveSpeed = 1;
  lookSpeed = 1;
  panSpeedMul = 1;

  // Turntable limits just short of the poles (no flip), Blender-style: the
  // camera may dive below the horizon and look up at the world.
  private readonly minPitch = -1.52;
  private readonly maxPitch = 1.52;
  private readonly minDist = 1;
  private readonly maxDist = 600;

  // Reused output for pose(): called once per frame, so no per-frame Vector3
  // allocations. The renderer copies the vectors immediately (sync()).
  private readonly poseOut = { pos: new THREE.Vector3(), target: new THREE.Vector3() };

  /** The camera pose to hand to Renderer.editorCam: orbit position around the
   *  pivot, looking straight at it (no height offset). */
  pose(): { pos: THREE.Vector3; target: THREE.Vector3 } {
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    this.poseOut.pos.set(
      this.target.x - Math.sin(this.yaw) * cp * this.dist,
      this.target.y + sp * this.dist,
      this.target.z - Math.cos(this.yaw) * cp * this.dist,
    );
    this.poseOut.target.copy(this.target);
    return this.poseOut;
  }

  orbit(dxPx: number, dyPx: number): void {
    // "Invert camera": the one preference flips every drag-driven camera
    // motion (orbit here, look and pan below), not just panning.
    const flip = this.panInverted ? -1 : 1;
    const s = 0.005 * this.lookSpeed;
    this.yaw -= dxPx * s * flip;
    this.pitch = clamp(this.pitch + dyPx * s * flip, this.minPitch, this.maxPitch);
  }

  zoom(deltaY: number): void {
    this.dist = clamp(this.dist * Math.exp(deltaY * 0.0015), this.minDist, this.maxDist);
  }

  /**
   * First-person mouse-look (Free-Fly mode): rotate the VIEW around the fixed
   * camera position instead of orbiting around the target. Implemented by
   * updating yaw/pitch and then re-deriving the target so the pose()-derived
   * camera position stays exactly where it was.
   */
  look(dxPx: number, dyPx: number): void {
    const flip = this.panInverted ? -1 : 1;
    const cp0 = Math.cos(this.pitch);
    const px = this.target.x - Math.sin(this.yaw) * cp0 * this.dist;
    const py = this.target.y + Math.sin(this.pitch) * this.dist;
    const pz = this.target.z - Math.cos(this.yaw) * cp0 * this.dist;
    const s = 0.003 * this.lookSpeed;
    this.yaw += dxPx * s * flip;
    this.pitch = clamp(this.pitch + dyPx * s * flip, this.minPitch, this.maxPitch);
    const cp = Math.cos(this.pitch);
    this.target.set(
      px + Math.sin(this.yaw) * cp * this.dist,
      py - Math.sin(this.pitch) * this.dist,
      pz + Math.cos(this.yaw) * cp * this.dist,
    );
  }

  /**
   * Blender-style view-plane pan (screen-pixel delta): the pivot moves along
   * the camera's OWN right and up axes (including their vertical component
   * when pitched), scaled so the grabbed world point tracks the cursor about
   * 1:1 at the pivot's depth. Default is grab (the world follows the cursor);
   * panInverted flips to camera-follows-cursor.
   */
  pan(dxPxIn: number, dyPxIn: number): void {
    const flip = this.panInverted ? -1 : 1;
    const dxPx = dxPxIn * flip;
    const dyPx = dyPxIn * flip;
    const k = this.dist * 0.00135 * this.panSpeedMul;
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    const sp = Math.sin(this.pitch);
    const cp = Math.cos(this.pitch);
    // Camera basis: screen-right and screen-up in world space.
    const rx = -cy;
    const rz = sy;
    const ux = sy * sp;
    const uy = cp;
    const uz = cy * sp;
    this.target.x += (-dxPx * rx + dyPx * ux) * k;
    this.target.y += dyPx * uy * k;
    this.target.z += (-dxPx * rz + dyPx * uz) * k;
  }

  /**
   * Free-Fly WASD/QE (`dt` seconds): W/S move along the full VIEW direction
   * (including its vertical component, like Blender's fly), A/D strafe
   * horizontally, Q/E move straight down/up.
   */
  fly(forward: number, right: number, up: number, dt: number): void {
    const speed = this.dist * dt * 1.4 * this.moveSpeed;
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const fx = Math.sin(this.yaw) * cp;
    const fy = -sp;
    const fz = Math.cos(this.yaw) * cp;
    // Screen-right of the camera basis (D strafes right, A strafes left).
    const rx = -Math.cos(this.yaw);
    const rz = Math.sin(this.yaw);
    this.target.x += (forward * fx + right * rx) * speed;
    this.target.y += (forward * fy + up) * speed;
    this.target.z += (forward * fz + right * rz) * speed;
  }
}
