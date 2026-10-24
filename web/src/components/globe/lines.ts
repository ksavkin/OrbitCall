import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

/** Screen-space fat line material; vertex brightness becomes alpha (see below). */
export function lineMaterial(width: number, opacity: number, dashed = false) {
  const m = new LineMaterial({
    linewidth: width,
    vertexColors: true,
    transparent: true,
    opacity,
    depthWrite: false,
    worldUnits: false,
    dashed,
    dashSize: 0.02,
    gapSize: 0.012,
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
}

export function makeLine(width: number, opacity: number, dashed = false) {
  const l = new Line2(new LineGeometry(), lineMaterial(width, opacity, dashed));
  l.frustumCulled = false;
  l.visible = false;
  return l;
}

/** Brightest at the middle of the path (the event), fading both ways to `tailK`. */
export function setCenteredLine(line: Line2, points: Float32Array, head: THREE.Color, tail: THREE.Color, tailK: number) {
  const count = points.length / 3;
  const colors = new Float32Array(points.length);
  const c = new THREE.Color();
  for (let s = 0; s < count; s++) {
    const u = Math.abs(s / (count - 1) - 0.5) * 2;
    c.copy(head)
      .lerp(tail, Math.min(u * 2.2, 1))
      .multiplyScalar(THREE.MathUtils.lerp(1, tailK, Math.pow(u, 0.6)));
    c.toArray(colors, s * 3);
  }
  const g = new LineGeometry();
  g.setPositions(points);
  g.setColors(colors);
  line.geometry.dispose();
  line.geometry = g;
}
