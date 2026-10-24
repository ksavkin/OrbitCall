import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

// Local frame used by the satellite shader: x along-track, y orbit normal
// (solar array axis), z toward nadir. The model spans about 4 units along y.

function part(g: THREE.BufferGeometry, id: number, at: [number, number, number], rot?: THREE.Euler) {
  const geo = g.index ? g.toNonIndexed() : g;
  if (rot) geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(rot));
  geo.translate(...at);
  geo.deleteAttribute("uv");
  const n = geo.getAttribute("position").count;
  geo.setAttribute("aPart", new THREE.Float32BufferAttribute(new Float32Array(n).fill(id), 1));
  return geo;
}

/** Generic three-axis-stabilized satellite: bus, two solar wings, booms, dish. */
export function satelliteGeometry() {
  const parts = [
    part(new THREE.BoxGeometry(0.62, 0.62, 0.78), 0, [0, 0, 0]),
    // solar wings (local xy carries the cell grid in the shader)
    part(new THREE.BoxGeometry(0.56, 1.45, 0.025), 1, [0, 1.25, 0]),
    part(new THREE.BoxGeometry(0.56, 1.45, 0.025), 1, [0, -1.25, 0]),
    // booms
    part(new THREE.BoxGeometry(0.05, 0.22, 0.05), 3, [0, 0.42, 0]),
    part(new THREE.BoxGeometry(0.05, 0.22, 0.05), 3, [0, -0.42, 0]),
    // nadir dish
    part(new THREE.CylinderGeometry(0.24, 0.04, 0.12, 14, 1, true), 2, [0, 0, 0.47], new THREE.Euler(-Math.PI / 2, 0, 0)),
    // top antenna mast
    part(new THREE.CylinderGeometry(0.02, 0.02, 0.32, 5), 3, [0.12, 0, -0.55], new THREE.Euler(Math.PI / 2, 0, 0)),
  ];
  const g = mergeGeometries(parts);
  g.computeBoundingSphere();
  return g;
}

/** Irregular fragment for debris. */
export function debrisGeometry() {
  const g = new THREE.IcosahedronGeometry(0.9, 0); // already non-indexed
  const pos = g.getAttribute("position");
  // deterministic jitter so fragments look broken, not round
  for (let i = 0; i < pos.count; i++) {
    const s = 0.65 + 0.55 * Math.abs(Math.sin(i * 12.9898) * 0.5);
    pos.setXYZ(i, pos.getX(i) * s, pos.getY(i) * s * 0.55, pos.getZ(i) * s);
  }
  g.computeVertexNormals();
  g.deleteAttribute("uv");
  g.setAttribute("aPart", new THREE.Float32BufferAttribute(new Float32Array(pos.count).fill(4), 1));
  return g;
}
