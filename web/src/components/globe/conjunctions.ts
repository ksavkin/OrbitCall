import * as THREE from "three";
import type { Line2 } from "three/examples/jsm/lines/Line2.js";
import type { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { orbitPath, posB, toScene, type Encounter } from "@/lib/ops/encounter";
import type { ConjunctionEvent } from "@/lib/ops/types";
import { makeLine, setCenteredLine } from "./lines";
import type { ScreenPoint } from "./GlobeScene";

// Conjunctions on the globe: both orbits of the focused event, the synthetic objects,
// and the Risk Monitor's screening sweep. Everything here lives in the inertial frame,
// like the satellites, so the two orbits really cross at the TCA point.

export const RISK_COLORS: Record<ConjunctionEvent["risk"], string> = { red: "#ff5a4f", yellow: "#f5c451" };

export interface ConjItem {
  id: string;
  enc: Encounter;
  risk: ConjunctionEvent["risk"];
  aIndex: number | null;
  /** Resolved / closed events stay listed but dim on the globe. */
  quiet: boolean;
}

export interface ConjScreen {
  id: string;
  risk: ConjunctionEvent["risk"];
  quiet: boolean;
  focused: boolean;
  tca: ScreenPoint;
  a: ScreenPoint | null;
  b: ScreenPoint;
  /** Straight-line distance between A and B right now, km. */
  rangeKm: number;
}

const sweepVertex = /* glsl */ `
  varying vec3 vPos;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vPos = position;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vPosW = wp.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

// A band of light sweeping around the LEO shell with a fading trail and latitude ticks.
const sweepFragment = /* glsl */ `
  uniform float uAngle;
  uniform float uOn;
  uniform vec3 uColor;
  uniform vec3 uCamPos;
  varying vec3 vPos;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  const float TAU = 6.28318530718;
  void main() {
    float az = atan(vPos.z, vPos.x);
    float d = mod(uAngle - az, TAU);
    float trail = exp(-d * 2.6);
    float edge = exp(-d * 90.0) + exp(-(TAU - d) * 400.0);
    float lat = asin(clamp(vPos.y / length(vPos), -1.0, 1.0));
    float latFade = 1.0 - smoothstep(1.15, 1.42, abs(lat));
    // latitude ticks every 10° inside the trail only
    float k = lat / 0.17453;
    float tick = 1.0 - smoothstep(0.0, fwidth(k) * 1.2, abs(fract(k + 0.5) - 0.5));
    float rim = 1.0 - abs(dot(normalize(vNormalW), normalize(uCamPos - vPosW)));
    float a = (trail * (0.05 + 0.1 * tick) + edge * 0.5) * latFade * uOn * (0.45 + 0.55 * rim);
    if (a < 0.003) discard;
    gl_FragColor = vec4(uColor * a, a);
    #include <colorspace_fragment>
  }
`;

const bVertex = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  varying vec3 vColor;
  uniform float uPixelRatio;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPixelRatio;
    gl_Position = projectionMatrix * mv;
  }
`;

const bFragment = /* glsl */ `
  varying vec3 vColor;
  uniform float uTime;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float core = 1.0 - smoothstep(0.1, 0.16, d);
    float ring = (1.0 - smoothstep(0.02, 0.05, abs(d - 0.3))) * 0.55;
    float halo = exp(-d * d * 26.0) * (0.55 + 0.25 * sin(uTime * 4.0));
    float a = core + ring + halo;
    if (a < 0.01) discard;
    gl_FragColor = vec4(mix(vColor, vec3(1.0), core * 0.6), a);
    #include <colorspace_fragment>
  }
`;

export class ConjunctionLayer {
  readonly group = new THREE.Group();
  private items: ConjItem[] = [];
  private focused: string | null = null;
  private orbitA: Line2;
  private orbitB: Line2;
  private glowA: Line2;
  private glowB: Line2;
  private bPoints: THREE.Points;
  private bMat: THREE.ShaderMaterial;
  private sweep: THREE.Mesh;
  private sweepMat: THREE.ShaderMaterial;
  private scanTarget = 0;
  /** 0..1, eased; drives the sweep and the satellite highlight. */
  scanLevel = 0;
  scanAngle = 0;
  screen: ConjScreen[] = [];
  private v = new THREE.Vector3();
  private v2 = new THREE.Vector3();

  constructor(pixelRatio: number) {
    this.orbitA = makeLine(2, 1);
    this.orbitB = makeLine(2, 1);
    this.glowA = makeLine(7, 0.2);
    this.glowB = makeLine(7, 0.22);
    for (const l of [this.glowA, this.glowB, this.orbitA, this.orbitB]) l.renderOrder = 4;
    this.group.add(this.glowA, this.glowB, this.orbitA, this.orbitB);

    this.bMat = new THREE.ShaderMaterial({
      vertexShader: bVertex,
      fragmentShader: bFragment,
      uniforms: { uPixelRatio: { value: pixelRatio }, uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
    this.bPoints = new THREE.Points(g, this.bMat);
    this.bPoints.frustumCulled = false;
    this.bPoints.renderOrder = 7;
    this.group.add(this.bPoints);

    this.sweepMat = new THREE.ShaderMaterial({
      vertexShader: sweepVertex,
      fragmentShader: sweepFragment,
      uniforms: {
        uAngle: { value: 0 },
        uOn: { value: 0 },
        uColor: { value: new THREE.Color("#7fd8ff") },
        uCamPos: { value: new THREE.Vector3() },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    // ~550 km: the middle of the crowded LEO shell
    this.sweep = new THREE.Mesh(new THREE.SphereGeometry(1.086, 128, 64), this.sweepMat);
    this.sweep.renderOrder = 6;
    this.sweep.visible = false;
    this.group.add(this.sweep);
  }

  setItems(items: ConjItem[]) {
    this.items = items;
    const n = items.length;
    const g = this.bPoints.geometry;
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const c = new THREE.Color();
    items.forEach((it, k) => {
      c.set(it.quiet ? "#9aa3ad" : RISK_COLORS[it.risk]);
      c.toArray(col, k * 3);
      size[k] = it.quiet ? 16 : 26;
    });
    g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    if (this.focused && !items.some((i) => i.id === this.focused)) this.setFocus(null);
    else if (this.focused) this.drawOrbits();
  }

  setFocus(id: string | null) {
    this.focused = id;
    this.drawOrbits();
  }

  get focusId() {
    return this.focused;
  }

  item(id: string) {
    return this.items.find((i) => i.id === id) ?? null;
  }

  private drawOrbits() {
    const it = this.focused ? this.item(this.focused) : null;
    const lines = [this.orbitA, this.orbitB, this.glowA, this.glowB];
    if (!it) {
      lines.forEach((l) => (l.visible = false));
      return;
    }
    const a = orbitPath(it.enc, "a");
    const b = orbitPath(it.enc, "b");
    const risk = new THREE.Color(RISK_COLORS[it.risk]);
    const aCol = new THREE.Color("#9cc2ff");
    setCenteredLine(this.orbitA, a, new THREE.Color("#ffffff"), aCol, 0.16);
    setCenteredLine(this.glowA, a, aCol, aCol, 0.1);
    setCenteredLine(this.orbitB, b, new THREE.Color("#ffffff"), risk, 0.16);
    setCenteredLine(this.glowB, b, risk, risk, 0.1);
    lines.forEach((l) => (l.visible = true));
  }

  setScanning(on: boolean) {
    this.scanTarget = on ? 1 : 0;
  }

  setResolution(w: number, h: number) {
    for (const l of [this.orbitA, this.orbitB, this.glowA, this.glowB]) (l.material as LineMaterial).resolution.set(w, h);
  }

  /** TCA point of an event in scene units. */
  tcaPoint(id: string, out = new THREE.Vector3()) {
    const it = this.item(id);
    if (!it) return null;
    return toScene(it.enc.rA, out) as THREE.Vector3;
  }

  update(
    sim: number,
    dt: number,
    now: number,
    cam: THREE.Vector3,
    project: (p: THREE.Vector3) => ScreenPoint,
    positionOf: (i: number, out: THREE.Vector3) => THREE.Vector3 | null,
  ) {
    // sweep
    this.scanLevel += (this.scanTarget - this.scanLevel) * Math.min(dt * 2.5, 1);
    this.scanAngle = (this.scanAngle + dt * 1.15) % (Math.PI * 2);
    this.sweepMat.uniforms.uAngle.value = this.scanAngle;
    this.sweepMat.uniforms.uOn.value = this.scanLevel;
    (this.sweepMat.uniforms.uCamPos.value as THREE.Vector3).copy(cam);
    this.sweep.visible = this.scanLevel > 0.01;
    this.bMat.uniforms.uTime.value = now / 1000;

    // synthetic objects and screen anchors
    const pos = this.bPoints.geometry.getAttribute("position") as THREE.BufferAttribute;
    const out: ConjScreen[] = [];
    this.items.forEach((it, k) => {
      toScene(posB(it.enc, sim), this.v);
      pos.setXYZ(k, this.v.x, this.v.y, this.v.z);
      const b = project(this.v);
      let a: ScreenPoint | null = null;
      let rangeKm = 0;
      if (it.aIndex !== null) {
        const pa = positionOf(it.aIndex, this.v2);
        if (pa) {
          a = project(pa);
          rangeKm = pa.distanceTo(this.v) * 6378.135;
        }
      }
      const tca = project(toScene(it.enc.rA, this.v2) as THREE.Vector3);
      out.push({ id: it.id, risk: it.risk, quiet: it.quiet, focused: it.id === this.focused, tca, a, b, rangeKm });
    });
    pos.needsUpdate = true;
    this.screen = out;
  }
}
