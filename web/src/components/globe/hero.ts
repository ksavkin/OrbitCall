import * as THREE from "three";

// High-detail model for the one selected satellite. The crowd uses cheap
// instancing; this one uses PBR materials, the real sun, and reflections of the
// actual scene (Earth, clouds, atmosphere) captured by a cube camera at its position.
// Local frame matches the instanced shader: x along-track, y orbit normal, z nadir.

export type HeroKind = "generic" | "starlink" | "debris";

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Crinkled multi-layer insulation: soft random creases as a bump map. */
function foilBump() {
  return canvasTexture(
    512,
    512,
    (g) => {
      g.fillStyle = "#808080";
      g.fillRect(0, 0, 512, 512);
      let seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < 900; i++) {
        const x = rnd() * 512;
        const y = rnd() * 512;
        const len = 10 + rnd() * 60;
        const a = rnd() * Math.PI;
        const v = Math.floor(90 + rnd() * 90);
        g.strokeStyle = `rgba(${v},${v},${v},0.35)`;
        g.lineWidth = 1 + rnd() * 3;
        g.beginPath();
        g.moveTo(x, y);
        g.quadraticCurveTo(x + Math.cos(a + 0.6) * len * 0.5, y + Math.sin(a + 0.6) * len * 0.5, x + Math.cos(a) * len, y + Math.sin(a) * len);
        g.stroke();
      }
    },
    false,
  );
}

/** Solar cells under cover glass: deep violet-blue, fine silver grid, panel hinges. */
function cellTexture(cols: number, rows: number) {
  return canvasTexture(1024, 512, (g) => {
    const bg = g.createLinearGradient(0, 0, 1024, 512);
    bg.addColorStop(0, "#2a1f6e");
    bg.addColorStop(0.5, "#22267a");
    bg.addColorStop(1, "#1b2466");
    g.fillStyle = bg;
    g.fillRect(0, 0, 1024, 512);
    const cw = 1024 / cols;
    const ch = 512 / rows;
    g.strokeStyle = "rgba(190,200,255,0.22)";
    g.lineWidth = 1.2;
    for (let i = 0; i <= cols; i++) {
      g.beginPath();
      g.moveTo(i * cw, 0);
      g.lineTo(i * cw, 512);
      g.stroke();
    }
    for (let j = 0; j <= rows; j++) {
      g.beginPath();
      g.moveTo(0, j * ch);
      g.lineTo(1024, j * ch);
      g.stroke();
    }
    // sparse sensor patches, like the small squares on real arrays
    g.fillStyle = "rgba(120,130,170,0.35)";
    for (let k = 0; k < 10; k++) g.fillRect(((k * 389) % 980) + 10, ((k * 211) % 470) + 10, 10, 10);
    // panel frame
    g.strokeStyle = "rgba(210,215,235,0.7)";
    g.lineWidth = 6;
    g.strokeRect(3, 3, 1018, 506);
  });
}

function phasedArrayTexture() {
  return canvasTexture(512, 512, (g) => {
    g.fillStyle = "#2a2d33";
    g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        g.fillStyle = (i + j) % 2 ? "#3a3e46" : "#34383f";
        g.fillRect(i * 128 + 6, j * 128 + 6, 116, 116);
        g.strokeStyle = "rgba(255,255,255,0.06)";
        g.strokeRect(i * 128 + 14, j * 128 + 14, 100, 100);
      }
    }
  });
}

/** Charcoal deck with brushed panels and the white SpaceX wordmark. */
function logoDeckTexture() {
  const c = document.createElement("canvas");
  c.width = 1536;
  c.height = 800;
  const g = c.getContext("2d")!;
  g.fillStyle = "#1c1e22";
  g.fillRect(0, 0, c.width, c.height);
  for (let y = 0; y < c.height; y += 3) {
    g.fillStyle = `rgba(255,255,255,${0.012 + 0.012 * Math.sin(y * 0.37)})`;
    g.fillRect(0, y, c.width, 1);
  }
  g.strokeStyle = "rgba(255,255,255,0.08)";
  g.lineWidth = 3;
  for (const x of [512, 1024]) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, c.height);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  const img = new Image();
  img.onload = () => {
    const w = 1100;
    const h = (w * 50) / 400;
    g.globalAlpha = 0.92;
    g.drawImage(img, (c.width - w) / 2, (c.height - h) / 2, w, h);
    t.needsUpdate = true;
  };
  img.src = "/brand/spacex-white.svg";
  return t;
}

export class HeroSatellite {
  readonly group = new THREE.Group();
  private sun = new THREE.DirectionalLight(0xfff4e8, 3.2);
  private earthshine = new THREE.HemisphereLight(0x0b1020, 0x3a5a8a, 0.55);
  // a little fill so the model never reads as a pure silhouette
  private fill = new THREE.AmbientLight(0x8090b0, 0.18);
  private models: Record<HeroKind, THREE.Group>;
  private kind: HeroKind = "generic";
  private envTex: THREE.Texture;
  private cubeRT: THREE.WebGLCubeRenderTarget;
  private cubeCam: THREE.CubeCamera;

  constructor() {
    // Reflections come from the real scene around the satellite.
    this.cubeRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
    this.cubeCam = new THREE.CubeCamera(0.0005, 800, this.cubeRT);
    this.envTex = this.cubeRT.texture;

    const bump = foilBump();
    const gold = new THREE.MeshPhysicalMaterial({
      color: 0xe0b04a,
      metalness: 1,
      roughness: 0.2,
      bumpMap: bump,
      bumpScale: 3.2,
      envMap: this.envTex,
      envMapIntensity: 1.4,
      clearcoat: 0.5,
      clearcoatRoughness: 0.15,
    });
    const blackMli = new THREE.MeshPhysicalMaterial({
      color: 0x15161a,
      metalness: 0.9,
      roughness: 0.25,
      bumpMap: bump,
      bumpScale: 2.6,
      envMap: this.envTex,
      envMapIntensity: 1.2,
      clearcoat: 0.6,
    });
    const reflector = new THREE.MeshStandardMaterial({ color: 0xf4f4f1, roughness: 0.42, metalness: 0, envMap: this.envTex, envMapIntensity: 0.5, side: THREE.DoubleSide });
    const silverFoil = new THREE.MeshPhysicalMaterial({
      color: 0xd8dade,
      metalness: 1,
      roughness: 0.28,
      bumpMap: bump,
      bumpScale: 1.6,
      envMap: this.envTex,
      envMapIntensity: 0.8,
    });
    const aluminium = new THREE.MeshStandardMaterial({ color: 0x9a9da3, roughness: 0.35, metalness: 0.9, envMap: this.envTex });
    const darkMetal = new THREE.MeshStandardMaterial({ color: 0x2b2d31, roughness: 0.45, metalness: 0.8, envMap: this.envTex });
    const lens = new THREE.MeshPhysicalMaterial({ color: 0x05070c, roughness: 0.05, metalness: 0.2, clearcoat: 1, envMap: this.envTex });
    // cover glass: a near-mirror over violet cells, so the arrays show the Earth
    const cells = new THREE.MeshPhysicalMaterial({
      map: cellTexture(14, 6),
      metalness: 0.75,
      roughness: 0.08,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
      envMap: this.envTex,
      envMapIntensity: 1.8,
    });
    const panelBack = new THREE.MeshStandardMaterial({ color: 0xb9bcc2, roughness: 0.6, metalness: 0.3, envMap: this.envTex });
    // box face order: +x, -x, +y, -y, +z (nadir), -z (zenith)
    const wingMats = [panelBack, panelBack, panelBack, panelBack, panelBack, cells];

    this.models = {
      generic: this.buildGeneric(gold, blackMli, reflector, aluminium, darkMetal, lens, wingMats),
      starlink: this.buildStarlink(silverFoil, aluminium, darkMetal, lens, wingMats),
      debris: this.buildDebris(gold, aluminium, darkMetal, cells),
    };
    this.group.add(this.models.generic, this.models.starlink, this.models.debris, this.earthshine, this.fill, this.sun, this.sun.target);
    this.models.starlink.visible = false;
    this.models.debris.visible = false;
    this.group.visible = false;
  }

  /** Wings rotate about the orbit-normal (y) axis to face the sun, like a real array drive. */
  private wings: THREE.Group[] = [];

  private wing(wingMats: THREE.Material[], panels: number, side: 1 | -1, start: number, w: number, l: number) {
    const g = new THREE.Group();
    this.wings.push(g);
    const gap = 0.025;
    for (let i = 0; i < panels; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, l, 0.022), wingMats);
      m.position.y = side * (start + l / 2 + i * (l + gap));
      g.add(m);
    }
    return g;
  }

  /** Telecom-style bus: gold and black MLI, two big side reflectors, long arrays. */
  private buildGeneric(
    gold: THREE.Material,
    blackMli: THREE.Material,
    reflector: THREE.Material,
    aluminium: THREE.Material,
    darkMetal: THREE.Material,
    lens: THREE.Material,
    wingMats: THREE.Material[],
  ) {
    const g = new THREE.Group();
    // bus: black MLI body with gold-wrapped equipment decks top and bottom
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.62, 0.62), blackMli));
    for (const z of [0.36, -0.36]) {
      const deck = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.56, 0.12), gold);
      deck.position.z = z;
      g.add(deck);
    }
    // gold-wrapped boxes and feed horns on the Earth deck
    const boxes: [number, number, number, number, number, number][] = [
      [0.18, 0.14, 0.12, -0.16, 0.12, 0.47],
      [0.12, 0.16, 0.1, 0.12, -0.14, 0.46],
      [0.1, 0.1, 0.16, 0.2, 0.16, 0.5],
    ];
    for (const [w, h, d, x, y, z] of boxes) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), gold);
      b.position.set(x, y, z);
      g.add(b);
    }
    for (const [x, y] of [[0.02, 0.02], [-0.08, -0.12]]) {
      const horn = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.065, 0.12, 20, 1, true), aluminium);
      horn.rotation.x = -Math.PI / 2;
      horn.position.set(x, y, 0.5);
      g.add(horn);
    }
    // two large shaped reflectors on deployment arms, one per side (along-track faces)
    const prof: THREE.Vector2[] = [];
    for (let i = 0; i <= 20; i++) {
      const r = (i / 20) * 0.5;
      prof.push(new THREE.Vector2(r, r * r * 0.55));
    }
    for (const s of [1, -1] as const) {
      const dish = new THREE.Mesh(new THREE.LatheGeometry(prof, 48), reflector);
      dish.scale.set(1, 1, 0.82); // slightly elliptical shaped reflector
      dish.rotation.set(0, s * (Math.PI / 2 - 0.5), 0);
      dish.rotation.order = "YXZ";
      dish.position.set(s * 0.72, 0, 0.12);
      g.add(dish);
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.42, 8), aluminium);
      arm.rotation.z = Math.PI / 2;
      arm.position.set(s * 0.5, 0, 0.12);
      g.add(arm);
      const hinge = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.08), darkMetal);
      hinge.position.set(s * 0.37, 0, 0.12);
      g.add(hinge);
    }
    // arrays: yoke truss + four mirror-glass panels per wing along the orbit normal
    for (const s of [1, -1] as const) {
      for (const dz of [0.14, -0.14]) {
        const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.42, 6), aluminium);
        strut.position.set(0, s * 0.5, dz * 0.5);
        strut.rotation.x = s * dz * 1.2;
        g.add(strut);
      }
      const drive = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.07, 18), darkMetal);
      drive.position.y = s * 0.34;
      g.add(drive);
      g.add(this.wing(wingMats, 4, s, 0.71, 0.64, 0.6));
    }
    // star trackers on the zenith deck
    for (const x of [-0.16, 0.16]) {
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, 0.12, 16), darkMetal);
      st.rotation.x = Math.PI / 2;
      st.position.set(x, 0.16, -0.48);
      g.add(st);
      const l = new THREE.Mesh(new THREE.CircleGeometry(0.032, 16), lens);
      l.position.set(x, 0.16, -0.541);
      l.rotation.x = Math.PI;
      g.add(l);
    }
    // apogee engine and thruster cluster
    const engine = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.11, 0.14, 24, 1, true), darkMetal);
    engine.rotation.x = Math.PI / 2;
    engine.position.z = -0.5;
    g.add(engine);
    for (const [x, y] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const t = new THREE.Mesh(new THREE.ConeGeometry(0.028, 0.07, 10, 1, true), darkMetal);
      t.rotation.x = -Math.PI / 2;
      t.position.set(x * 0.3, y * 0.26, -0.45);
      g.add(t);
    }
    // TT&C omni antenna mast
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.45, 6), aluminium);
    mast.rotation.x = Math.PI / 2;
    mast.position.set(0.25, -0.2, 0.64);
    g.add(mast);
    return g;
  }

  private buildStarlink(silver: THREE.Material, aluminium: THREE.Material, darkMetal: THREE.Material, lens: THREE.Material, wingMats: THREE.Material[]) {
    const g = new THREE.Group();
    // Flat-packed chassis: phased-array antennas face the ground, the zenith
    // deck carries the SpaceX wordmark (operator of the constellation).
    const array = new THREE.MeshStandardMaterial({ map: phasedArrayTexture(), roughness: 0.55, metalness: 0.5, envMap: this.envTex });
    const deck = new THREE.MeshPhysicalMaterial({
      map: logoDeckTexture(),
      roughness: 0.38,
      metalness: 0.6,
      clearcoat: 0.4,
      envMap: this.envTex,
      envMapIntensity: 0.6,
    });
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.78, 0.12), [silver, silver, silver, silver, array, deck]);
    g.add(chassis);
    const rim = new THREE.Mesh(new THREE.BoxGeometry(1.52, 0.8, 0.018), aluminium);
    rim.position.z = 0.062;
    g.add(rim);
    // two long arrays on booms along the orbit normal
    for (const s of [1, -1] as const) {
      const boom = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.26, 0.04), aluminium);
      boom.position.set(0, s * 0.52, -0.02);
      g.add(boom);
      const hinge = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.08, 14), darkMetal);
      hinge.position.set(0, s * 0.42, -0.02);
      g.add(hinge);
      const wing = this.wing(wingMats, 5, s, 0.64, 0.6, 0.27);
      wing.position.z = -0.02;
      g.add(wing);
    }
    // star trackers and a Hall-effect thruster on the zenith deck edge
    for (const x of [-0.6, 0.6]) {
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.08, 14), darkMetal);
      st.rotation.x = Math.PI / 2;
      st.position.set(x, 0.28, -0.1);
      g.add(st);
      const l = new THREE.Mesh(new THREE.CircleGeometry(0.027, 14), lens);
      l.position.set(x, 0.28, -0.141);
      l.rotation.x = Math.PI;
      g.add(l);
    }
    const thr = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.07, 18), darkMetal);
    thr.rotation.z = Math.PI / 2;
    thr.position.set(-0.78, 0, 0);
    g.add(thr);
    return g;
  }

  /** Wreckage: a torn array section bent at its hinge, a ripped honeycomb plate, foil shreds, cables. */
  private buildDebris(gold: THREE.Material, aluminium: THREE.Material, darkMetal: THREE.Material, cells: THREE.Material) {
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    /** Jagged polygon: a rectangle whose edges are torn on the given sides. */
    const torn = (w: number, h: number, tornSides: number[], jag: number) => {
      const pts: THREE.Vector2[] = [];
      const corners = [
        [-w / 2, -h / 2],
        [w / 2, -h / 2],
        [w / 2, h / 2],
        [-w / 2, h / 2],
      ];
      for (let e = 0; e < 4; e++) {
        const [x0, y0] = corners[e];
        const [x1, y1] = corners[(e + 1) % 4];
        const steps = tornSides.includes(e) ? 9 : 1;
        for (let k = 0; k < steps; k++) {
          const t = k / steps;
          let x = x0 + (x1 - x0) * t;
          let y = y0 + (y1 - y0) * t;
          if (tornSides.includes(e) && k > 0) {
            // push inward by a random bite
            const nx = -(y1 - y0);
            const ny = x1 - x0;
            const len = Math.hypot(nx, ny);
            const bite = rnd() * jag;
            x += (nx / len) * bite;
            y += (ny / len) * bite;
          }
          pts.push(new THREE.Vector2(x, y));
        }
      }
      return new THREE.Shape(pts);
    };
    /** Extrude and remap cap UVs to 0..1 so textures fit the piece. */
    const plate = (shape: THREE.Shape, depth: number) => {
      const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
      g.computeBoundingBox();
      const bb = g.boundingBox!;
      const uv = g.getAttribute("uv");
      const pos = g.getAttribute("position");
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, (pos.getX(i) - bb.min.x) / (bb.max.x - bb.min.x), (pos.getY(i) - bb.min.y) / (bb.max.y - bb.min.y));
      }
      g.translate(0, 0, -depth / 2);
      return g;
    };
    const g = new THREE.Group();
    // main array section: one panel, torn at the far edge
    const p1 = new THREE.Mesh(plate(torn(0.62, 0.9, [2], 0.16), 0.022), [cells, darkMetal]);
    g.add(p1);
    // second panel still on its hinge, bent back ~70 degrees and torn on two sides
    const hinge = new THREE.Group();
    hinge.position.set(0, -0.45, 0);
    hinge.rotation.x = -1.2;
    const p2 = new THREE.Mesh(plate(torn(0.62, 0.55, [1, 0], 0.14), 0.022), [cells, darkMetal]);
    p2.position.y = -0.275;
    hinge.add(p2);
    g.add(hinge);
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.64, 8), aluminium);
    pin.rotation.z = Math.PI / 2;
    pin.position.y = -0.45;
    g.add(pin);
    // ripped honeycomb structure plate behind the cells
    const honeycomb = new THREE.MeshStandardMaterial({ color: 0xc9ccd1, roughness: 0.3, metalness: 0.95, envMap: this.envTex, envMapIntensity: 1.3 });
    const hc = new THREE.Mesh(plate(torn(0.5, 0.42, [0, 1, 3], 0.12), 0.05), honeycomb);
    hc.position.set(0.18, 0.3, -0.06);
    hc.rotation.set(0.25, -0.35, 0.4);
    g.add(hc);
    // crumpled foil shreds
    for (let k = 0; k < 3; k++) {
      const geo = new THREE.PlaneGeometry(0.22, 0.14, 6, 4);
      const pp = geo.getAttribute("position");
      for (let i = 0; i < pp.count; i++) pp.setZ(i, (rnd() - 0.5) * 0.05);
      geo.computeVertexNormals();
      const shred = new THREE.Mesh(geo, gold);
      (shred.material as THREE.Material).side = THREE.DoubleSide;
      shred.position.set(-0.3 + k * 0.16, 0.38 - k * 0.2, 0.06);
      shred.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
      g.add(shred);
    }
    // loose harness cables trailing off the torn edge
    for (let c = 0; c < 2; c++) {
      const pts = Array.from({ length: 6 }, (_, i) => new THREE.Vector3(-0.15 + c * 0.2 + (rnd() - 0.5) * 0.08, 0.42 + i * 0.07, (rnd() - 0.5) * 0.12));
      g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.008, 5), darkMetal));
    }
    g.scale.setScalar(3.4); // fills the same footprint as the 4-unit satellite models
    const wrap = new THREE.Group();
    wrap.add(g);
    return wrap;
  }

  /** Re-render the surroundings into the reflection map (hide what should not reflect first). */
  capture(renderer: THREE.WebGLRenderer, scene: THREE.Scene, at: THREE.Vector3) {
    this.cubeCam.position.copy(at);
    const tm = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    this.cubeCam.update(renderer, scene);
    renderer.toneMapping = tm;
    // ask three.js to rebuild the prefiltered (roughness) maps from the new capture
    (this.cubeRT.texture as THREE.Texture & { needsPMREMUpdate?: boolean }).needsPMREMUpdate = true;
  }

  setKind(kind: HeroKind) {
    this.kind = kind;
    this.models.generic.visible = kind === "generic";
    this.models.starlink.visible = kind === "starlink";
    this.models.debris.visible = kind === "debris";
  }

  /**
   * @param pos satellite position (scene units)
   * @param vel velocity, for attitude
   * @param scale local-unit → scene-unit scale (same rule as the instanced shader)
   */
  update(pos: THREE.Vector3, vel: THREE.Vector3, scale: number, sunDir: THREE.Vector3, sunlit: boolean) {
    const zA = pos.clone().normalize().negate();
    const xA = vel.clone().addScaledVector(zA, -vel.dot(zA)).normalize();
    const yA = new THREE.Vector3().crossVectors(zA, xA);
    const m = new THREE.Matrix4().makeBasis(xA, yA, zA);
    const model = this.models[this.kind];
    model.position.copy(pos);
    model.quaternion.setFromRotationMatrix(m);
    if (this.kind === "debris") {
      // uncontrolled tumble
      const t = performance.now() / 1000;
      model.children[0].rotation.set(t * 0.31, t * 0.53, t * 0.17);
    }
    model.scale.setScalar(scale);
    // point the cell side (-z) of each wing at the sun, rotating about the wing axis
    const sLocal = sunDir.clone().applyQuaternion(model.quaternion.clone().invert());
    if (sunlit && this.kind !== "debris") {
      const theta = Math.atan2(-sLocal.x, -sLocal.z);
      for (const w of this.wings) {
        let d = theta - w.rotation.y;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        w.rotation.y += d * 0.06;
      }
    }
    this.sun.position.copy(pos).addScaledVector(sunDir, 10);
    this.sun.target.position.copy(pos);
    // ease the sun in and out across the terminator instead of snapping
    const target = sunlit ? 3.2 : 0;
    this.sun.intensity += (target - this.sun.intensity) * 0.08;
  }

  dispose() {
    this.cubeRT.dispose();
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const mat of mats) {
        const map = (mat as THREE.MeshStandardMaterial).map;
        map?.dispose();
        mat.dispose();
      }
    });
  }
}
