import * as THREE from "three";
import { EARTH_RADIUS_KM } from "@/lib/orbit/constants";

// Orbital congestion computed from the live catalog positions:
// a ground heatmap of objects overhead and translucent shells at the busiest altitudes.

const W = 360; // 1° cells
const H = 180;

const heatVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vPosW = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
// Density as a thermal map: a smooth field through a 5-stop thermal ramp, transparent
// where traffic is background-level, with faint isolines so gradients read like a contour chart.
const heatFragment = /* glsl */ `
  uniform sampler2D uHeat;
  uniform float uOpacity;
  uniform vec3 uRamp[5];
  uniform vec3 uCamPos;
  uniform float uFloor;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  vec3 ramp(float t) {
    t = clamp(t, 0.0, 1.0) * 4.0;
    if (t < 1.0) return mix(uRamp[0], uRamp[1], t);
    if (t < 2.0) return mix(uRamp[1], uRamp[2], t - 1.0);
    if (t < 3.0) return mix(uRamp[2], uRamp[3], t - 2.0);
    return mix(uRamp[3], uRamp[4], t - 3.0);
  }
  void main() {
    float d = texture2D(uHeat, vUv).r;
    float body = smoothstep(uFloor, uFloor + 0.26, d); // only real hotspots; LEO traffic is everywhere at low levels
    if (body <= 0.0) discard;
    // isolines every 0.1 of the normalized density
    float k = d * 10.0;
    float w = fwidth(k);
    float iso = 1.0 - smoothstep(0.0, w * 1.5, abs(fract(k + 0.5) - 0.5));
    vec3 col = ramp((d - uFloor) / (1.0 - uFloor));
    col = mix(col, vec3(1.0), iso * 0.25 * body);
    float facing = clamp(dot(normalize(vNormalW), normalize(uCamPos - vPosW)) * 3.0, 0.0, 1.0);
    float a = (body * (0.3 + 0.4 * d) + iso * 0.2 * body) * uOpacity * facing;
    if (a < 0.01) discard;
    gl_FragColor = vec4(col, a);
    #include <colorspace_fragment>
  }
`;

const shellFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uCamPos;
  uniform float uOpacity;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    // rim-weighted so the shell reads as a ring around the planet, not a fog
    float f = 1.0 - abs(dot(normalize(vNormalW), normalize(uCamPos - vPosW)));
    float a = (0.03 + pow(f, 5.0) * 0.55) * uOpacity;
    gl_FragColor = vec4(uColor * a, a);
    #include <colorspace_fragment>
  }
`;

export interface AltitudeBin {
  fromKm: number;
  toKm: number;
  payload: number;
  debris: number;
}

class Heatmap {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private tex: THREE.DataTexture;
  private data = new Uint8Array(W * H * 4);
  private target = 0;
  private field: Float32Array | null = null;

  constructor(radius: number, ramp: string[], floor: number) {
    this.tex = new THREE.DataTexture(this.data, W, H, THREE.RGBAFormat);
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.wrapS = THREE.RepeatWrapping;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: heatVertex,
      fragmentShader: heatFragment,
      uniforms: {
        uHeat: { value: this.tex },
        uOpacity: { value: 0 },
        uRamp: { value: ramp.map((c) => new THREE.Color(c)) },
        uFloor: { value: floor },
        uCamPos: { value: new THREE.Vector3() },
      },
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 128, 64), this.mat);
    this.mesh.renderOrder = 6;
    this.mesh.visible = false;
  }

  /** counts: W×H grid of objects per cell (row 0 = south). Normalized by cell area. */
  set(counts: Float32Array) {
    // area-normalize (cells shrink toward the poles) and blur twice for a smooth field
    const dens = new Float32Array(W * H);
    for (let j = 0; j < H; j++) {
      const lat = ((j + 0.5) / H - 0.5) * Math.PI;
      const area = Math.max(Math.cos(lat), 0.05);
      for (let i = 0; i < W; i++) dens[j * W + i] = counts[j * W + i] / area;
    }
    // equal-area kernel: ~3° north-south, widened east-west toward the poles where cells shrink
    const R = 3;
    const blur = (src: Float32Array) => {
      const tmp = new Float32Array(W * H);
      for (let j = 0; j < H; j++) {
        const lat = ((j + 0.5) / H - 0.5) * Math.PI;
        const r = Math.min(Math.round(R / Math.max(Math.cos(lat), 0.08)), W / 2 - 1);
        for (let i = 0; i < W; i++) {
          let v = 0;
          for (let di = -r; di <= r; di++) v += src[j * W + ((i + di + W) % W)];
          tmp[j * W + i] = v / (2 * r + 1);
        }
      }
      const out = new Float32Array(W * H);
      for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
          let v = 0;
          let n = 0;
          for (let dj = -R; dj <= R; dj++) {
            const jj = j + dj;
            if (jj < 0 || jj >= H) continue;
            v += tmp[jj * W + i];
            n++;
          }
          out[j * W + i] = v / n;
        }
      }
      return out;
    };
    const fresh = blur(blur(dens));
    // snapshots are a few seconds apart; averaging them turns instantaneous positions
    // into the time-averaged orbital density and removes the speckle
    if (!this.field) this.field = fresh;
    else for (let k = 0; k < W * H; k++) this.field[k] += (fresh[k] - this.field[k]) * 0.2;
    const f = this.field;
    // robust max: 98th percentile, so one hotspot doesn't wash out the rest
    const sorted = f.slice().sort();
    const max = Math.max(sorted[Math.floor(sorted.length * 0.995)], 1e-6);
    for (let k = 0; k < W * H; k++) {
      this.data[k * 4] = Math.min(255, Math.round((f[k] / max) * 255));
      this.data[k * 4 + 3] = 255;
    }
    this.tex.needsUpdate = true;
  }

  update(dt: number, visible: boolean, cam: THREE.Vector3) {
    this.target = visible ? 1 : 0;
    const u = this.mat.uniforms;
    u.uOpacity.value += (this.target - u.uOpacity.value) * Math.min(dt * 4, 1);
    (u.uCamPos.value as THREE.Vector3).copy(cam);
    this.mesh.visible = u.uOpacity.value > 0.01;
  }
}

export class DensityLayers {
  /** Earth-fixed: heatmaps follow the ground. */
  readonly ground = new THREE.Group();
  /** Inertial: altitude shells are spherical, frame doesn't matter. */
  readonly shells = new THREE.Group();
  // thermal-camera ramp for traffic, a hotter ember ramp for debris so both read when stacked
  readonly traffic = new Heatmap(1.0035, ["#1b0c41", "#6a1b9a", "#e0365a", "#ff9f40", "#fff3b0"], 0.42);
  readonly debris = new Heatmap(1.004, ["#2a0505", "#8c1414", "#ff3b2f", "#ffb340", "#ffffff"], 0.2);
  private shellMeshes: THREE.Mesh[] = [];
  private shellOpacity = 0;
  vis = { traffic: false, debris: false };
  bins: AltitudeBin[] = [];
  top: AltitudeBin[] = [];

  constructor() {
    this.ground.add(this.traffic.mesh, this.debris.mesh);
  }

  /**
   * @param latlon sub-satellite points [lat, lon] in degrees for visible objects
   * @param isDebris parallel flags
   * @param altKm parallel altitudes
   */
  setSnapshot(latlon: Float32Array, isDebris: Uint8Array, altKm: Float32Array) {
    const n = isDebris.length;
    const all = new Float32Array(W * H);
    const deb = new Float32Array(W * H);
    const BIN = 25;
    const bins = new Map<number, AltitudeBin>();
    for (let k = 0; k < n; k++) {
      const lat = latlon[k * 2];
      const lon = latlon[k * 2 + 1];
      const j = Math.min(Math.floor(((lat + 90) / 180) * H), H - 1);
      const i = Math.min(Math.floor(((lon + 180) / 360) * W), W - 1);
      if (isDebris[k]) deb[j * W + i]++;
      else all[j * W + i]++;
      const a = altKm[k];
      if (a < 150 || a > 2000) continue; // LEO band only
      const b = Math.floor(a / BIN) * BIN;
      let bin = bins.get(b);
      if (!bin) bins.set(b, (bin = { fromKm: b, toKm: b + BIN, payload: 0, debris: 0 }));
      if (isDebris[k]) bin.debris++;
      else bin.payload++;
    }
    this.traffic.set(all);
    this.debris.set(deb);
    this.bins = [...bins.values()].sort((a, b) => a.fromKm - b.fromKm);
    this.updateShells();
  }

  private updateShells() {
    // the three busiest bands, kept at least 75 km apart so they read as separate shells
    const ranked = [...this.bins].sort((a, b) => b.payload + b.debris - (a.payload + a.debris));
    const top: AltitudeBin[] = [];
    for (const b of ranked) {
      if (top.every((t) => Math.abs(t.fromKm - b.fromKm) >= 75)) top.push(b);
      if (top.length === 3) break;
    }
    this.top = top;
    if (this.shellMeshes.length === 0) {
      for (let k = 0; k < 3; k++) {
        const m = new THREE.Mesh(
          new THREE.SphereGeometry(1, 96, 48),
          new THREE.ShaderMaterial({
            vertexShader: heatVertex,
            fragmentShader: shellFragment,
            uniforms: { uColor: { value: new THREE.Color() }, uCamPos: { value: new THREE.Vector3() }, uOpacity: { value: 0 } },
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        m.renderOrder = 6;
        m.visible = false;
        this.shellMeshes.push(m);
        this.shells.add(m);
      }
    }
    top.forEach((b, k) => {
      const m = this.shellMeshes[k];
      m.scale.setScalar(1 + (b.fromKm + 12.5) / EARTH_RADIUS_KM);
      const debrisShare = b.debris / Math.max(b.payload + b.debris, 1);
      (m.material as THREE.ShaderMaterial).uniforms.uColor.value.set(debrisShare > 0.35 ? "#ff7a6b" : "#8fb8ff");
    });
  }

  update(dt: number, cam: THREE.Vector3) {
    this.traffic.update(dt, this.vis.traffic, cam);
    this.debris.update(dt, this.vis.debris, cam);
    const on = this.vis.traffic || this.vis.debris;
    this.shellOpacity += ((on ? 1 : 0) - this.shellOpacity) * Math.min(dt * 4, 1);
    this.shellMeshes.forEach((m, k) => {
      const u = (m.material as THREE.ShaderMaterial).uniforms;
      u.uOpacity.value = this.shellOpacity * (k < this.top.length ? 1 : 0);
      (u.uCamPos.value as THREE.Vector3).copy(cam);
      m.visible = u.uOpacity.value > 0.01;
    });
  }
}
