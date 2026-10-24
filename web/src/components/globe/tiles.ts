import * as THREE from "three";
import type { ViewMode } from "./shaders";

// Streams Web Mercator tiles onto the globe as the camera gets close. The 8K base
// texture covers everything; tiles refine it from zoom MIN_DRAW_Z up to the
// source's max zoom. Refinement is progressive: a tile is replaced by its
// children only once all visible children have loaded, so nothing overlaps.

interface TileSource {
  id: string;
  url: (z: number, x: number, y: number) => string;
  maxZ: number;
  srgb: boolean;
  attribution: string;
  /** Night-lights tiles blended in on the dark side. */
  lights?: boolean;
}

const IMAGERY_URL = (z: number, x: number, y: number) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

/** NASA VIIRS Black Marble city lights; published down to zoom 8. */
const LIGHTS = {
  maxZ: 8,
  url: (z: number, x: number, y: number) =>
    `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/${z}/${y}/${x}.png`,
};

const SOURCES: Partial<Record<ViewMode, TileSource>> = {
  realistic: {
    id: "esri-imagery+lights",
    url: IMAGERY_URL,
    maxZ: 18,
    srgb: true,
    attribution: "Imagery Esri, Vantor, Earthstar Geographics · NASA Black Marble",
    lights: true,
  },
  imagery: {
    id: "esri-imagery",
    url: IMAGERY_URL,
    maxZ: 18,
    srgb: true,
    attribution: "Imagery Esri, Vantor, Earthstar Geographics",
  },
  terrain: {
    id: "esri-hillshade",
    url: (z, x, y) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/${z}/${y}/${x}`,
    maxZ: 15,
    srgb: false,
    attribution: "Hillshade Esri, USGS, NGA, NASA, CGIAR",
  },
  night: {
    id: "esri-imagery+lights-night",
    url: IMAGERY_URL,
    maxZ: 18,
    srgb: true,
    attribution: "NASA Black Marble · Imagery Esri, Vantor, Earthstar Geographics",
    lights: true,
  },
};

const MIN_DRAW_Z = 5;
const MAX_CACHE = 300;
const MAX_INFLIGHT = 12;
const SPLIT_PX = 320; // split when a 256 px tile would cover more than this on screen

const tileVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec3 vObjN;
  void main() {
    vUv = uv;
    vObjN = normalize(position);
    vNormalW = normalize(mat3(modelMatrix) * vObjN);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vPosW = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

// Same looks as the base earth shader, fed by the tile instead of the 8K map.
const tileFragment = /* glsl */ `
  uniform sampler2D uMap;
  uniform sampler2D uLights;    // Black Marble tile (this tile or an ancestor)
  uniform vec4 uLightsUv;       // xy offset, zw scale into uLights
  uniform float uHasLights;
  uniform sampler2D uNight;
  uniform sampler2D uSpec;
  uniform sampler2D uTopo;
  uniform sampler2D uWater;
  uniform vec3 uSunDir;
  uniform vec3 uCamPos;
  uniform int uMode;      // 0 realistic, 1 imagery, 2 night, 3 terrain
  uniform float uFade;
  uniform float uNightK;  // the 8K night-lights map blurs up close; fade it out
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec3 vObjN;
  const float PI = 3.14159265359;
  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(uCamPos - vPosW);
    vec3 tile = texture2D(uMap, vUv).rgb;
    float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    // equirectangular lookup into the global masks
    vec2 eq = vec2(atan(-vObjN.z, vObjN.x) / (2.0 * PI) + 0.5, asin(clamp(vObjN.y, -1.0, 1.0)) / PI + 0.5);
    // city lights: the sharp Black Marble tile when present, else the global 8K map
    vec3 lightsTex = texture2D(uNight, eq).rgb * uNightK;
    if (uHasLights > 0.5) {
      // Black Marble also carries bluish snow, sea ice and moonlit ground; boosted like lights
      // they light up whole tiles at high latitudes. Keep only warm, bright pixels (cities).
      vec3 bm = texture2D(uLights, uLightsUv.xy + vUv * uLightsUv.zw).rgb;
      float warm = smoothstep(-0.02, 0.10, bm.r - bm.b);
      float bright = smoothstep(0.10, 0.45, max(bm.r, bm.g));
      lightsTex = bm * warm * bright;
    }
    vec3 lights = pow(lightsTex, vec3(1.5)) * vec3(1.0, 0.78, 0.52) * 2.2;
    // moonlit ground so the night side keeps its texture
    vec3 moon = tile * vec3(0.05, 0.065, 0.09);
    vec3 col;
    if (uMode == 0) {
      float sunN = dot(N, uSunDir);
      float dayMix = smoothstep(-0.10, 0.22, sunN);
      vec3 term = mix(vec3(1.0, 0.62, 0.38), vec3(1.0), smoothstep(0.0, 0.35, sunN));
      vec3 lit = pow(tile, vec3(1.1)) * term * (0.05 + 1.1 * max(sunN, 0.0));
      col = mix(moon + lights, lit, dayMix);
      float ocean = texture2D(uSpec, eq).r;
      float spec = pow(max(dot(reflect(-uSunDir, N), V), 0.0), 38.0) * ocean * dayMix;
      col += vec3(1.0, 0.92, 0.8) * spec * 0.35;
      col += vec3(0.30, 0.55, 1.0) * fres * (0.10 + 0.9 * dayMix) * 0.9;
    } else if (uMode == 1) {
      col = tile * 1.04 + vec3(0.35, 0.55, 1.0) * fres * 0.3;
    } else if (uMode == 2) {
      // night view: lights over a barely moonlit ground, matching the base shader
      col = pow(tile, vec3(1.2)) * vec3(0.016, 0.022, 0.036) + lights + vec3(0.005, 0.007, 0.012);
      col += vec3(0.25, 0.4, 0.8) * fres * 0.25;
    } else {
      // hillshade tile (grey, 0.7 ≈ flat) on the hypsometric tint of the base view
      float shade = clamp((tile.r - 0.35) * 1.6, 0.0, 1.4);
      float h = texture2D(uTopo, eq).r;
      float land = 1.0 - smoothstep(0.3, 0.7, texture2D(uSpec, eq).r); // 4K ocean mask, smooth coasts
      vec3 sea = mix(vec3(0.030, 0.045, 0.070), vec3(0.055, 0.080, 0.115), fres);
      vec3 ground = mix(vec3(0.11, 0.12, 0.14), vec3(0.50, 0.52, 0.55), pow(clamp(h * 1.15, 0.0, 1.0), 0.8));
      col = mix(sea, ground * (0.25 + 1.0 * shade * shade), land);
      col += vec3(0.6, 0.7, 0.85) * fres * 0.18;
    }
    gl_FragColor = vec4(col, uFade);
    #include <colorspace_fragment>
  }
`;

interface Tile {
  key: string;
  z: number;
  x: number;
  y: number;
  state: "idle" | "loading" | "ready" | "error";
  mesh: THREE.Mesh | null;
  texture: THREE.Texture | null;
  lights: THREE.Texture | null;
  center: THREE.Vector3; // earth-fixed unit vector
  corners: THREE.Vector3[];
  radius: number;
  widthR: number; // physical width in earth radii
  lastUsed: number;
  shownAt: number;
}

const tileLat = (y: number, z: number) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z)));
const tileLon = (x: number, z: number) => (x / 2 ** z) * 2 * Math.PI - Math.PI;

/** Unit vector in the globe's local frame (matches THREE.SphereGeometry UVs). */
function llToVec(lat: number, lon: number, out = new THREE.Vector3()) {
  return out.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));
}

function tileGeometry(z: number, x: number, y: number) {
  const seg = z < 8 ? 24 : 12;
  const lon0 = tileLon(x, z);
  const lon1 = tileLon(x + 1, z);
  // Lift vertices by the chord sag so the patch never dips under the base sphere.
  const segAngle = Math.max(lon1 - lon0, tileLat(y, z) - tileLat(y + 1, z)) / seg;
  const lift = 1 + (1 - Math.cos(segAngle / 2)) + 2e-7;
  const pos = new Float32Array((seg + 1) * (seg + 1) * 3);
  const uv = new Float32Array((seg + 1) * (seg + 1) * 2);
  const v = new THREE.Vector3();
  for (let j = 0; j <= seg; j++) {
    // rows evenly spaced in Mercator y, which is how the image is laid out
    const lat = tileLat(y + j / seg, z);
    for (let i = 0; i <= seg; i++) {
      const lon = lon0 + (i / seg) * (lon1 - lon0);
      llToVec(lat, lon, v).multiplyScalar(lift);
      const k = j * (seg + 1) + i;
      v.toArray(pos, k * 3);
      uv[k * 2] = i / seg;
      uv[k * 2 + 1] = 1 - j / seg;
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i;
      const b = a + 1;
      const c = a + seg + 1;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

function children(x: number, y: number): [number, number][] {
  return [
    [2 * x, 2 * y],
    [2 * x + 1, 2 * y],
    [2 * x, 2 * y + 1],
    [2 * x + 1, 2 * y + 1],
  ];
}

export class TileLayer {
  readonly group = new THREE.Group();
  private tiles = new Map<string, Tile>();
  private inflight = 0;
  private queue: Tile[] = [];
  private loader = new THREE.TextureLoader().setCrossOrigin("anonymous");
  private frustum = new THREE.Frustum();
  private projScreen = new THREE.Matrix4();
  private sphere = new THREE.Sphere();
  private lightsCache = new Map<string, Promise<THREE.Texture | null>>();
  private source: TileSource | null = SOURCES.realistic ?? null;
  private uniforms = {
    uNight: { value: null as THREE.Texture | null },
    uSpec: { value: null as THREE.Texture | null },
    uTopo: { value: null as THREE.Texture | null },
    uWater: { value: null as THREE.Texture | null },
    uSunDir: { value: new THREE.Vector3(1, 0, 0) },
    uCamPos: { value: new THREE.Vector3() },
    uMode: { value: 0 },
    uNightK: { value: 1 },
  };
  private frame = 0;
  /** Tiles drawn last frame and the deepest zoom among them. */
  drawn = 0;
  maxZoomDrawn = 0;

  constructor(private maxAnisotropy: number) {}

  get attribution() {
    return this.drawn > 0 && this.source ? this.source.attribution : null;
  }

  setShared(t: { night?: THREE.Texture | null; spec?: THREE.Texture | null; topo?: THREE.Texture | null; water?: THREE.Texture | null }) {
    this.uniforms.uNight.value = t.night ?? null;
    this.uniforms.uSpec.value = t.spec ?? null;
    this.uniforms.uTopo.value = t.topo ?? null;
    this.uniforms.uWater.value = t.water ?? null;
  }

  setMode(mode: ViewMode) {
    this.source = SOURCES[mode] ?? null;
    this.uniforms.uMode.value = { realistic: 0, imagery: 1, night: 2, terrain: 3, tactical: -1 }[mode];
    // stale queued requests from another source are dropped by the frame check in pump()
  }

  private get(z: number, x: number, y: number): Tile {
    const key = `${this.source!.id}/${z}/${x}/${y}`;
    let t = this.tiles.get(key);
    if (!t) {
      const lat0 = tileLat(y, z);
      const lat1 = tileLat(y + 1, z);
      const lon0 = tileLon(x, z);
      const lon1 = tileLon(x + 1, z);
      const corners = [
        llToVec(lat0, lon0),
        llToVec(lat0, lon1),
        llToVec(lat1, lon0),
        llToVec(lat1, lon1),
        llToVec((lat0 + lat1) / 2, lon0),
        llToVec((lat0 + lat1) / 2, lon1),
        llToVec(lat0, (lon0 + lon1) / 2),
        llToVec(lat1, (lon0 + lon1) / 2),
      ];
      const center = llToVec((lat0 + lat1) / 2, (lon0 + lon1) / 2);
      t = {
        key,
        z,
        x,
        y,
        state: "idle",
        mesh: null,
        texture: null,
        lights: null,
        center,
        corners,
        radius: Math.max(...corners.map((c) => c.distanceTo(center))) * 1.05,
        widthR: Math.cos((lat0 + lat1) / 2) * (lon1 - lon0),
        lastUsed: 0,
        shownAt: 0,
      };
      this.tiles.set(key, t);
    }
    return t;
  }

  private request(t: Tile) {
    if (t.state !== "idle") return;
    t.state = "loading";
    this.queue.push(t);
  }

  private pump() {
    if (!this.queue.length) return;
    // coarse tiles first so coverage arrives quickly
    this.queue.sort((a, b) => a.z - b.z || b.lastUsed - a.lastUsed);
    while (this.inflight < MAX_INFLIGHT && this.queue.length) {
      const t = this.queue.shift()!;
      if (this.frame - t.lastUsed > 20 || !this.source || !t.key.startsWith(this.source.id + "/")) {
        t.state = "idle"; // no longer wanted
        continue;
      }
      const src = this.source;
      this.inflight++;
      const lightsP = src.lights ? this.lightsFor(t.z, t.x, t.y) : Promise.resolve(null);
      this.loader.load(
        src.url(t.z, t.x, t.y),
        async (tex) => {
          const lights = await lightsP;
          this.inflight--;
          tex.colorSpace = src.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          tex.anisotropy = Math.min(8, this.maxAnisotropy);
          t.texture = tex;
          t.lights = lights;
          // map this tile into its Black Marble ancestor
          const lz = Math.min(t.z, LIGHTS.maxZ);
          const n = 2 ** (t.z - lz);
          const lightsUv = new THREE.Vector4((t.x % n) / n, 1 - ((t.y % n) + 1) / n, 1 / n, 1 / n);
          const mat = new THREE.ShaderMaterial({
            vertexShader: tileVertex,
            fragmentShader: tileFragment,
            uniforms: {
              ...this.uniforms,
              uMap: { value: tex },
              uFade: { value: 0 },
              uLights: { value: lights },
              uLightsUv: { value: lightsUv },
              uHasLights: { value: lights ? 1 : 0 },
            },
            transparent: true,
          });
          t.mesh = new THREE.Mesh(tileGeometry(t.z, t.x, t.y), mat);
          t.mesh.visible = false;
          t.mesh.frustumCulled = false;
          t.mesh.renderOrder = 1 + t.z * 0.01;
          this.group.add(t.mesh);
          t.state = "ready";
        },
        undefined,
        () => {
          this.inflight--;
          t.state = "error";
        },
      );
    }
  }

  /**
   * @param camLocal camera position in the globe's earth-fixed frame
   * @param earthMatrix the globe's world matrix
   */
  update(camLocal: THREE.Vector3, camera: THREE.PerspectiveCamera, earthMatrix: THREE.Matrix4, viewH: number, sunDir: THREE.Vector3) {
    this.frame++;
    this.uniforms.uSunDir.value.copy(sunDir);
    this.uniforms.uCamPos.value.copy(camera.position);
    for (const t of this.tiles.values()) if (t.mesh) t.mesh.visible = false;
    this.drawn = 0;
    this.maxZoomDrawn = 0;
    const alt = camLocal.length() - 1;
    this.uniforms.uNightK.value = THREE.MathUtils.lerp(0.12, 1, THREE.MathUtils.smoothstep(alt, 0.006, 0.08));
    if (!this.source || alt > 1.6) return;

    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(earthMatrix);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const pxPerRad = viewH / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    const camLen2 = camLocal.lengthSq();
    const maxZ = this.source.maxZ;
    const now = performance.now();

    const visible = (t: Tile) => {
      this.sphere.set(t.center, t.radius);
      if (!this.frustum.intersectsSphere(this.sphere)) return false;
      if (t.z < 3) return true;
      // horizon test: some part of the tile must face the camera
      if (t.center.dot(camLocal) > 1 - t.radius) return true;
      return t.corners.some((c) => c.dot(camLocal) > 1);
    };
    const wantsSplit = (t: Tile) => {
      if (t.z >= maxZ) return false;
      let d2 = camLen2 - 2 * t.center.dot(camLocal) + 1;
      for (const c of t.corners) d2 = Math.min(d2, camLen2 - 2 * c.dot(camLocal) + 1);
      const d = Math.sqrt(Math.max(d2, 1e-12));
      return (t.widthR / d) * pxPerRad > SPLIT_PX;
    };
    const draw = (t: Tile) => {
      if (!t.mesh || t.mesh.visible) return;
      if (t.shownAt === 0) t.shownAt = now;
      t.mesh.visible = true;
      (t.mesh.material as THREE.ShaderMaterial).uniforms.uFade.value = Math.min((now - t.shownAt) / 300, 1);
      this.drawn++;
      this.maxZoomDrawn = Math.max(this.maxZoomDrawn, t.z);
    };

    const visit = (z: number, x: number, y: number) => {
      const t = this.get(z, x, y);
      t.lastUsed = this.frame;
      if (!visible(t)) return;
      const split = wantsSplit(t);
      if (z < MIN_DRAW_Z) {
        if (split) for (const [cx, cy] of children(x, y)) visit(z + 1, cx, cy);
        return;
      }
      if (!split) {
        if (t.state === "ready") draw(t);
        else this.request(t);
        return;
      }
      // Descend only when every visible child is ready; otherwise keep this tile.
      const kids = children(x, y).map(([cx, cy]) => this.get(z + 1, cx, cy));
      let allReady = true;
      for (const k of kids) {
        k.lastUsed = this.frame;
        if (!visible(k)) continue;
        if (k.state !== "ready" && k.state !== "error") {
          allReady = false;
          this.request(k);
        }
      }
      if (allReady || t.state === "error") {
        for (const k of kids) visit(k.z, k.x, k.y);
      } else if (t.state === "ready") {
        draw(t);
      } else {
        this.request(t);
      }
    };

    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) visit(2, x, y);
    this.pump();
    if (this.frame % 120 === 0) this.evict();
  }

  private evict() {
    if (this.tiles.size <= MAX_CACHE) return;
    const old = [...this.tiles.values()].filter((t) => t.state !== "loading").sort((a, b) => a.lastUsed - b.lastUsed);
    for (const t of old.slice(0, this.tiles.size - MAX_CACHE)) {
      if (this.frame - t.lastUsed < 60) break;
      this.free(t);
      this.tiles.delete(t.key);
    }
  }

  /** Black Marble tile covering (z, x, y), shared between all its descendants. */
  private lightsFor(z: number, x: number, y: number) {
    const lz = Math.min(z, LIGHTS.maxZ);
    const n = 2 ** (z - lz);
    const lx = Math.floor(x / n);
    const ly = Math.floor(y / n);
    const key = `${lz}/${lx}/${ly}`;
    let p = this.lightsCache.get(key);
    if (!p) {
      p = new Promise((resolve) => {
        this.loader.load(
          LIGHTS.url(lz, lx, ly),
          (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.anisotropy = Math.min(8, this.maxAnisotropy);
            resolve(tex);
          },
          undefined,
          () => resolve(null),
        );
      });
      this.lightsCache.set(key, p);
    }
    return p;
  }

  private free(t: Tile) {
    if (t.mesh) {
      this.group.remove(t.mesh);
      t.mesh.geometry.dispose();
      (t.mesh.material as THREE.Material).dispose();
    }
    t.texture?.dispose();
  }

  dispose() {
    for (const t of this.tiles.values()) this.free(t);
    this.tiles.clear();
    for (const p of this.lightsCache.values()) void p.then((tex) => tex?.dispose());
    this.lightsCache.clear();
  }
}
