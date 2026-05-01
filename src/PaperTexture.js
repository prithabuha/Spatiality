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

  // ── Isotropic rotated-FBM noise ──────────────────────────────────────────────
  // 5 octaves each rotated by a different angle → no preferred direction.
  // Produces organic random bumps like real cold-press paper tooth,
  // not directional fibre streaks.
  const rot2 = (x, y, a) => {
    const c = Math.cos(a), s = Math.sin(a);
    return [c * x - s * y, s * x + c * y];
  };

  const isotropicNoise = (ux, uy) => {
    // Rotation angles spread across 0–180° (0, 37°, 79°, 123°, 167°)
    const [a0x, a0y] = rot2(ux * 42,  uy * 42,  0.000);
    const [a1x, a1y] = rot2(ux * 90,  uy * 90,  0.646);
    const [a2x, a2y] = rot2(ux * 190, uy * 190, 1.379);
    const [a3x, a3y] = rot2(ux * 400, uy * 400, 2.147);
    const [a4x, a4y] = rot2(ux * 840, uy * 840, 2.914);
    return vnoise(a0x, a0y) * 0.40
         + vnoise(a1x, a1y) * 0.27
         + vnoise(a2x, a2y) * 0.17
         + vnoise(a3x, a3y) * 0.10
         + vnoise(a4x, a4y) * 0.06;
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

      // Isotropic surface noise — no directional streaks
      const iso = isotropicNoise(ux, uy);

      // Worley cells: coarse bump gaps + fine surface pitting
      const wCoarse = worley(ux, uy, 5.5);
      const wMedium = worley(ux, uy, 14.0);
      const wFine   = worley(ux, uy, 45.0);
      const wMicro  = worley(ux, uy, 120.0);

      // Macro paper thickness variation (handmade feel)
      const macro = fbm(ux * 2.8 + 0.5, uy * 2.8 + 0.3, 4);

      // Combine: Perlin FBM dominant, Worley adds large-scale cell structure
      const fiber_brightness = iso * 0.38
        + (1.0 - wCoarse) * 0.13
        + (1.0 - wMedium) * 0.18
        + (1.0 - wFine)   * 0.14
        + (1.0 - wMicro)  * 0.06
        + macro            * 0.11;

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
