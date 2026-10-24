import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { eciToGeodetic, gstime, jday, sunPos } from "satellite.js";
import type { Catalog } from "@/lib/catalog/client";
import { CATEGORIES, type Category } from "@/lib/catalog/types";
import { EARTH_RADIUS_KM, MU_EARTH } from "@/lib/orbit/constants";
import { CATEGORY_META } from "@/lib/theme";
import { debrisGeometry, satelliteGeometry } from "./models";
import { TileLayer } from "./tiles";
import { HeroSatellite } from "./hero";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import {
  atmosphereFragment,
  atmosphereVertex,
  cloudsFragment,
  dotFragment,
  dotVertex,
  earthFragment,
  earthVertex,
  satFragment,
  satVertex,
  simpleVertex,
  starsFragment,
  type ViewMode,
} from "./shaders";

const MU = MU_EARTH / EARTH_RADIUS_KM ** 3; // earth radii^3 / s^2
const TEX = "/textures/";

export interface ScreenPoint {
  x: number;
  y: number;
  visible: boolean;
}

export interface SatLive {
  lat: number;
  lon: number;
  altKm: number;
  speedKms: number;
  sunlit: boolean;
}

export interface SceneEvents {
  onHover?: (index: number | null) => void;
  onSelect?: (index: number | null) => void;
  onTrack?: (hover: ScreenPoint | null, selected: ScreenPoint | null) => void;
  onCamera?: (altKm: number) => void;
  onCursor?: (latlon: { lat: number; lon: number } | null) => void;
  onReady?: () => void;
  onStats?: (s: { propagateMs: number; invalid: number; total: number }) => void;
  onTexturesProgress?: (loaded: number, total: number) => void;
}

/* ---------------------------------------------------------------- clock */

class SimClock {
  private baseSim = Date.now();
  private basePerf = performance.now();
  speed = 1;
  paused = false;
  now() {
    if (this.paused) return this.baseSim;
    return this.baseSim + (performance.now() - this.basePerf) * this.speed;
  }
  private rebase() {
    this.baseSim = this.now();
    this.basePerf = performance.now();
  }
  setSpeed(s: number) {
    this.rebase();
    this.speed = s;
  }
  setPaused(p: boolean) {
    if (p === this.paused) return;
    if (p) {
      this.baseSim = this.now();
      this.paused = true;
    } else {
      this.paused = false;
      this.basePerf = performance.now();
    }
  }
  /** Jump back to real time. */
  live() {
    this.baseSim = Date.now();
    this.basePerf = performance.now();
  }
  isLive() {
    return !this.paused && this.speed === 1 && Math.abs(this.now() - Date.now()) < 2000;
  }
}

/* --------------------------------------------------------------- helpers */

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function hexColor(hex: string) {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b] as const;
}

/** Rotate a three.js-frame inertial vector into the Earth-fixed frame. */
function toEarthFixed(v: THREE.Vector3, gmst: number, out: THREE.Vector3) {
  const c = Math.cos(-gmst);
  const s = Math.sin(-gmst);
  // rotation about +y by -gmst (three.js convention)
  return out.set(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
}

interface Fly {
  t0: number;
  dur: number;
  fromDir: THREE.Vector3;
  toDir: THREE.Vector3 | null; // null → track the selected satellite
  fromDist: number;
  toDist: number;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3 | null; // null → satellite (follow)
  /** Interpolate the camera around Earth's center so it never cuts through the planet. */
  world?: boolean;
  fromPos?: THREE.Vector3;
}

/* ----------------------------------------------------------------- scene */

export class GlobeScene {
  readonly clock = new SimClock();
  readonly pathListeners = new Set<(index: number, alts: Float32Array, periodMs: number, start: number) => void>();
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private container: HTMLElement;
  private events: SceneEvents;
  private worker: Worker | null = null;
  private raf = 0;
  private disposed = false;
  private resizeObs: ResizeObserver;

  private earthGroup = new THREE.Group();
  private earthMat: THREE.ShaderMaterial;
  private cloudsMat: THREE.ShaderMaterial;
  private clouds: THREE.Mesh;
  private atmoMat: THREE.ShaderMaterial;
  private starsMat: THREE.ShaderMaterial;
  private stars: THREE.Mesh;
  private tiles: TileLayer;

  // catalog + propagation state
  private catalog: Catalog | null = null;
  private n = 0;
  private samplePos: Float32Array = new Float32Array(0);
  private sampleVel: Float32Array = new Float32Array(0);
  private sampleTime = 0;
  private sampleValid: Uint8Array = new Uint8Array(0);
  private pending = false;
  private pendingTles: [string, string][] | null = null;
  private lastRequest = 0;
  private sampleId = 0;
  private enabledMask: boolean[] = CATEGORIES.map(() => true);
  private catOf: Uint8Array = new Uint8Array(0);

  // render objects for satellites
  private dots: THREE.Points | null = null;
  private dotMat: THREE.ShaderMaterial;
  private satMat: THREE.ShaderMaterial;
  private satMesh: THREE.Mesh | null = null;
  private debMesh: THREE.Mesh | null = null;
  private satIdx: Uint32Array = new Uint32Array(0);
  private debIdx: Uint32Array = new Uint32Array(0);

  // orbits
  private selOrbit: Line2;
  private selGlow: Line2;
  private hovOrbit: Line2;
  private groundTrack: Line2;
  private hero: HeroSatellite;
  private heroFrame = 0;
  private heroCapturedFor: number | null = null;
  private pathReq = 0;
  private selPathStart = 0;
  private selPathSpan = 0;
  private hovPathTimer: ReturnType<typeof setTimeout> | null = null;

  // interaction
  private mouse = new THREE.Vector2(-9999, -9999);
  private mouseDirty = false;
  private mouseInside = false;
  private downAt: { x: number; y: number; t: number } | null = null;
  hovered: number | null = null;
  selected: number | null = null;
  following = false;
  /** Camera pivots around the selected satellite (after picking it from search). */
  tracking = false;
  private focusAnim: { from: number; to: number; t0: number; dur: number; delay: number } | null = null;
  private viewMode: ViewMode = "realistic";
  private targetDist = 3.6;
  private fly: Fly | null = null;
  private followPrev = new THREE.Vector3();
  private lastCamEmit = 0;
  private lastCursorEmit = 0;
  private lastPathRefresh = 0;
  private showGroundTrack = false;
  private textures = new Map<string, THREE.Texture>();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private projV = new THREE.Vector3();

  constructor(container: HTMLElement, events: SceneEvents) {
    this.container = container;
    this.events = events;

    const w = container.clientWidth;
    const h = container.clientHeight;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.outline = "none";

    this.camera = new THREE.PerspectiveCamera(38, w / h, 0.01, 1000);
    // Intro: start far out, fly in once data is ready.
    this.camera.position.set(14, 9, 34);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.enablePan = false;
    this.controls.enableZoom = false; // custom smooth zoom below
    this.controls.rotateSpeed = 0.5;
    this.controls.autoRotateSpeed = 0.35;
    this.targetDist = this.camera.position.length();

    /* stars — real Milky Way panorama (ESO via Solar System Scope) */
    this.starsMat = new THREE.ShaderMaterial({
      vertexShader: simpleVertex,
      fragmentShader: starsFragment,
      uniforms: { uStars: { value: null }, uIntensity: { value: 0.55 } },
      side: THREE.BackSide,
      depthWrite: false,
    });
    // Unit sphere that follows the camera and is scaled to just inside the far plane.
    const stars = (this.stars = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), this.starsMat));
    this.starsMat.depthTest = false;
    stars.rotation.x = THREE.MathUtils.degToRad(-62.9); // rough galactic tilt; decorative backdrop
    stars.renderOrder = -10;
    stars.frustumCulled = false;
    this.scene.add(stars);

    /* earth */
    this.earthMat = new THREE.ShaderMaterial({
      vertexShader: earthVertex,
      fragmentShader: earthFragment,
      uniforms: {
        uDay: { value: null },
        uNight: { value: null },
        uSpec: { value: null },
        uNormal: { value: null },
        uTopo: { value: null },
        uWater: { value: null },
        uMode: { value: 0 },
        uSunDir: { value: new THREE.Vector3(1, 0, 0) },
        uCamPos: { value: new THREE.Vector3() },
        uLightView: { value: new THREE.Vector3() },
        uDots: { value: 0 },
      },
    });
    const earthGeo = new THREE.SphereGeometry(1, 192, 96);
    const earth = new THREE.Mesh(earthGeo, this.earthMat);
    this.earthGroup.add(earth);

    this.cloudsMat = new THREE.ShaderMaterial({
      vertexShader: earthVertex,
      fragmentShader: cloudsFragment,
      uniforms: {
        uClouds: { value: null },
        uSunDir: { value: new THREE.Vector3(1, 0, 0) },
        uOpacity: { value: 0.9 },
      },
      transparent: true,
      depthWrite: false,
    });
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(1.0065, 160, 80), this.cloudsMat);
    this.clouds.renderOrder = 5; // after the streamed tiles
    this.tiles = new TileLayer(this.renderer.capabilities.getMaxAnisotropy());
    this.earthGroup.add(this.tiles.group);
    this.earthGroup.add(this.clouds);
    this.scene.add(this.earthGroup);

    this.atmoMat = new THREE.ShaderMaterial({
      vertexShader: atmosphereVertex,
      fragmentShader: atmosphereFragment,
      uniforms: {
        uColor: { value: new THREE.Color(0.35, 0.6, 1.0) },
        uSunDir: { value: new THREE.Vector3(1, 0, 0) },
        uCamPos: { value: new THREE.Vector3() },
        uIntensity: { value: 1.2 },
        uSunWeight: { value: 1 },
        uScaleHeight: { value: 0.014 },
      },
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(1.07, 128, 64), this.atmoMat));

    /* satellite materials */
    const satUniforms = {
      uDt: { value: 0 },
      uMu: { value: MU },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uHover: { value: -1 },
      uSelected: { value: -1 },
      uHideSelected: { value: 0 },
    };
    this.satMat = new THREE.ShaderMaterial({
      vertexShader: satVertex,
      fragmentShader: satFragment,
      uniforms: {
        ...satUniforms,
        uPxScale: { value: 0.001 },
        uPx: { value: 8 },
        uPxFocus: { value: 18 },
        uTime: { value: 0 },
        uCamPos: { value: new THREE.Vector3() },
      },
    });
    this.dotMat = new THREE.ShaderMaterial({
      vertexShader: dotVertex,
      fragmentShader: dotFragment,
      uniforms: {
        ...satUniforms,
        uDotPx: { value: 6 },
        uPixelRatio: { value: this.renderer.getPixelRatio() },
        uDotAlpha: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    // ShaderMaterial clones uniform objects; re-link the shared ones.
    for (const k of Object.keys(satUniforms) as (keyof typeof satUniforms)[]) {
      this.dotMat.uniforms[k] = this.satMat.uniforms[k];
    }

    /* orbit lines: screen-space fat lines so trajectories stay legible at any zoom */
    const lineMat = (width: number, opacity: number, dashed = false) => {
      const m = new LineMaterial({
        linewidth: width,
        vertexColors: true,
        transparent: true,
        opacity,
        depthWrite: false,
        worldUnits: false,
        dashed,
        dashSize: 0.012,
        gapSize: 0.01,
      });
      // Vertex colors carry the fade as brightness. Turn that into alpha so we can
      // use normal blending: additive double-counts where segment joints overlap
      // and leaves bright beads along the line.
      m.onBeforeCompile = (sh) => {
        sh.fragmentShader = sh.fragmentShader.replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          float fadeLum = max(max(diffuseColor.r, diffuseColor.g), diffuseColor.b);
          alpha *= clamp(fadeLum, 0.0, 1.0);
          diffuseColor.rgb /= max(fadeLum, 1e-3);`,
        );
      };
      return m;
    };
    this.selGlow = new Line2(new LineGeometry(), lineMat(7, 0.22));
    this.selOrbit = new Line2(new LineGeometry(), lineMat(2.2, 1));
    this.hovOrbit = new Line2(new LineGeometry(), lineMat(1.6, 0.85));
    this.groundTrack = new Line2(new LineGeometry(), lineMat(1.2, 0.55, true));
    for (const l of [this.selGlow, this.selOrbit, this.hovOrbit, this.groundTrack]) {
      l.frustumCulled = false;
      l.visible = false;
      l.renderOrder = 4;
    }
    this.scene.add(this.selGlow, this.selOrbit, this.hovOrbit);
    this.earthGroup.add(this.groundTrack);

    this.hero = new HeroSatellite();
    this.scene.add(this.hero.group);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; // affects only the PBR hero model
    this.renderer.toneMappingExposure = 1.05;

    /* events */
    const el = this.renderer.domElement;
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointerleave", this.onPointerLeave);
    el.addEventListener("wheel", this.onWheel, { passive: false });
    this.controls.addEventListener("start", () => {
      this.fly = null;
    });

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);

    this.loadTextures(["day", "night", "spec", "normal", "clouds", "stars", "water"]);
    this.loop();
  }

  /* ------------------------------------------------------------ textures */

  private static TEX_FILES: Record<string, { file: string; srgb: boolean }> = {
    day: { file: "earth-day-8k.jpg", srgb: true },
    night: { file: "earth-night-8k.jpg", srgb: true },
    spec: { file: "earth-specular-4k.jpg", srgb: false },
    normal: { file: "earth-normal-4k.jpg", srgb: false },
    clouds: { file: "earth-clouds-4k.jpg", srgb: false },
    stars: { file: "stars-4k.jpg", srgb: true },
    topo: { file: "earth-topology.png", srgb: false },
    water: { file: "earth-water.png", srgb: false },
  };

  private loadTextures(keys: string[]) {
    const loader = new THREE.TextureLoader();
    const todo = keys.filter((k) => !this.textures.has(k));
    let done = 0;
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    return Promise.all(
      todo.map(
        (k) =>
          new Promise<void>((resolve) => {
            const spec = GlobeScene.TEX_FILES[k];
            loader.load(
              TEX + spec.file,
              (t) => {
                t.colorSpace = spec.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
                t.anisotropy = Math.min(8, maxAniso);
                this.textures.set(k, t);
                this.applyTextures();
                done++;
                this.events.onTexturesProgress?.(done, todo.length);
                resolve();
              },
              undefined,
              () => {
                done++;
                resolve();
              },
            );
          }),
      ),
    );
  }

  private applyTextures() {
    const t = (k: string) => this.textures.get(k) ?? null;
    const u = this.earthMat.uniforms;
    u.uDay.value = t("day");
    u.uNight.value = t("night");
    u.uSpec.value = t("spec");
    u.uNormal.value = t("normal");
    u.uTopo.value = t("topo");
    u.uWater.value = t("water");
    this.cloudsMat.uniforms.uClouds.value = t("clouds");
    this.tiles.setShared({ night: t("night"), spec: t("spec"), topo: t("topo"), water: t("water") });
    this.starsMat.uniforms.uStars.value = t("stars");
  }

  setViewMode(mode: ViewMode) {
    this.viewMode = mode;
    if (mode === "terrain") void this.loadTextures(["topo", "water"]);
    const idx = { realistic: 0, imagery: 1, night: 2, terrain: 3, tactical: 4 }[mode];
    this.earthMat.uniforms.uMode.value = idx;
    this.clouds.visible = mode === "realistic";
    this.tiles.setMode(mode);
    const a = this.atmoMat.uniforms;
    const cfg: Record<ViewMode, { color: [number, number, number]; i: number; sw: number; stars: number; h: number }> = {
      realistic: { color: [0.35, 0.6, 1.0], i: 1.25, sw: 1, stars: 0.55, h: 0.014 },
      imagery: { color: [0.4, 0.62, 1.0], i: 0.8, sw: 0, stars: 0.5, h: 0.012 },
      night: { color: [0.3, 0.45, 0.9], i: 0.35, sw: 0, stars: 0.75, h: 0.012 },
      terrain: { color: [0.7, 0.78, 0.92], i: 0.35, sw: 0, stars: 0.4, h: 0.01 },
      tactical: { color: [0.82, 0.86, 0.95], i: 0.3, sw: 0, stars: 0.22, h: 0.009 },
    };
    const c = cfg[mode];
    (a.uColor.value as THREE.Color).setRGB(...c.color);
    a.uIntensity.value = c.i;
    a.uSunWeight.value = c.sw;
    a.uScaleHeight.value = c.h;
    this.starsMat.uniforms.uIntensity.value = c.stars;
  }

  /* ------------------------------------------------------------- catalog */

  setCatalog(catalog: Catalog) {
    this.catalog = catalog;
    const objs = catalog.objects;
    const n = (this.n = objs.length);
    this.samplePos = new Float32Array(n * 3);
    this.sampleVel = new Float32Array(n * 3);
    this.sampleValid = new Uint8Array(n);
    this.catOf = new Uint8Array(n);
    const colors = new Float32Array(n * 3);
    const sat: number[] = [];
    const deb: number[] = [];
    objs.forEach((o, i) => {
      const ci = CATEGORIES.indexOf(o.category);
      this.catOf[i] = ci;
      const [r, g, b] = hexColor(CATEGORY_META[o.category].color);
      colors.set([r, g, b], i * 3);
      (o.category === "debris" ? deb : sat).push(i);
    });
    this.satIdx = Uint32Array.from(sat);
    this.debIdx = Uint32Array.from(deb);

    // far-field dots (catalog order)
    const dg = new THREE.BufferGeometry();
    const dPos = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    dg.setAttribute("position", dPos);
    dg.setAttribute("aPos", dPos);
    dg.setAttribute("aVel", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    dg.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
    dg.setAttribute("aIndex", new THREE.BufferAttribute(Float32Array.from(objs.map((_, i) => i)), 1));
    dg.setAttribute("aVisible", new THREE.BufferAttribute(new Float32Array(n), 1));
    this.dots = new THREE.Points(dg, this.dotMat);
    this.dots.frustumCulled = false;
    this.dots.renderOrder = 2;
    this.scene.add(this.dots);

    const makeInstanced = (base: THREE.BufferGeometry, idx: Uint32Array) => {
      const g = new THREE.InstancedBufferGeometry();
      g.index = base.index;
      for (const [k, v] of Object.entries(base.attributes)) g.setAttribute(k, v);
      const m = idx.length;
      const c = new Float32Array(m * 3);
      idx.forEach((ci, j) => c.set(colors.subarray(ci * 3, ci * 3 + 3), j * 3));
      g.setAttribute("aPos", new THREE.InstancedBufferAttribute(new Float32Array(m * 3), 3));
      g.setAttribute("aVel", new THREE.InstancedBufferAttribute(new Float32Array(m * 3), 3));
      g.setAttribute("aColor", new THREE.InstancedBufferAttribute(c, 3));
      g.setAttribute("aIndex", new THREE.InstancedBufferAttribute(Float32Array.from(idx), 1));
      g.setAttribute("aVisible", new THREE.InstancedBufferAttribute(new Float32Array(m), 1));
      g.instanceCount = m;
      const mesh = new THREE.Mesh(g, this.satMat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 3;
      this.scene.add(mesh);
      return mesh;
    };
    this.satMesh = makeInstanced(satelliteGeometry(), this.satIdx);
    this.debMesh = makeInstanced(debrisGeometry(), this.debIdx);

    this.worker?.terminate();
    this.worker = new Worker(new URL("../../lib/orbit/propagate.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = this.onWorkerMessage;
    this.worker.onerror = (e) => console.error("[orbit worker]", e.message);
    this.pendingTles = objs.map((o) => [o.line1, o.line2]);
  }

  private onWorkerMessage = (e: MessageEvent) => {
    const m = e.data;
    if (m.type === "boot") {
      this.worker?.postMessage({ type: "init", tles: this.pendingTles });
      this.pendingTles = null;
      return;
    }
    if (m.type === "ready") {
      this.requestSample(true);
      return;
    }
    if (m.type === "sample") {
      this.pending = false;
      if (m.id !== this.sampleId) return;
      const first = this.sampleTime === 0;
      this.samplePos = m.pos;
      this.sampleVel = m.vel;
      this.sampleTime = m.time;
      for (let i = 0; i < this.n; i++) {
        const o = i * 3;
        this.sampleValid[i] = m.pos[o] !== 0 || m.pos[o + 1] !== 0 || m.pos[o + 2] !== 0 ? 1 : 0;
      }
      this.uploadSample();
      this.events.onStats?.({ propagateMs: m.ms, invalid: m.invalid, total: this.n });
      if (first) {
        this.events.onReady?.();
        this.introFly();
      }
      return;
    }
    if (m.type === "path") this.onPath(m);
  };

  private requestSample(force = false) {
    if (!this.worker || (this.pending && !force)) return;
    this.pending = true;
    this.lastRequest = performance.now();
    this.sampleId++;
    this.worker.postMessage({ type: "sample", id: this.sampleId, time: this.clock.now() });
  }

  private uploadSample() {
    if (!this.dots || !this.satMesh || !this.debMesh) return;
    const dg = this.dots.geometry;
    (dg.getAttribute("aPos") as THREE.BufferAttribute).copyArray(this.samplePos).needsUpdate = true;
    (dg.getAttribute("aVel") as THREE.BufferAttribute).copyArray(this.sampleVel).needsUpdate = true;
    for (const [mesh, idx] of [
      [this.satMesh, this.satIdx],
      [this.debMesh, this.debIdx],
    ] as const) {
      const g = mesh.geometry;
      const p = g.getAttribute("aPos") as THREE.InstancedBufferAttribute;
      const v = g.getAttribute("aVel") as THREE.InstancedBufferAttribute;
      const pa = p.array as Float32Array;
      const va = v.array as Float32Array;
      for (let j = 0; j < idx.length; j++) {
        const o = idx[j] * 3;
        pa[j * 3] = this.samplePos[o];
        pa[j * 3 + 1] = this.samplePos[o + 1];
        pa[j * 3 + 2] = this.samplePos[o + 2];
        va[j * 3] = this.sampleVel[o];
        va[j * 3 + 1] = this.sampleVel[o + 1];
        va[j * 3 + 2] = this.sampleVel[o + 2];
      }
      p.needsUpdate = true;
      v.needsUpdate = true;
    }
    this.updateVisibility();
  }

  setEnabled(enabled: Record<Category, boolean>) {
    this.enabledMask = CATEGORIES.map((c) => enabled[c]);
    this.updateVisibility();
    if (this.hovered !== null && !this.isVisible(this.hovered)) this.setHovered(null);
  }

  private isVisible(i: number) {
    return this.sampleValid[i] === 1 && this.enabledMask[this.catOf[i]];
  }

  private updateVisibility() {
    if (!this.dots || !this.satMesh || !this.debMesh) return;
    const dv = this.dots.geometry.getAttribute("aVisible") as THREE.BufferAttribute;
    const da = dv.array as Float32Array;
    for (let i = 0; i < this.n; i++) da[i] = this.isVisible(i) ? 1 : 0;
    dv.needsUpdate = true;
    for (const [mesh, idx] of [
      [this.satMesh, this.satIdx],
      [this.debMesh, this.debIdx],
    ] as const) {
      const a = mesh.geometry.getAttribute("aVisible") as THREE.InstancedBufferAttribute;
      const arr = a.array as Float32Array;
      for (let j = 0; j < idx.length; j++) arr[j] = da[idx[j]];
      a.needsUpdate = true;
    }
  }

  /* ----------------------------------------------------------- positions */

  private dtSec() {
    return (this.clock.now() - this.sampleTime) / 1000;
  }

  /** Current position of object i in scene units (same math as the shader). */
  positionOf(i: number, out = new THREE.Vector3()) {
    const o = i * 3;
    const px = this.samplePos[o],
      py = this.samplePos[o + 1],
      pz = this.samplePos[o + 2];
    const dt = this.dtSec();
    const r = Math.hypot(px, py, pz) || 1;
    const k = (-MU / (r * r * r)) * 0.5 * dt * dt;
    return out.set(
      px + this.sampleVel[o] * dt + px * k,
      py + this.sampleVel[o + 1] * dt + py * k,
      pz + this.sampleVel[o + 2] * dt + pz * k,
    );
  }

  /** Live geodetic state for the info panel. */
  liveState(i: number): SatLive | null {
    if (!this.sampleValid[i]) return null;
    const p = this.positionOf(i, this.tmp);
    const date = new Date(this.clock.now());
    const gmst = gstime(date);
    const eci = { x: p.x * EARTH_RADIUS_KM, y: -p.z * EARTH_RADIUS_KM, z: p.y * EARTH_RADIUS_KM };
    const geo = eciToGeodetic(eci, gmst);
    const o = i * 3;
    const dt = this.dtSec();
    const r = p.length();
    const vx = this.sampleVel[o] - (MU / r ** 3) * p.x * dt;
    const vy = this.sampleVel[o + 1] - (MU / r ** 3) * p.y * dt;
    const vz = this.sampleVel[o + 2] - (MU / r ** 3) * p.z * dt;
    const sun = this.satMat.uniforms.uSunDir.value as THREE.Vector3;
    const along = p.dot(sun);
    const perp = this.tmp2.copy(sun).multiplyScalar(along).sub(p).length();
    return {
      lat: THREE.MathUtils.radToDeg(geo.latitude),
      lon: THREE.MathUtils.radToDeg(geo.longitude),
      altKm: geo.height,
      speedKms: Math.hypot(vx, vy, vz) * EARTH_RADIUS_KM,
      sunlit: !(along < 0 && perp < 1),
    };
  }

  /* --------------------------------------------------------------- orbits */

  private requestPath(index: number, kind: "sel" | "hov") {
    if (!this.worker) return;
    const id = ++this.pathReq;
    (kind === "sel" ? this.selOrbit : this.hovOrbit).userData = { id, index };
    // Centered on the satellite: half a revolution behind, half ahead. A path that
    // starts at the satellite ends right next to it and reads as a stray line.
    const periodMs = (1440 / this.catalog!.objects[index].meanMotion) * 60_000;
    const span = periodMs * 0.995;
    this.worker.postMessage({ type: "path", id, index, time: this.clock.now() - span / 2, steps: 720, span });
  }

  private onPath(m: {
    id: number;
    index: number;
    points: Float32Array | null;
    alts: Float32Array;
    start: number;
    span: number;
    periodMs: number;
  }) {
    const isSel = this.selOrbit.userData.id === m.id && m.index === this.selected;
    const isHov = this.hovOrbit.userData.id === m.id && m.index === this.hovered;
    if ((!isSel && !isHov) || !m.points) return;
    const count = m.points.length / 3;
    const color = new THREE.Color(CATEGORY_META[this.catalog!.objects[m.index].category].color);
    if (isSel) {
      // white-hot at the satellite, cooling to the category color over one revolution
      this.setLine(this.selOrbit, m.points, new THREE.Color("#ffffff"), color, 0.25);
      this.setLine(this.selGlow, m.points, color, color, 0.15);
      this.selOrbit.visible = this.selGlow.visible = true;
      this.selPathStart = m.start + m.span / 2; // the satellite sits mid-path
      this.selPathSpan = m.span;
      // altitude chart wants "now → one revolution": second half, then the first
      // half (one revolution later, close enough for a profile)
      const half = Math.floor(m.alts.length / 2);
      const ahead = new Float32Array(m.alts.length);
      ahead.set(m.alts.subarray(half));
      ahead.set(m.alts.subarray(0, half), m.alts.length - half);
      this.pathListeners.forEach((fn) => fn(m.index, ahead, m.periodMs, this.selPathStart));
      // ground track in the Earth-fixed frame
      const gt = new Float32Array(m.points.length);
      const v = new THREE.Vector3();
      const out = new THREE.Vector3();
      for (let s = 0; s < count; s++) {
        const t = m.start + (s / (count - 1)) * m.span;
        v.fromArray(m.points, s * 3);
        toEarthFixed(v, gstime(new Date(t)), out).normalize().multiplyScalar(1.0015);
        out.toArray(gt, s * 3);
      }
      this.setLine(this.groundTrack, gt, color, color, 0.15);
      this.groundTrack.computeLineDistances(); // for the dashes
      this.groundTrack.visible = this.showGroundTrack && !this.following;
    } else {
      this.setLine(this.hovOrbit, m.points, color.clone().lerp(new THREE.Color("#ffffff"), 0.35), color, 0.12);
      this.hovOrbit.visible = this.hovered !== this.selected;
    }
  }

  /** Fill a fat line with a head→tail color ramp (additive, so fading = darkening). */
  private setLine(line: Line2, points: Float32Array, head: THREE.Color, tail: THREE.Color, tailK: number) {
    // points span one revolution centered on the satellite
    const count = points.length / 3;
    const colors = new Float32Array(points.length);
    const c = new THREE.Color();
    for (let s = 0; s < count; s++) {
      // brightest at the satellite (mid-path); the past fades faster than the future
      const u = s / (count - 1) - 0.5;
      const t = u >= 0 ? u * 2 : Math.min(-u * 2 * 1.5, 1);
      c.copy(head).lerp(tail, Math.min(t * 1.6, 1)).multiplyScalar(THREE.MathUtils.lerp(1, tailK, Math.pow(t, 0.75)));
      c.toArray(colors, s * 3);
    }
    const g = new LineGeometry();
    g.setPositions(points);
    g.setColors(colors);
    line.geometry.dispose();
    line.geometry = g;
  }

  setShowGroundTrack(v: boolean) {
    this.showGroundTrack = v;
    this.groundTrack.visible = v && this.selected !== null && !this.following;
  }

  /* ---------------------------------------------------------- selection */

  setHovered(i: number | null) {
    if (i === this.hovered) return;
    this.hovered = i;
    this.satMat.uniforms.uHover.value = i ?? -1;
    this.events.onHover?.(i);
    if (this.hovPathTimer) clearTimeout(this.hovPathTimer);
    this.hovOrbit.visible = false;
    if (i !== null && i !== this.selected) {
      this.hovPathTimer = setTimeout(() => this.requestPath(i, "hov"), 60);
    }
  }

  select(i: number | null, opts: { fly?: boolean } = {}) {
    if (i === this.selected && !opts.fly) return;
    this.selected = i;
    this.satMat.uniforms.uSelected.value = i ?? -1;
    this.selOrbit.visible = this.selGlow.visible = false;
    this.groundTrack.visible = false;
    this.hero.group.visible = i !== null;
    if (i !== null) {
      const cat = this.catalog?.objects[i].category;
      this.hero.setKind(cat === "starlink" ? "starlink" : cat === "debris" ? "debris" : "generic");
    }
    if (i === null) {
      if (this.following) this.setFollow(false);
      else if (this.tracking) this.release();
      this.events.onSelect?.(null);
      return;
    }
    if (this.tracking && !opts.fly && !this.following) this.release();
    this.hovOrbit.visible = false;
    this.requestPath(i, "sel");
    this.lastPathRefresh = performance.now();
    this.events.onSelect?.(i);
    if (opts.fly && !this.following) this.flyToObject(i);
  }

  /** Fly to a satellite and keep it centered; the camera then orbits around it. */
  private flyToObject(i: number) {
    const p = this.positionOf(i, new THREE.Vector3());
    const dist = 2.0;
    this.tracking = true;
    this.fly = {
      t0: performance.now(),
      dur: 1700,
      fromDir: this.camera.position.clone().sub(this.controls.target).normalize(),
      toDir: this.viewDirFor(i, p),
      fromDist: this.camera.position.distanceTo(this.controls.target),
      toDist: dist,
      fromTarget: this.controls.target.clone(),
      toTarget: null, // the satellite, tracked while it moves
      world: true,
      fromPos: this.camera.position.clone(),
    };
    this.targetDist = dist;
  }

  /** Hand the pivot back to Earth's center without moving the camera abruptly. */
  private release() {
    this.tracking = false;
    const cam = this.camera.position.clone();
    const d = Math.max(cam.length(), 2.4);
    this.fly = {
      t0: performance.now(),
      dur: 1200,
      fromDir: cam.clone().sub(this.controls.target).normalize(),
      toDir: cam.clone().normalize(),
      fromDist: cam.distanceTo(this.controls.target),
      toDist: d,
      fromTarget: this.controls.target.clone(),
      toTarget: new THREE.Vector3(),
      world: true,
      fromPos: cam,
    };
    this.targetDist = d;
  }

  private animateFocus(to: number, dur: number, delay = 0) {
    const from = this.satMat.uniforms.uPxFocus.value as number;
    this.focusAnim = { from, to, t0: performance.now(), dur, delay };
  }

  /** Above the satellite but tilted toward its orbit normal, so the orbit reads as an ellipse, not edge-on. */
  private viewDirFor(i: number, p: THREE.Vector3) {
    const o = i * 3;
    const v = new THREE.Vector3(this.sampleVel[o], this.sampleVel[o + 1], this.sampleVel[o + 2]);
    const n = p.clone().cross(v).normalize();
    // pick the normal on the camera's side to keep the move short
    if (n.dot(this.camera.position) < 0) n.negate();
    return p.clone().normalize().addScaledVector(n, 0.75).normalize();
  }

  setFollow(on: boolean) {
    if (on && this.selected === null) return;
    this.following = on;
    if (on) this.setHovered(null);
    // the ground track reads as a stray line from up close
    this.groundTrack.visible = !on && this.showGroundTrack && this.selected !== null;
    const target = this.controls.target.clone();
    if (on) {
      const p = this.positionOf(this.selected!, new THREE.Vector3());
      // arrive above the satellite, on the side the camera is already on
      const towardCam = this.camera.position.clone().sub(p).normalize();
      const outward = p.clone().normalize();
      const toDir = outward.multiplyScalar(0.75).add(towardCam.multiplyScalar(0.65)).normalize();
      this.fly = {
        t0: performance.now(),
        dur: 2200,
        fromDir: this.camera.position.clone().sub(target).normalize(),
        toDir,
        fromDist: this.camera.position.distanceTo(target),
        toDist: 0.06,
        fromTarget: target,
        toTarget: null,
        world: true,
        fromPos: this.camera.position.clone(),
      };
      this.targetDist = 0.06;
      // grow the model with the approach instead of popping it in
      this.animateFocus(150, 1700, 500);
    } else {
      const d = Math.max(this.camera.position.length() + 1.5, 3.2);
      this.fly = {
        t0: performance.now(),
        dur: 1500,
        fromDir: this.camera.position.clone().sub(target).normalize(),
        toDir: this.camera.position.clone().normalize(),
        fromDist: this.camera.position.distanceTo(target),
        toDist: d,
        fromTarget: target,
        toTarget: new THREE.Vector3(),
        world: true,
        fromPos: this.camera.position.clone(),
      };
      this.targetDist = d;
      this.tracking = false;
      this.animateFocus(18, 1100);
    }
  }

  private introFly() {
    this.fly = {
      t0: performance.now(),
      dur: 3200,
      fromDir: this.camera.position.clone().normalize(),
      // open over the Atlantic-facing hemisphere in daylight-ish view
      toDir: new THREE.Vector3(0.55, 0.42, 0.72).normalize(),
      fromDist: this.camera.position.length(),
      toDist: 4.6,
      fromTarget: new THREE.Vector3(),
      toTarget: new THREE.Vector3(),
    };
    this.targetDist = 4.6;
  }

  /* -------------------------------------------------------------- camera */

  zoomBy(factor: number) {
    const [min, max] = this.distLimits();
    // Zoom on altitude, not distance to Earth's center, so it keeps working near the ground.
    const floor = this.following || this.tracking ? 0 : 1;
    this.targetDist = THREE.MathUtils.clamp(floor + (this.targetDist - floor) * factor, min, max);
    if (this.fly) this.fly.toDist = this.targetDist;
  }

  /** Attribution for the tile source currently on screen, if any. */
  get tileAttribution() {
    return this.tiles.attribution;
  }

  /** Esri-style zoom presets: LEO shell, MEO (GNSS) and the GEO belt. */
  zoomTo(preset: "leo" | "meo" | "geo") {
    if (this.following) this.setFollow(false);
    this.tracking = false;
    const d = { leo: 4.6, meo: 10, geo: 19 }[preset];
    const fromDist = this.camera.position.distanceTo(this.controls.target);
    this.fly = {
      t0: performance.now(),
      dur: 1600,
      fromDir: this.camera.position.clone().sub(this.controls.target).normalize(),
      toDir: preset === "geo" ? new THREE.Vector3(0.35, 0.55, 0.76).normalize() : null,
      fromDist,
      toDist: d,
      fromTarget: this.controls.target.clone(),
      toTarget: new THREE.Vector3(),
    };
    if (!this.fly.toDir) this.fly.toDir = this.fly.fromDir.clone();
    this.targetDist = d;
  }

  resetView() {
    if (this.following) this.setFollow(false);
    this.tracking = false;
    this.fly = {
      t0: performance.now(),
      dur: 1400,
      fromDir: this.camera.position.clone().sub(this.controls.target).normalize(),
      toDir: new THREE.Vector3(0.55, 0.42, 0.72).normalize(),
      fromDist: this.camera.position.distanceTo(this.controls.target),
      toDist: 4.6,
      fromTarget: this.controls.target.clone(),
      toTarget: new THREE.Vector3(),
    };
    this.targetDist = 4.6;
  }

  setAutoRotate(v: boolean) {
    this.controls.autoRotate = v;
  }

  private distLimits(): [number, number] {
    if (this.following) return [0.012, 4];
    if (this.tracking) return [0.03, 60];
    return [1.0006, 60];
  }

  /* --------------------------------------------------------------- input */

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const k = Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0012));
    this.zoomBy(k);
  };

  private onPointerMove = (e: PointerEvent) => {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.mouse.set(e.clientX - r.left, e.clientY - r.top);
    this.mouseDirty = true;
    this.mouseInside = true;
  };

  private onPointerLeave = () => {
    this.mouseInside = false;
    this.setHovered(null);
    this.events.onCursor?.(null);
  };

  private onPointerDown = (e: PointerEvent) => {
    this.downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
  };

  private onPointerUp = (e: PointerEvent) => {
    const d = this.downAt;
    this.downAt = null;
    if (!d) return;
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    if (moved > 5 || performance.now() - d.t > 600) return;
    if (this.hovered !== null) this.select(this.hovered, { fly: false });
    else if (!this.following) this.select(null);
  };

  /** Screen-space pick over every visible object; skips anything behind Earth. */
  private pick() {
    if (!this.catalog || !this.mouseInside) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const cam = this.camera.position;
    const vp = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    const e = vp.elements;
    const dt = this.dtSec();
    const mx = this.mouse.x;
    const my = this.mouse.y;
    const px = (this.satMat.uniforms.uPx.value as number) * 0.5 + 5;
    let best = -1;
    let bestD = px * px;
    const P = this.samplePos;
    const Vv = this.sampleVel;
    for (let i = 0; i < this.n; i++) {
      if (!this.isVisible(i)) continue;
      const o = i * 3;
      const r = Math.hypot(P[o], P[o + 1], P[o + 2]);
      const k = (-MU / (r * r * r)) * 0.5 * dt * dt;
      const x = P[o] + Vv[o] * dt + P[o] * k;
      const y = P[o + 1] + Vv[o + 1] * dt + P[o + 1] * k;
      const z = P[o + 2] + Vv[o + 2] * dt + P[o + 2] * k;
      const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (cw <= 0) continue;
      const sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / cw * 0.5 + 0.5) * w;
      const sy = (1 - ((e[1] * x + e[5] * y + e[9] * z + e[13]) / cw * 0.5 + 0.5)) * h;
      const d2 = (sx - mx) ** 2 + (sy - my) ** 2;
      if (d2 >= bestD) continue;
      // occlusion by the Earth (unit sphere)
      const dx = x - cam.x,
        dy = y - cam.y,
        dz = z - cam.z;
      const len = Math.hypot(dx, dy, dz);
      const ux = dx / len,
        uy = dy / len,
        uz = dz / len;
      const b = cam.x * ux + cam.y * uy + cam.z * uz;
      const c = cam.lengthSq() - 1;
      const disc = b * b - c;
      if (disc > 0) {
        const tHit = -b - Math.sqrt(disc);
        if (tHit > 0 && tHit < len) continue;
      }
      best = i;
      bestD = d2;
    }
    this.setHovered(best >= 0 ? best : null);
    this.renderer.domElement.style.cursor = best >= 0 ? "pointer" : "grab";
  }

  private cursorLatLon() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const ndc = new THREE.Vector2((this.mouse.x / w) * 2 - 1, -(this.mouse.y / h) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), 1), new THREE.Vector3());
    if (!hit) return null;
    const ef = toEarthFixed(hit, this.earthGroup.rotation.y, new THREE.Vector3());
    return {
      lat: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(ef.y, -1, 1))),
      lon: THREE.MathUtils.radToDeg(Math.atan2(-ef.z, ef.x)),
    };
  }

  private project(p: THREE.Vector3): ScreenPoint {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const v = this.projV.copy(p).project(this.camera);
    // hidden behind the Earth?
    const cam = this.camera.position;
    const dir = this.tmp2.copy(p).sub(cam);
    const len = dir.length();
    dir.divideScalar(len);
    const b = cam.dot(dir);
    const disc = b * b - (cam.lengthSq() - 1);
    const occluded = disc > 0 && -b - Math.sqrt(disc) > 0 && -b - Math.sqrt(disc) < len;
    return { x: (v.x * 0.5 + 0.5) * w, y: (1 - (v.y * 0.5 + 0.5)) * h, visible: v.z < 1 && !occluded };
  }

  /* ---------------------------------------------------------------- loop */

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const l of [this.selGlow, this.selOrbit, this.hovOrbit, this.groundTrack]) (l.material as LineMaterial).resolution.set(w, h);
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const sim = this.clock.now();
    const date = new Date(sim);

    // Earth orientation and sun from the simulated time.
    const gmst = gstime(date);
    this.earthGroup.rotation.y = gmst;
    const s = sunPos(jday(date)).rsun;
    const sun = this.tmp.set(s.x, s.z, -s.y).normalize();
    for (const u of [this.earthMat.uniforms, this.cloudsMat.uniforms, this.atmoMat.uniforms, this.satMat.uniforms]) {
      (u.uSunDir.value as THREE.Vector3).copy(sun);
    }

    // Keep samples fresh. Faster sampling when time runs fast.
    const interval = this.clock.speed > 30 ? 120 : 400;
    if (this.worker && this.sampleTime && !this.pending && now - this.lastRequest > interval && !this.clock.paused) {
      this.requestSample();
    }
    this.satMat.uniforms.uDt.value = this.sampleTime ? this.dtSec() : 0;
    this.satMat.uniforms.uTime.value = now / 1000;

    // Refresh the selected orbit so its bright head stays on the satellite.
    if (this.selected !== null && this.selPathSpan > 0) {
      const drift = Math.abs(sim - this.selPathStart);
      if (drift > this.selPathSpan / 240 && now - this.lastPathRefresh > 250) {
        this.lastPathRefresh = now;
        this.requestPath(this.selected, "sel");
      }
    }

    this.updateCamera(now);

    // Per-frame sizes tied to distance.
    const D = this.camera.position.length();
    const camToTarget = this.camera.position.distanceTo(this.controls.target);
    const h = this.container.clientHeight || 1;
    this.satMat.uniforms.uPxScale.value = (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / h;
    this.satMat.uniforms.uPx.value = THREE.MathUtils.clamp(24 / D, 3, 14);
    (this.satMat.uniforms.uCamPos.value as THREE.Vector3).copy(this.camera.position);
    this.dotMat.uniforms.uDotPx.value = THREE.MathUtils.clamp(10 / Math.sqrt(D), 2.6, 7);
    this.dotMat.uniforms.uDotAlpha.value = this.viewMode === "tactical" ? 0.9 : 0.75;
    (this.earthMat.uniforms.uCamPos.value as THREE.Vector3).copy(this.camera.position);
    (this.atmoMat.uniforms.uCamPos.value as THREE.Vector3).copy(this.camera.position);
    // hillshade light from the camera's upper left
    const camRight = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const camUp = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    (this.earthMat.uniforms.uLightView.value as THREE.Vector3)
      .copy(this.camera.position)
      .normalize()
      .addScaledVector(camUp, 0.9)
      .addScaledVector(camRight, -0.7)
      .normalize();
    // density level from altitude: each step doubles the hex count, capped by the land mask's resolution
    this.earthMat.uniforms.uDots.value = THREE.MathUtils.clamp(Math.log2(3.6 / Math.max(D - 1, 1e-4)) * 0.85, 0, 3.2);

    const near = THREE.MathUtils.clamp(Math.min((D - 1) * 0.25, camToTarget * 0.2), 0.00004, 0.3);
    const far = D + 70;
    if (Math.abs(near - this.camera.near) / this.camera.near > 0.05 || Math.abs(far - this.camera.far) > 1) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
    this.stars.position.copy(this.camera.position);
    this.stars.scale.setScalar(far * 0.9);

    // streamed tiles, in the Earth-fixed frame
    this.camera.updateMatrixWorld();
    this.earthGroup.updateMatrixWorld();
    const camLocal = this.earthGroup.worldToLocal(this.tmp2.copy(this.camera.position));
    this.tiles.update(camLocal, this.camera, this.earthGroup.matrixWorld, h, sun);
    this.cloudsMat.uniforms.uOpacity.value = 0.9 * THREE.MathUtils.smoothstep(D - 1, 0.04, 0.6);

    if (this.mouseDirty && this.sampleTime) {
      this.mouseDirty = false;
      // While following, the cursor is still but satellites stream under it:
      // hover would flicker through objects and their trajectories.
      if (!this.downAt && !this.following) this.pick();
      if (now - this.lastCursorEmit > 60) {
        this.lastCursorEmit = now;
        this.events.onCursor?.(this.cursorLatLon());
      }
    }
    if (now - this.lastCamEmit > 100) {
      this.lastCamEmit = now;
      this.events.onCamera?.((D - 1) * EARTH_RADIUS_KM);
    }

    if (this.focusAnim) {
      const fa = this.focusAnim;
      const t = THREE.MathUtils.clamp((now - fa.t0 - fa.delay) / fa.dur, 0, 1);
      this.satMat.uniforms.uPxFocus.value = fa.from + (fa.to - fa.from) * ease(t);
      if (t >= 1) this.focusAnim = null;
    }
    this.updateHero();
    this.renderer.render(this.scene, this.camera);

    if (this.events.onTrack && this.sampleTime) {
      const hp = this.hovered !== null ? this.project(this.positionOf(this.hovered, new THREE.Vector3())) : null;
      const sp = this.selected !== null ? this.project(this.positionOf(this.selected, new THREE.Vector3())) : null;
      this.events.onTrack(hp, sp);
    }
  };

  private updateHero() {
    const i = this.selected;
    const show = i !== null && this.sampleValid[i] === 1;
    this.hero.group.visible = show;
    this.satMat.uniforms.uHideSelected.value = show ? 1 : 0;
    if (!show) return;
    const p = this.positionOf(i, new THREE.Vector3());
    const o = i * 3;
    const v = new THREE.Vector3(this.sampleVel[o], this.sampleVel[o + 1], this.sampleVel[o + 2]);
    // same pixel-size rule as the instanced shader, so the swap is seamless
    const u = this.satMat.uniforms;
    const dist = this.camera.position.distanceTo(p);
    const scale = ((u.uPxFocus.value as number) * (u.uPxScale.value as number) * dist) / 4;
    const sun = u.uSunDir.value as THREE.Vector3;
    const along = p.dot(sun);
    const perp = this.tmp2.copy(sun).multiplyScalar(along).sub(p).length();
    this.hero.update(p, v, scale, sun, !(along < 0 && perp < 1));

    // Refresh real reflections: often while following (the view below changes fast),
    // once right after selecting otherwise.
    this.heroFrame++;
    const due = this.following ? this.heroFrame % 6 === 0 : this.heroCapturedFor !== i;
    if (due) {
      this.heroCapturedFor = i;
      const hide = [this.hero.group, this.dots, this.satMesh, this.debMesh, this.selOrbit, this.selGlow, this.hovOrbit, this.groundTrack];
      const was = hide.map((o) => o?.visible ?? false);
      hide.forEach((o) => o && (o.visible = false));
      this.hero.capture(this.renderer, this.scene, p);
      hide.forEach((o, k) => o && (o.visible = was[k]));
    }
  }

  private updateCamera(now: number) {
    const target = this.controls.target;
    const centered = this.following || this.tracking;
    const satPos = centered && this.selected !== null ? this.positionOf(this.selected, new THREE.Vector3()) : null;

    if (this.fly) {
      const f = this.fly;
      const t = Math.min((now - f.t0) / f.dur, 1);
      const k = ease(t);
      const toTarget = f.toTarget ?? satPos ?? f.fromTarget;
      if (f.world && f.fromPos) {
        const end = toTarget.clone().addScaledVector(f.toDir ?? f.fromDir, f.toDist);
        const rs = f.fromPos.length();
        const re = end.length();
        const q = new THREE.Quaternion().setFromUnitVectors(f.fromPos.clone().divideScalar(rs), end.clone().divideScalar(re));
        const qk = new THREE.Quaternion().slerp(q, k);
        // altitude interpolates in log space: fast through empty space, gentle at the end
        const alt = Math.exp(THREE.MathUtils.lerp(Math.log(rs - 1), Math.log(Math.max(re - 1, 1e-4)), k));
        this.camera.position.copy(f.fromPos).divideScalar(rs).applyQuaternion(qk).multiplyScalar(1 + alt);
        // look-at blends later than the move so the satellite is framed at the end
        target.lerpVectors(f.fromTarget, toTarget, ease(Math.min(t * 1.15, 1)));
        this.camera.lookAt(target);
        if (satPos) this.followPrev.copy(satPos);
        if (t >= 1) this.fly = null;
        this.controls.update();
        return;
      }
      target.lerpVectors(f.fromTarget, toTarget, k);
      const toDir = f.toDir ?? f.fromDir;
      const dir = f.fromDir.clone().lerp(toDir, k);
      if (dir.lengthSq() < 1e-6) dir.copy(toDir);
      dir.normalize();
      // log-space distance interpolation feels like a real zoom
      const dist = Math.exp(THREE.MathUtils.lerp(Math.log(f.fromDist), Math.log(f.toDist), k));
      this.camera.position.copy(target).addScaledVector(dir, dist);
      this.camera.lookAt(target);
      if (satPos) this.followPrev.copy(satPos);
      if (t >= 1) this.fly = null;
      this.controls.update();
      return;
    }

    if (satPos && this.following) {
      // carry the camera along with the satellite
      const delta = this.tmp2.copy(satPos).sub(this.followPrev);
      if (this.followPrev.lengthSq() > 0) this.camera.position.add(delta);
      target.copy(satPos);
      this.followPrev.copy(satPos);
    } else if (satPos) {
      // tracking: the camera stays put and turns to keep the satellite centered
      target.copy(satPos);
    }

    // smooth zoom toward targetDist
    const offset = this.camera.position.clone().sub(target);
    const cur = offset.length();
    const [min, max] = this.distLimits();
    this.targetDist = THREE.MathUtils.clamp(this.targetDist, min, max);
    const floor = centered ? 0 : 1;
    const curAlt = Math.max(cur - floor, 1e-6);
    const nextAlt = Math.exp(THREE.MathUtils.lerp(Math.log(curAlt), Math.log(Math.max(this.targetDist - floor, 1e-6)), 0.14));
    const next = floor + nextAlt;
    offset.setLength(next);
    this.camera.position.copy(target).add(offset);
    // drag speed proportional to altitude, so the ground moves with the cursor
    // Orbiting an inspected satellite is angular, so it keeps full speed at any distance.
    this.controls.rotateSpeed = centered ? 0.75 : THREE.MathUtils.clamp(nextAlt * 0.35, 0.00015, 0.6);
    this.controls.update();
  }

  /* ------------------------------------------------------------ teardown */

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.worker?.terminate();
    this.resizeObs.disconnect();
    this.controls.dispose();
    const el = this.renderer.domElement;
    el.removeEventListener("pointermove", this.onPointerMove);
    el.removeEventListener("pointerdown", this.onPointerDown);
    el.removeEventListener("pointerup", this.onPointerUp);
    el.removeEventListener("pointerleave", this.onPointerLeave);
    el.removeEventListener("wheel", this.onWheel);
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | undefined;
      mat?.dispose?.();
    });
    this.textures.forEach((t) => t.dispose());
    this.tiles.dispose();
    this.hero.dispose();
    this.renderer.dispose();
    el.remove();
  }
}
