// GLSL for the globe. Kept as plain strings so three.js ShaderMaterial can use them.

export const VIEW_MODES = ["realistic", "imagery", "night", "terrain", "tactical"] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

/* ------------------------------------------------------------------ Earth */

export const earthVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec3 vObjN;
  void main() {
    vUv = uv;
    vObjN = normalize(position);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vPosW = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const earthFragment = /* glsl */ `
  uniform mat4 modelMatrix; // three.js only declares it for the vertex stage
  uniform sampler2D uDay;
  uniform sampler2D uNight;
  uniform sampler2D uSpec;
  uniform sampler2D uNormal;
  uniform sampler2D uTopo;
  uniform sampler2D uWater;
  uniform int uMode;
  uniform vec3 uSunDir;
  uniform vec3 uCamPos;
  uniform vec3 uLightView; // terrain hillshade light, follows the camera
  uniform float uDots;     // tactical density level (integer part) + crossfade (fraction)
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec3 vObjN;

  const float PI = 3.14159265359;

  vec3 perturb(vec3 n, vec3 tex, float strength) {
    // Analytic sphere tangent frame (no tangent attribute needed).
    vec3 t = normalize(cross(vec3(0.0, 1.0, 0.0), vObjN) + vec3(1e-5));
    vec3 b = cross(vObjN, t);
    vec3 m = tex * 2.0 - 1.0;
    m.xy *= strength;
    vec3 nObj = normalize(t * m.x + b * m.y + vObjN * m.z);
    return normalize(mat3(modelMatrix) * nObj);
  }

  float landMask(vec2 uv) {
    // earth-water.png: oceans bright, land dark.
    return 1.0 - smoothstep(0.35, 0.65, texture2D(uWater, uv).r);
  }

  // Signed distance to a pointy-top hexagon of inradius r.
  float sdHex(vec2 p, float r) {
    const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
    p = abs(p.yx);
    p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
    p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
    return length(p) * sign(p.y);
  }

  // One hex layer with "rows" latitude bands; odd rows are offset half a cell.
  // Returns coverage on land (x) and over the ocean (y).
  vec2 hexLayer(float rows) {
    float lat = (vUv.y - 0.5) * PI;
    float row = floor(vUv.y * rows);
    float latC = ((row + 0.5) / rows - 0.5) * PI;
    float cols = max(floor(rows * 2.0 * cos(latC)), 1.0);
    float shift = mod(row, 2.0) * 0.5;
    float cx = vUv.x * cols + shift;
    float colI = floor(cx);
    vec2 cellUv = vec2((colI + 0.5 - shift) / cols, (row + 0.5) / rows);
    vec2 f = vec2(fract(cx), fract(vUv.y * rows)) - 0.5;
    f.x *= cos(lat) * 2.0 * rows / cols; // cells are square on the sphere
    float d = sdHex(f, 0.17);
    float aa = max(fwidth(d), 1e-4);
    float a = 1.0 - smoothstep(-aa, aa, d);
    float land = landMask(cellUv);
    return vec2(a * land, a * (1.0 - land));
  }

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(uCamPos - vPosW);
    float sunN = dot(N, uSunDir);
    float dayMix = smoothstep(-0.10, 0.22, sunN);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    vec3 col;

    if (uMode == 0) {
      // Realistic: day/night terminator from the real sun position.
      vec3 Np = perturb(N, texture2D(uNormal, vUv).rgb, 0.9);
      float ndl = max(dot(Np, uSunDir), 0.0);
      vec3 day = texture2D(uDay, vUv).rgb;
      day = pow(day, vec3(1.08));
      // warm the terminator band slightly
      vec3 term = mix(vec3(1.0, 0.62, 0.38), vec3(1.0), smoothstep(0.0, 0.35, sunN));
      vec3 lit = day * term * (0.04 + 1.15 * ndl);
      vec3 night = texture2D(uNight, vUv).rgb;
      night = pow(night, vec3(1.6)) * vec3(1.0, 0.78, 0.52) * 2.2;
      night += day * vec3(0.05, 0.065, 0.09); // moonlit ground keeps the texture
      col = mix(night, lit, dayMix);
      float ocean = texture2D(uSpec, vUv).r;
      vec3 R = reflect(-uSunDir, Np);
      float spec = pow(max(dot(R, V), 0.0), 38.0) * ocean * dayMix;
      col += vec3(1.0, 0.92, 0.8) * spec * 0.55;
      col += vec3(0.30, 0.55, 1.0) * fres * (0.10 + 0.9 * dayMix) * 0.9;
    } else if (uMode == 1) {
      // Imagery: evenly lit satellite mosaic, like a map's satellite layer.
      vec3 Np = perturb(N, texture2D(uNormal, vUv).rgb, 1.4);
      float relief = 0.86 + 0.14 * dot(Np, normalize(V + vec3(0.0, 0.3, 0.0)));
      col = texture2D(uDay, vUv).rgb * relief * 1.08;
      col += vec3(0.35, 0.55, 1.0) * fres * 0.35;
    } else if (uMode == 2) {
      // Night: city lights everywhere, faint coastlines.
      vec3 night = texture2D(uNight, vUv).rgb;
      col = pow(night, vec3(1.35)) * vec3(1.0, 0.8, 0.55) * 2.0;
      col += texture2D(uDay, vUv).rgb * vec3(0.06, 0.08, 0.11);
      float land = landMask(vUv);
      vec2 px = vec2(1.0 / 1600.0, 1.0 / 800.0);
      float edge = abs(landMask(vUv + vec2(px.x, 0.0)) - landMask(vUv - vec2(px.x, 0.0)))
                 + abs(landMask(vUv + vec2(0.0, px.y)) - landMask(vUv - vec2(0.0, px.y)));
      col += vec3(0.02, 0.03, 0.05) + land * vec3(0.012, 0.014, 0.018);
      col += vec3(0.25, 0.32, 0.42) * clamp(edge, 0.0, 1.0) * 0.35;
      col += vec3(0.25, 0.4, 0.8) * fres * 0.25;
    } else if (uMode == 3) {
      // Terrain: shaded relief + hypsometric tint + contour lines.
      vec2 px = vec2(1.0 / 2048.0, 1.0 / 1024.0);
      float h = texture2D(uTopo, vUv).r;
      float hx = texture2D(uTopo, vUv + vec2(px.x, 0.0)).r - texture2D(uTopo, vUv - vec2(px.x, 0.0)).r;
      float hy = texture2D(uTopo, vUv + vec2(0.0, px.y)).r - texture2D(uTopo, vUv - vec2(0.0, px.y)).r;
      vec3 nT = normalize(vec3(-hx * 9.0, -hy * 9.0, 1.0));
      vec3 t = normalize(cross(vec3(0.0, 1.0, 0.0), vObjN) + vec3(1e-5));
      vec3 b = cross(vObjN, t);
      vec3 Nr = normalize(mat3(modelMatrix) * normalize(t * nT.x + b * nT.y + vObjN * nT.z));
      float shade = clamp(dot(Nr, uLightView) * 0.75 + 0.35, 0.0, 1.3);
      float land = landMask(vUv);
      vec3 sea = mix(vec3(0.030, 0.045, 0.070), vec3(0.055, 0.080, 0.115), fres);
      vec3 low = vec3(0.16, 0.18, 0.20);
      vec3 high = vec3(0.86, 0.88, 0.90);
      vec3 ground = mix(low, high, pow(clamp(h * 1.15, 0.0, 1.0), 0.8));
      col = mix(sea, ground * shade, land);
      float lines = h * 14.0;
      float c = abs(fract(lines - 0.5) - 0.5) / max(fwidth(lines), 1e-4);
      col += land * (1.0 - min(c, 1.0)) * 0.07;
      col += vec3(0.6, 0.7, 0.85) * fres * 0.18;
    } else {
      // Tactical: hexagon dot-matrix continents on fixed density levels.
      // Levels double in density and crossfade, so dots never slide on zoom.
      float lvl = floor(uDots);
      float t = smoothstep(0.15, 0.85, fract(uDots));
      float rows0 = 150.0 * exp2(lvl);
      vec2 h0 = hexLayer(rows0);
      vec2 h1 = hexLayer(rows0 * 2.0);
      vec2 h = mix(h0, h1, t);
      float lightSide = mix(0.5, 1.0, dayMix);
      col = vec3(0.035, 0.037, 0.042);
      col += vec3(0.84, 0.86, 0.89) * h.x * 0.7 * lightSide;
      col += vec3(0.6, 0.65, 0.7) * h.y * 0.05;
      // graticule every 15 degrees
      vec2 g = vec2(vUv.x * 24.0, vUv.y * 12.0);
      vec2 gl = abs(fract(g - 0.5) - 0.5) / max(fwidth(g), vec2(1e-4));
      float grid = 1.0 - min(min(gl.x, gl.y), 1.0);
      col += vec3(1.0) * grid * 0.035;
      col += vec3(0.75, 0.8, 0.9) * fres * 0.22;
    }

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

/* ----------------------------------------------------------------- Clouds */

export const cloudsFragment = /* glsl */ `
  uniform sampler2D uClouds;
  uniform vec3 uSunDir;
  uniform float uOpacity;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec3 vObjN;
  void main() {
    vec3 N = normalize(vNormalW);
    float sunN = dot(N, uSunDir);
    float lit = smoothstep(-0.15, 0.35, sunN);
    float c = texture2D(uClouds, vUv).r;
    c = smoothstep(0.08, 0.9, c);
    vec3 col = mix(vec3(0.02, 0.025, 0.035), vec3(1.0, 0.98, 0.96), lit);
    col *= mix(vec3(1.0, 0.7, 0.5), vec3(1.0), smoothstep(0.0, 0.3, sunN));
    gl_FragColor = vec4(col, c * uOpacity * (0.25 + 0.75 * lit));
    #include <colorspace_fragment>
  }
`;

/* ------------------------------------------------------------- Atmosphere */

export const atmosphereVertex = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vPosW = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const atmosphereFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uSunDir;
  uniform vec3 uCamPos;
  uniform float uIntensity;
  uniform float uSunWeight;
  uniform float uScaleHeight; // in earth radii
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    // Impact parameter of the view ray: how close it passes to Earth's center.
    vec3 d = normalize(vPosW - uCamPos);
    vec3 closest = uCamPos - dot(uCamPos, d) * d;
    float h = length(closest);
    float glow = exp(-max(h - 1.0, 0.0) / uScaleHeight);
    float sun = smoothstep(-0.35, 0.45, dot(normalize(closest), uSunDir));
    float a = glow * uIntensity * mix(1.0, 0.08 + 0.92 * sun, uSunWeight);
    gl_FragColor = vec4(uColor * a, a);
    #include <colorspace_fragment>
  }
`;

/* -------------------------------------------------------------- Satellites */

/** Shared chunk: position at sample time + second-order extrapolation to now. */
const satMotion = /* glsl */ `
  attribute vec3 aPos;
  attribute vec3 aVel;
  attribute vec3 aColor;
  attribute float aIndex;
  attribute float aVisible;
  uniform float uDt;       // sim seconds since the sample
  uniform float uMu;       // GM in (earth radii)^3 / s^2
  uniform vec3 uSunDir;
  uniform float uHover;
  uniform float uSelected;
  uniform float uHideSelected; // the PBR hero model draws the selected object
  vec3 currentPos() {
    float r = length(aPos);
    vec3 acc = -uMu * aPos / (r * r * r);
    return aPos + aVel * uDt + 0.5 * acc * uDt * uDt;
  }
  float shadowOf(vec3 p) {
    // Cylindrical umbra: behind Earth relative to the sun and within 1 radius of the axis.
    float along = dot(p, uSunDir);
    float perp = length(p - along * uSunDir);
    return (along < 0.0 && perp < 1.0) ? 1.0 : 0.0;
  }
`;

export const satVertex = /* glsl */ `
  ${satMotion}
  attribute float aPart;
  uniform float uPxScale;  // world units per pixel at distance 1
  uniform float uPx;       // target model size in pixels
  uniform float uPxFocus;  // size of the selected model
  uniform float uTime;
  uniform vec3 uCamPos;
  varying vec3 vN;
  varying vec3 vColor;
  varying float vPart;
  varying vec3 vLocal;
  varying float vShadow;
  varying float vFocus;
  varying vec3 vViewDir;

  mat3 rotAxis(vec3 a, float ang) {
    float s = sin(ang), c = cos(ang), oc = 1.0 - c;
    return mat3(oc*a.x*a.x + c,     oc*a.x*a.y + a.z*s, oc*a.z*a.x - a.y*s,
                oc*a.x*a.y - a.z*s, oc*a.y*a.y + c,     oc*a.y*a.z + a.x*s,
                oc*a.z*a.x + a.y*s, oc*a.y*a.z - a.x*s, oc*a.z*a.z + c);
  }
  float hash(float n) { return fract(sin(n) * 43758.5453123); }

  void main() {
    vec3 p = currentPos();
    float hovered = abs(aIndex - uHover) < 0.5 ? 1.0 : 0.0;
    float selected = abs(aIndex - uSelected) < 0.5 ? 1.0 : 0.0;
    vFocus = max(hovered, selected);

    // Attitude: z toward nadir, x along velocity, y along the orbit normal (solar array axis).
    vec3 zA = -normalize(p);
    vec3 xA = normalize(aVel - dot(aVel, zA) * zA + vec3(1e-6));
    vec3 yA = cross(zA, xA);
    mat3 basis = mat3(xA, yA, zA);

    vec3 local = position;
    vec3 nrm = normal;
    if (aPart > 3.5) {
      // Debris: tumble around a per-object axis.
      vec3 axis = normalize(vec3(hash(aIndex) - 0.5, hash(aIndex + 1.7) - 0.5, hash(aIndex + 3.1) - 0.5));
      mat3 r = rotAxis(axis, uTime * (0.4 + hash(aIndex + 5.0)) + hash(aIndex) * 6.28);
      local = r * local;
      nrm = r * nrm;
    }

    float dist = length(uCamPos - p);
    float px = mix(uPx, uPxFocus, selected);
    px *= 1.0 + 0.45 * hovered;
    float scale = px * uPxScale * dist / 4.0;   // model spans ~4 local units
    // Below ~6 px a model is just noise: let the glow dot carry it, except in focus.
    scale *= max(smoothstep(4.5, 7.0, px), vFocus);
    scale *= aVisible * (1.0 - selected * uHideSelected);

    vec3 wp = p + basis * (local * scale);
    vN = normalize(basis * nrm);
    vLocal = position;
    vPart = aPart;
    vColor = aColor;
    vShadow = shadowOf(p);
    vViewDir = normalize(uCamPos - wp);
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

export const satFragment = /* glsl */ `
  uniform vec3 uSunDir;
  varying vec3 vN;
  varying vec3 vColor;
  varying float vPart;
  varying vec3 vLocal;
  varying float vShadow;
  varying float vFocus;
  varying vec3 vViewDir;
  void main() {
    vec3 N = normalize(vN);
    if (!gl_FrontFacing) N = -N;
    float sunLight = (1.0 - vShadow * 0.88);
    float ndl = max(dot(N, uSunDir), 0.0) * sunLight;
    vec3 base;
    float specK = 0.0;
    if (vPart < 0.5) {
      // bus: crinkled gold MLI foil with a thin category-colored band
      float crinkle = 0.85 + 0.15 * sin(vLocal.x * 41.0 + sin(vLocal.y * 37.0) * 2.0) * sin(vLocal.z * 29.0);
      base = vec3(0.80, 0.60, 0.26) * crinkle;
      if (abs(vLocal.z) < 0.06) base = mix(base, vColor, 0.8);
      specK = 0.9;
    } else if (vPart < 1.5) {
      // solar array: blue-black cells with a fine grid
      vec2 g = abs(fract(vLocal.xy * vec2(6.0, 10.0)) - 0.5);
      float grid = step(0.44, max(g.x, g.y));
      base = mix(vec3(0.09, 0.13, 0.24), vec3(0.55, 0.6, 0.68), grid);
      specK = 1.0;
    } else if (vPart < 2.5) {
      base = vec3(0.86, 0.87, 0.88); // antenna dish
      specK = 0.4;
    } else if (vPart < 3.5) {
      base = vec3(0.45, 0.46, 0.48); // booms
    } else {
      base = mix(vec3(0.42, 0.40, 0.38), vColor, 0.35); // debris fragment
      specK = 0.3;
    }
    vec3 H = normalize(uSunDir + vViewDir);
    float spec = pow(max(dot(N, H), 0.0), 40.0) * specK * sunLight;
    vec3 col = base * (0.28 + 1.05 * ndl) + vec3(spec);
    // rim light so models read against the black sky
    float rim = pow(1.0 - max(dot(N, vViewDir), 0.0), 2.0);
    col += vColor * rim * (0.35 + 0.6 * vFocus);
    col = mix(col, col * 1.35 + 0.05, vFocus);
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

/** Far-field glow dots: carry the category color when models are only a few pixels. */
export const dotVertex = /* glsl */ `
  ${satMotion}
  uniform float uDotPx;
  uniform float uPixelRatio;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec3 p = currentPos();
    float focus = (abs(aIndex - uHover) < 0.5 || abs(aIndex - uSelected) < 0.5) ? 1.0 : 0.0;
    vColor = aColor;
    vAlpha = aVisible * (1.0 - 0.6 * shadowOf(p));
    vec4 mv = viewMatrix * vec4(p, 1.0);
    float isSel = abs(aIndex - uSelected) < 0.5 ? 1.0 : 0.0;
    gl_PointSize = uDotPx * uPixelRatio * (1.0 + focus * 1.5) * aVisible * (1.0 - isSel * uHideSelected);
    gl_Position = projectionMatrix * mv;
  }
`;

export const dotFragment = /* glsl */ `
  uniform float uDotAlpha;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float core = 1.0 - smoothstep(0.2, 0.3, d);
    float halo = exp(-d * d * 14.0) * 0.5;
    float a = (core + halo) * vAlpha * uDotAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor * (core * 1.2 + halo), a);
    #include <colorspace_fragment>
  }
`;

/* ------------------------------------------------------------------ Stars */

export const starsFragment = /* glsl */ `
  uniform sampler2D uStars;
  uniform float uIntensity;
  varying vec2 vUv;
  void main() {
    vec3 s = texture2D(uStars, vUv).rgb;
    s = pow(s, vec3(1.6)) * uIntensity;
    gl_FragColor = vec4(s, 1.0);
    #include <colorspace_fragment>
  }
`;

export const simpleVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec3 vObjN;
  void main() {
    vUv = uv;
    vObjN = normalize(position);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vPosW = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
