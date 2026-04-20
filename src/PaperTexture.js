/**
 * PaperTexture — Generates a high-resolution cold-press watercolour paper texture.
 *
 * Technique: pixel-by-pixel ImageData generation (runs once at load).
 * Combines anisotropic fiber noise, Worley cell structure, and micro-grain
 * to reproduce the characteristic look of Arches / Fabriano cotton rag paper.
 *
 * The result looks like the attached user reference image:
 *   • Very white base (~0.97)
 *   • Dense fibrous strands running diagonally / horizontally
 *   • Subtle dark valleys between fiber bundles
 *   • Organic, non-repeating structure
 */

import * as THREE from 'three';

export function buildPaperTexture(size = 1024) {
  // ── Deterministic hash ───────────────────────────────────────────────────────
  const h = (x, y) => {
    const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return v - Math.floor(v);
  };

  // ── Smooth value noise ────────────────────────────────────────────────────────
  const vnoise = (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    return (h(ix, iy)    * (1 - ux) + h(ix + 1, iy)    * ux) * (1 - uy) +
           (h(ix, iy + 1) * (1 - ux) + h(ix + 1, iy + 1) * ux) * uy;
  };

  // ── FBM — used for large paper sizing variation ──────────────────────────────
  const fbm = (x, y, oct) => {
    let v = 0, amp = 0.5, freq = 1;
    for (let i = 0; i < oct; i++) {
      v += vnoise(x * freq, y * freq) * amp;
      freq *= 2.07; amp *= 0.48;
    }
    return v;
  };

  // ── Worley nearest-cell distance ─────────────────────────────────────────────
  const worley = (x, y, scale) => {
    const sx = x * scale, sy = y * scale;
    const ix = Math.floor(sx), iy = Math.floor(sy);
    let minD = 999;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const jx = ix + dx, jy = iy + dy;
        const cx = jx + h(jx + 17, jy + 3);
        const cy = jy + h(jy + 43, jx + 7);
        const d  = Math.sqrt((sx - cx) ** 2 + (sy - cy) ** 2);
        minD = Math.min(minD, d);
      }
    }
    return Math.min(minD / 0.85, 1.0);
  };

  // ── Anisotropic fiber noise ───────────────────────────────────────────────────
  // Stretch frequency in one axis to simulate long paper fibers.
  // Three angle bands: 0° (H), 30°, -20° to mimic real fibre variation.
  const fiberNoise = (ux, uy) => {
    const f1 = vnoise(ux * 380, uy * 18);          // near-horizontal fibers
    const f2 = vnoise(ux * 220 + 11, uy * 35 + 7); // gentle diagonal
    const f3 = vnoise(ux * 160 + 5,  uy * 48 + 23);// slight vertical bundles
    const f4 = vnoise(ux * 600 + 37, uy * 12 + 3); // very fine horizontal

    // Cross-fiber texture: perpendicular to main fiber direction
    const c1 = vnoise(ux * 28  + 13, uy * 310 + 5);
    const c2 = vnoise(ux * 14  + 71, uy * 450 + 2);

    return f1 * 0.30 + f2 * 0.22 + f3 * 0.18 + f4 * 0.14
         + c1 * 0.10 + c2 * 0.06;
  };

  // ── Allocate pixel buffer ─────────────────────────────────────────────────────
  const canvas = document.createElement('canvas');
  canvas.width  = size;
  canvas.height = size;
  const ctx  = canvas.getContext('2d');
  const img  = ctx.createImageData(size, size);
  const data = img.data;

  for (let py = 0; py < size; py++) {
    const uy = py / size;
    for (let px = 0; px < size; px++) {
      const ux = px / size;

      // Fiber structure (primary texture)
      const fiber = fiberNoise(ux, uy);

      // Worley cells: coarse bundle gaps + fine single fibers + micro pits
      const wCoarse = worley(ux, uy, 5.5);   // coarse paper structure
      const wMedium = worley(ux, uy, 14.0);  // fiber bundle gaps
      const wFine   = worley(ux, uy, 45.0);  // individual fiber cells
      const wMicro  = worley(ux, uy, 120.0); // micro surface pitting

      // Macro paper thickness variation (non-uniform pressing)
      const macro = fbm(ux * 2.8 + 0.5, uy * 2.8 + 0.3, 4);

      // Combine: paper is mostly white; darken at fiber boundaries & valleys
      // Higher values = brighter (ridge / fiber top)
      const fiber_brightness = fiber * 0.35
        + (1.0 - wCoarse) * 0.12
        + (1.0 - wMedium) * 0.18
        + (1.0 - wFine)   * 0.14
        + (1.0 - wMicro)  * 0.06
        + macro            * 0.15;

      // Normalise to [0..1] then map to warm-white range matching #f9f7f1
      // R:249 G:247 B:241 — warm cotton-rag paper base (no cool tint)
      let v = Math.pow(Math.max(0, Math.min(1, fiber_brightness)), 0.70);
      v = 0.80 + v * 0.18;  // dark valleys ~0.80, bright ridges ~0.98

      const vi = Math.max(0, Math.min(1, v));
      const i  = (py * size + px) * 4;
      // Warm white tint: R slightly high, B slightly low (matches #f9f7f1)
      data[i]     = Math.round(vi * 249);  // R — warmest channel
      data[i + 1] = Math.round(vi * 247);  // G
      data[i + 2] = Math.round(vi * 241);  // B — least, gives warm cast
      data[i + 3] = 255;

      // Per-pixel random grain (tooth) — subtract small noise from all channels
      // Equivalent to: stroke(0,0,0, random(0,15)); point(x,y);
      const tooth = Math.random() * 12;
      data[i]     = Math.max(0, data[i]     - tooth);
      data[i + 1] = Math.max(0, data[i + 1] - tooth);
      data[i + 2] = Math.max(0, data[i + 2] - tooth);
    }
  }

  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS     = THREE.RepeatWrapping;
  tex.wrapT     = THREE.RepeatWrapping;
  tex.anisotropy = 16;        // critical for large-screen sharpness at angles
  tex.minFilter  = THREE.LinearMipmapLinearFilter;
  tex.magFilter  = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
