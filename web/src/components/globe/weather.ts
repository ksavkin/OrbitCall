import * as THREE from "three";
import type { CurrentsGrid, SpaceWeather, Storm, TornadoData, WindGrid } from "@/lib/weather/types";

// Weather layers drawn in the Earth-fixed frame (children of the rotating globe).

const D2R = Math.PI / 180;

/** Unit vector in the globe's local frame (matches THREE.SphereGeometry UVs). */
export function llToVec(latDeg: number, lonDeg: number, r = 1, out = new THREE.Vector3()) {
  const lat = latDeg * D2R;
  const lon = lonDeg * D2R;
  return out.set(Math.cos(lat) * Math.cos(lon) * r, Math.sin(lat) * r, -Math.cos(lat) * Math.sin(lon) * r);
}

type Sampler = (lat: number, lon: number) => [number, number] | null;

export function windSampler(g: WindGrid): Sampler {
  return (lat, lon) => {
    const x = ((((lon - g.lon0) % 360) + 360) % 360) / g.step;
    const y = (lat - g.lat0) / g.step;
    const i0 = Math.floor(x);
    const j0 = Math.min(Math.max(Math.floor(y), 0), g.ny - 2);
    const fx = x - i0;
    const fy = Math.min(Math.max(y - j0, 0), 1);
    const i1 = (i0 + 1) % g.nx;
    const k00 = j0 * g.nx + (i0 % g.nx);
    const k10 = j0 * g.nx + i1;
    const k01 = (j0 + 1) * g.nx + (i0 % g.nx);
    const k11 = (j0 + 1) * g.nx + i1;
    const lerp2 = (a: number[]) =>
      (a[k00] * (1 - fx) + a[k10] * fx) * (1 - fy) + (a[k01] * (1 - fx) + a[k11] * fx) * fy;
    return [lerp2(g.u), lerp2(g.v)];
  };
}

/** Currents come on ocean points only; land cells stay empty so particles never cross coasts. */
export function currentsSampler(c: CurrentsGrid): Sampler {
  const nx = 360 / c.step;
  const ny = 180 / c.step + 1;
  const u = new Float32Array(nx * ny).fill(NaN);
  const v = new Float32Array(nx * ny).fill(NaN);
  for (const [lat, lon, uu, vv] of c.points) {
    const j = Math.round((lat + 90) / c.step);
    const i = Math.round((lon + 180) / c.step) % nx;
    u[j * nx + i] = uu;
    v[j * nx + i] = vv;
  }
  return (lat, lon) => {
    const x = (((lon + 180) % 360) + 360) % 360 / c.step;
    const y = (lat + 90) / c.step;
    const i0 = Math.floor(x);
    const j0 = Math.floor(y);
    const fx = x - i0;
    const fy = y - j0;
    let su = 0;
    let sv = 0;
    let sw = 0;
    for (const [di, dj, w] of [
      [0, 0, (1 - fx) * (1 - fy)],
      [1, 0, fx * (1 - fy)],
      [0, 1, (1 - fx) * fy],
      [1, 1, fx * fy],
    ] as const) {
      const j = j0 + dj;
      if (j < 0 || j >= ny) continue;
      const k = j * nx + ((i0 + di) % nx);
      if (Number.isNaN(u[k])) continue;
      su += u[k] * w;
      sv += v[k] * w;
      sw += w;
    }
    // need most of the cell to be ocean, otherwise treat as coast/land
    if (sw < 0.55) return null;
    return [su / sw, sv / sw];
  };
}

/* ----------------------------------------------------------- particles */

const flowVertex = /* glsl */ `
  attribute float aAlpha;
  attribute vec3 aColor;
  varying float vAlpha;
  varying vec3 vColor;
  varying vec3 vWorld;
  void main() {
    vAlpha = aAlpha;
    vColor = aColor;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const flowFragment = /* glsl */ `
  uniform float uOpacity;
  uniform vec3 uCamPos;
  varying float vAlpha;
  varying vec3 vColor;
  varying vec3 vWorld;
  void main() {
    // fade toward the limb so the swarm doesn't pile up at the horizon
    vec3 n = normalize(vWorld);
    float facing = clamp(dot(n, normalize(uCamPos - vWorld)) * 2.5, 0.0, 1.0);
    gl_FragColor = vec4(vColor, min(vAlpha * 1.6, 1.0) * uOpacity * facing);
    #include <colorspace_fragment>
  }
`;

export interface FlowOptions {
  count: number;
  trail: number;
  /** degrees per second of animation per m/s of flow */
  gain: number;
  radius: number;
  maxSpeed: number; // m/s mapped to the top of the palette
  palette: [number, string][];
}

export class FlowLayer {
  readonly object: THREE.LineSegments;
  private o: FlowOptions;
  private sampler: Sampler | null = null;
  private lat: Float32Array;
  private lon: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private speed: Float32Array;
  private hist: Float32Array; // count × trail × 3
  private head: Uint16Array;
  private filled: Uint16Array;
  private acc = 0;
  private mat: THREE.ShaderMaterial;
  private paletteColors: { t: number; c: THREE.Color }[];

  constructor(o: FlowOptions) {
    this.o = o;
    const n = o.count;
    this.lat = new Float32Array(n);
    this.lon = new Float32Array(n);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.speed = new Float32Array(n);
    this.hist = new Float32Array(n * o.trail * 3);
    this.head = new Uint16Array(n);
    this.filled = new Uint16Array(n);
    this.paletteColors = o.palette.map(([t, c]) => ({ t, c: new THREE.Color(c) }));
    const segs = n * (o.trail - 1);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(segs * 2 * 3), 3));
    g.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(segs * 2), 1));
    g.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(segs * 2 * 3), 3));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: flowVertex,
      fragmentShader: flowFragment,
      uniforms: { uOpacity: { value: 0 }, uCamPos: { value: new THREE.Vector3() } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.object = new THREE.LineSegments(g, this.mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = 7;
    this.object.visible = false;
  }

  setField(sampler: Sampler) {
    this.sampler = sampler;
    for (let i = 0; i < this.o.count; i++) this.spawn(i, true);
  }

  private spawn(i: number, randomAge = false) {
    if (!this.sampler) return;
    for (let tries = 0; tries < 12; tries++) {
      // uniform on the sphere, within the data's latitude band
      const lat = Math.asin(Math.random() * 1.94 - 0.97) / D2R;
      const lon = Math.random() * 360 - 180;
      if (this.sampler(lat, lon)) {
        this.lat[i] = lat;
        this.lon[i] = lon;
        break;
      }
    }
    this.life[i] = 2.5 + Math.random() * 3.5;
    this.age[i] = randomAge ? Math.random() * this.life[i] : 0;
    this.filled[i] = 0;
    this.head[i] = 0;
    this.push(i);
  }

  private push(i: number) {
    const t = this.o.trail;
    const k = (i * t + this.head[i]) * 3;
    const lat = this.lat[i] * D2R;
    const lon = this.lon[i] * D2R;
    const r = this.o.radius;
    this.hist[k] = Math.cos(lat) * Math.cos(lon) * r;
    this.hist[k + 1] = Math.sin(lat) * r;
    this.hist[k + 2] = -Math.cos(lat) * Math.sin(lon) * r;
    this.head[i] = (this.head[i] + 1) % t;
    this.filled[i] = Math.min(this.filled[i] + 1, t);
  }

  private colorFor(s: number, out: THREE.Color) {
    const t = Math.min(s / this.o.maxSpeed, 1);
    const p = this.paletteColors;
    for (let k = 1; k < p.length; k++) {
      if (t <= p[k].t) return out.copy(p[k - 1].c).lerp(p[k].c, (t - p[k - 1].t) / (p[k].t - p[k - 1].t));
    }
    return out.copy(p[p.length - 1].c);
  }

  update(dt: number, visible: boolean, camWorld: THREE.Vector3) {
    const m = this.mat.uniforms;
    m.uOpacity.value += ((visible && this.sampler ? 1 : 0) - m.uOpacity.value) * Math.min(dt * 4, 1);
    this.object.visible = m.uOpacity.value > 0.01;
    if (!this.object.visible || !this.sampler) return;
    (m.uCamPos.value as THREE.Vector3).copy(camWorld);
    dt = Math.min(dt, 0.05);
    const n = this.o.count;
    for (let i = 0; i < n; i++) {
      this.age[i] += dt;
      const f = this.sampler(this.lat[i], this.lon[i]);
      if (!f || this.age[i] > this.life[i] || Math.abs(this.lat[i]) > 84) {
        this.spawn(i);
        continue;
      }
      const [u, v] = f;
      this.speed[i] = Math.hypot(u, v);
      this.lat[i] += v * this.o.gain * dt;
      this.lon[i] += (u * this.o.gain * dt) / Math.max(Math.cos(this.lat[i] * D2R), 0.15);
      if (this.lon[i] > 180) this.lon[i] -= 360;
      if (this.lon[i] < -180) this.lon[i] += 360;
    }
    // record trail points at ~30 Hz
    this.acc += dt;
    if (this.acc < 1 / 30) return;
    this.acc = 0;
    for (let i = 0; i < n; i++) this.push(i);
    this.rebuild();
  }

  private rebuild() {
    const g = this.object.geometry;
    const pos = g.getAttribute("position").array as Float32Array;
    const alpha = g.getAttribute("aAlpha").array as Float32Array;
    const col = g.getAttribute("aColor").array as Float32Array;
    const t = this.o.trail;
    const c = new THREE.Color();
    let w = 0;
    for (let i = 0; i < this.o.count; i++) {
      const life = this.age[i] / this.life[i];
      const lifeFade = Math.min(life * 5, 1) * Math.min((1 - life) * 4, 1);
      this.colorFor(this.speed[i], c);
      const filled = this.filled[i];
      for (let s = 0; s < t - 1; s++) {
        const ok = s + 1 < filled;
        // oldest → newest along the ring buffer
        const a = (this.head[i] + s) % t;
        const b = (this.head[i] + s + 1) % t;
        const ka = (i * t + a) * 3;
        const kb = (i * t + b) * 3;
        const fadeA = ok ? (s / (t - 1)) * lifeFade : 0;
        const fadeB = ok ? ((s + 1) / (t - 1)) * lifeFade : 0;
        pos[w * 3] = this.hist[ka];
        pos[w * 3 + 1] = this.hist[ka + 1];
        pos[w * 3 + 2] = this.hist[ka + 2];
        alpha[w] = fadeA;
        col[w * 3] = c.r;
        col[w * 3 + 1] = c.g;
        col[w * 3 + 2] = c.b;
        w++;
        pos[w * 3] = this.hist[kb];
        pos[w * 3 + 1] = this.hist[kb + 1];
        pos[w * 3 + 2] = this.hist[kb + 2];
        alpha[w] = fadeB;
        col[w * 3] = c.r;
        col[w * 3 + 1] = c.g;
        col[w * 3 + 2] = c.b;
        w++;
      }
    }
    g.getAttribute("position").needsUpdate = true;
    g.getAttribute("aAlpha").needsUpdate = true;
    g.getAttribute("aColor").needsUpdate = true;
  }
}

/* -------------------------------------------------------------- storms */

export const STORM_COLORS = ["#5ad1e6", "#f5c451", "#ff9f40", "#ff5a4f", "#ff3d8b", "#c084fc"];

/* ---------------------------------------------------------------- aurora */

const auroraFragment = /* glsl */ `
  uniform sampler2D uAurora;
  uniform vec3 uSunDir;
  uniform float uOpacity;
  varying vec2 vUv;
  varying vec3 vNormalW;
  void main() {
    float p = texture2D(uAurora, vUv).r;      // probability 0..1
    float night = smoothstep(0.05, -0.25, dot(normalize(vNormalW), uSunDir));
    // 557.7 nm green, with red (630 nm) where it is strongest
    vec3 col = mix(vec3(0.15, 1.0, 0.45), vec3(1.0, 0.25, 0.45), smoothstep(0.55, 0.95, p));
    float a = smoothstep(0.04, 0.5, p) * night * uOpacity;
    gl_FragColor = vec4(col * a, a);
    #include <colorspace_fragment>
  }
`;
const auroraVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
  }
`;

/* -------------------------------------------------------------- manager */

export class WeatherLayers {
  readonly group = new THREE.Group();
  readonly wind: FlowLayer;
  readonly currents: FlowLayer;
  private tornado = new THREE.Group();
  private aurora: THREE.Mesh;
  private auroraMat: THREE.ShaderMaterial;
  stormList: Storm[] = [];
  vis = { wind: false, currents: false, storms: true, tornado: true, aurora: true };

  constructor() {
    this.wind = new FlowLayer({
      count: 9000,
      trail: 12,
      gain: 0.32,
      radius: 1.0045,
      maxSpeed: 25,
      palette: [
        [0, "#7fb2ff"],
        [0.3, "#cfe3ff"],
        [0.55, "#ffffff"],
        [0.8, "#ffd166"],
        [1, "#ff6b5a"],
      ],
    });
    this.currents = new FlowLayer({
      count: 6000,
      trail: 12,
      gain: 7,
      radius: 1.002,
      maxSpeed: 1.2,
      palette: [
        [0, "#3fd0d8"],
        [0.4, "#8ff7ff"],
        [1, "#ffffff"],
      ],
    });
    this.group.add(this.wind.object, this.currents.object, this.tornado);

    this.auroraMat = new THREE.ShaderMaterial({
      vertexShader: auroraVertex,
      fragmentShader: auroraFragment,
      uniforms: { uAurora: { value: null }, uSunDir: { value: new THREE.Vector3(1, 0, 0) }, uOpacity: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    // auroral emission sits ~100–250 km up
    this.aurora = new THREE.Mesh(new THREE.SphereGeometry(1.018, 128, 64), this.auroraMat);
    this.aurora.renderOrder = 8;
    this.aurora.visible = false;
    this.group.add(this.aurora);
  }

  setWind(g: WindGrid) {
    this.wind.setField(windSampler(g));
  }

  setCurrents(c: CurrentsGrid) {
    this.currents.setField(currentsSampler(c));
  }

  /** Storms are drawn as HTML markers (StormLabels); the live IR clouds show the storm itself. */
  setStorms(list: Storm[]) {
    this.stormList = list;
  }

  setTornado(t: TornadoData) {
    for (const c of [...this.tornado.children]) {
      this.tornado.remove(c);
      (c as THREE.Line).geometry.dispose();
    }
    const red = new THREE.LineBasicMaterial({ color: 0xff5a4f, transparent: true, opacity: 0.95, depthWrite: false });
    const amber = new THREE.LineBasicMaterial({ color: 0xf5c451, transparent: true, opacity: 0.8, depthWrite: false });
    for (const w of t.warnings) {
      for (const ring of w.rings) {
        const pts = ring.map(([lon, lat]) => llToVec(lat, lon, 1.0025));
        const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), w.event === "Tornado Warning" ? red : amber);
        line.renderOrder = 9;
        this.tornado.add(line);
      }
    }
    if (t.reports.length) {
      const pts = t.reports.map((r) => llToVec(r.lat, r.lon, 1.003));
      const p = new THREE.Points(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.PointsMaterial({ color: 0xff5a4f, size: 7, sizeAttenuation: false, depthWrite: false }),
      );
      p.renderOrder = 9;
      this.tornado.add(p);
    }
  }

  setAurora(s: SpaceWeather) {
    const data = new Uint8Array(360 * 181 * 4);
    for (let k = 0; k < 360 * 181; k++) {
      const v = Math.min(255, Math.round((s.aurora[k] / 100) * 255 * 2.2));
      data[k * 4] = v;
      data[k * 4 + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, 360, 181, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    (this.auroraMat.uniforms.uAurora.value as THREE.Texture | null)?.dispose();
    this.auroraMat.uniforms.uAurora.value = tex;
  }

  update(dt: number, _timeS: number, sunDir: THREE.Vector3, camWorld: THREE.Vector3) {
    this.wind.update(dt, this.vis.wind, camWorld);
    this.currents.update(dt, this.vis.currents, camWorld);
    this.tornado.visible = this.vis.tornado;
    const a = this.auroraMat.uniforms;
    (a.uSunDir.value as THREE.Vector3).copy(sunDir);
    a.uOpacity.value += ((this.vis.aurora && a.uAurora.value ? 1 : 0) - a.uOpacity.value) * Math.min(dt * 3, 1);
    this.aurora.visible = a.uOpacity.value > 0.01;
  }
}
