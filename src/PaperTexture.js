/**
 * PaperTexture — 300 lb cold-press rough watercolour paper.
 *
 * Reference descriptors:
 *   Structure : "Deep tooth", "Coarse grain", "Fibrous", "Cold-press", "Handmade"
 *   Appearance: "Matte", "Absorbent", "Archival"
 *   Lighting  : "Raking light", "High-contrast"
 *
 * Two-pass CPU generation (runs once at load):
 *
 *   Pass 1 — Height map
 *     • Coarse Worley (scale 4)   — primary deep-tooth bumps (~250 px / cell)
 *     • Medium Worley (scale 11)  — secondary grain structure
 *     • Fine Worley   (scale 32)  — surface pitting
 *     • Micro Worley  (scale 90)  — micro pores
 *     • F₂−F₁ Worley ridge lines  — sharp grain-boundary highlight
 *     • FBM-displaced fiber noise — organic winding paper-pulp fibres
 *     • Macro FBM                 — handmade thickness variation
 *
 *   Pass 2 — Raking light
 *     • Sobel surface normals from height field
 *     • Directional light at ~15° elevation from upper-left
 *       (raking = light nearly parallel to surface → long shadows)
 *     • Luminance range: valley ≈ 0.26, lit ridge ≈ 0.98
 *       (high-contrast as demanded by prompt)
 */

import * as THREE from 'three';

export function buildPaperTexture(size = 1024) {

  // ── Deterministic hash ─────────────────────────────────────────────────────
  const h = (x, y) => {
    const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return v - Math.floor(v);
  };

  // ── Smooth value noise ─────────────────────────────────────────────────────
  const vnoise = (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix,        fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    return (h(ix,   iy)   * (1 - ux) + h(ix+1, iy)   * ux) * (1 - uy)
         + (h(ix,   iy+1) * (1 - ux) + h(ix+1, iy+1) * ux) * uy;
  };

  // ── FBM (fractal Brownian motion) ──────────────────────────────────────────
  const fbm = (x, y, oct) => {
    let v = 0, amp = 0.5, freq = 1;
    for (let i = 0; i < oct; i++) {
      v += vnoise(x * freq, y * freq) * amp;
      freq *= 2.07; amp *= 0.48;
    }
    return v;
  };

  // ── Worley nearest-cell + second-nearest (F₁ and F₂) ─────────────────────
  const worley = (x, y, scale) => {
    const sx = x * scale, sy = y * scale;
    const ix = Math.floor(sx), iy = Math.floor(sy);
    let f1 = 999, f2 = 999;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const jx = ix + dx, jy = iy + dy;
        const cx = jx + h(jx + 17, jy + 3);
        const cy = jy + h(jy + 43, jx + 7);
        const d  = Math.sqrt((sx - cx) ** 2 + (sy - cy) ** 2);
        if (d < f1) { f2 = f1; f1 = d; }
        else if (d < f2) { f2 = d; }
      }
    }
    return { f1: Math.min(f1 / 0.80, 1.0), f2: Math.min(f2 / 0.80, 1.0) };
  };

  // ── FBM-displaced anisotropic fibre noise ─────────────────────────────────
  // FBM warp makes fibres wind organically — matches real cotton-rag paper pulp.
  const fiberNoise = (ux, uy) => {
    // Domain warp: displace fibre coordinates by FBM
    const wx = fbm(ux * 3.1,       uy * 3.1,       3) * 0.05;
    const wy = fbm(ux * 3.1 + 5.2, uy * 3.1 + 1.3, 3) * 0.05;

    // Primary long near-horizontal fibres (high anisotropy)
    const f1 = vnoise((ux + wx) * 420 + 3,  (uy + wy) * 14);
    const f2 = vnoise((ux + wx) * 290 + 11, (uy + wy) * 26 + 7);
    const f3 = vnoise((ux + wy) * 180 + 23, (uy + wx) * 38 + 19);

    // Cross-fibres (perpendicular pulp bundles — "fibrous" descriptor)
    const c1 = vnoise((ux + wy) * 22  + 13, (uy + wx) * 410 + 5);
    const c2 = vnoise((ux + wx) * 11  + 71, (uy + wy) * 550 + 2);

    // Fine fibre surface fuzz
    const fuzz = vnoise((ux + wx) * 750 + 37, (uy + wy) * 8);

    return f1 * 0.30 + f2 * 0.23 + f3 * 0.16
         + c1 * 0.17 + c2 * 0.09 + fuzz * 0.05;
  };

  // ──────────────────────────────────────────────────────────────────────────
  // PASS 1 — Build normalised height field [0..1]
  //          1 = ridge / bump peak   0 = deep valley
  // ──────────────────────────────────────────────────────────────────────────
  const heights = new Float32Array(size * size);

  for (let py = 0; py < size; py++) {
    const uy = py / size;
    for (let px = 0; px < size; px++) {
      const ux = px / size;

      // Coarse Worley — primary deep-tooth bumps (300 lb rough cold-press)
      const wC = worley(ux, uy,  4.0);
      const wM = worley(ux, uy, 11.0);
      const wF = worley(ux, uy, 32.0);
      const wU = worley(ux, uy, 90.0);

      // Cell-centre peaks: 1−F₁ raised to power → narrow bright ridges, flat dark valleys
      const toothCoarse = Math.pow(1.0 - wC.f1, 3.5) * 0.42;  // deep tooth — dominant
      const toothMed    = Math.pow(1.0 - wM.f1, 2.5) * 0.22;
      const toothFine   = Math.pow(1.0 - wF.f1, 2.0) * 0.14;
      const toothMicro  = (1.0 - wU.f1)              * 0.07;

      // F₂−F₁ ridge lines — sharp bright edges at Voronoi cell boundaries
      // This is the "deep grain edge" characteristic of cold-press paper
      const edgeRidge = Math.min(wC.f2 - wC.f1, 1.0) * 0.11;

      // Fibre texture (adds fibrous surface structure to bumps)
      const fiber = fiberNoise(ux, uy);

      // Macro handmade variation — large-scale uneven pressing / thickness
      const macro = fbm(ux * 1.8 + 0.4, uy * 1.8 + 0.9, 4);

      // Combine: all contributions sum to ≈[0..1]
      let height = toothCoarse + toothMed + toothFine + toothMicro
                 + edgeRidge
                 + fiber * 0.09
                 + macro * 0.07;

      heights[py * size + px] = Math.min(1.0, Math.max(0.0, height));
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PASS 2 — Raking light + final luminance
  //
  // "Raking light" = light nearly parallel to the surface.
  // Light elevation ~15° → long shadows, very high valley/ridge contrast.
  // Light direction: upper-left  (lx > 0, ly > 0, lz small)
  // ──────────────────────────────────────────────────────────────────────────
  const canvas  = document.createElement('canvas');
  canvas.width  = size;
  canvas.height = size;
  const ctx  = canvas.getContext('2d');
  const img  = ctx.createImageData(size, size);
  const data = img.data;

  // Raking light vector (normalised): elevation ≈ 15°, azimuth ≈ 315° (upper-left)
  // tan(15°) ≈ 0.268  →  lz/sqrt(lx²+ly²) = 0.268
  const rawLx = 0.707, rawLy = 0.500, rawLz = 0.300;
  const rLen = Math.sqrt(rawLx * rawLx + rawLy * rawLy + rawLz * rawLz);
  const Lx = rawLx / rLen, Ly = rawLy / rLen, Lz = rawLz / rLen;

  // Bump scale for normal calculation: higher = deeper apparent relief
  const BUMP = 7.0;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const idx = py * size + px;

      // Sobel normals — sample 2-pixel radius for smoother normals
      const hR = heights[py * size + Math.min(px + 2, size - 1)];
      const hL = heights[py * size + Math.max(px - 2, 0)];
      const hU = heights[Math.max(py - 2, 0) * size + px];
      const hD = heights[Math.min(py + 2, size - 1) * size + px];

      let nx = (hL - hR) * BUMP;
      let ny = (hU - hD) * BUMP;
      let nz = 1.0;
      const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= nLen; ny /= nLen; nz /= nLen;

      // Lambertian raking diffuse + gentle ambient
      const NdotL  = Math.max(0.0, nx * Lx + ny * Ly + nz * Lz);
      const ambient = 0.22;                          // prevents pure-black valleys
      const light   = ambient + (1.0 - ambient) * NdotL;

      // Height → base luminance: valley=0.28, ridge-top=0.97
      const h_val = heights[idx];
      let v = 0.28 + Math.pow(h_val, 0.60) * 0.69;

      // Apply raking light
      v *= light;

      // Mild gamma correction (makes midtones slightly lighter — matte paper feel)
      v = Math.pow(Math.min(1.0, Math.max(0.0, v)), 0.88);

      // Natural white: very slight warm cast on ridges, neutral in valleys
      // Real archival cotton-rag paper reads as warm white under daylight.
      const ridge = Math.pow(h_val, 2.0);            // 1 only at peak ridges
      const r = Math.min(255, Math.round(v * 255) + Math.round(ridge * 3));
      const g = Math.round(v * 255);
      const b = Math.max(0,   Math.round(v * 255) - Math.round(ridge * 2));

      const i = idx * 4;
      data[i]     = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS        = THREE.RepeatWrapping;
  tex.wrapT        = THREE.RepeatWrapping;
  tex.anisotropy   = 16;
  tex.minFilter    = THREE.LinearMipmapLinearFilter;
  tex.magFilter    = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate  = true;
  return tex;
}
