/**
 * Toon Outline — crisp 1 px line-drawing borders.
 *
 * Post-processing Sobel edge-detection pass (no wobble / no animation).
 * Runs after GammaCorrection so luminance thresholds match perceived brightness.
 *
 * Edges detected:
 *   • Room geometry (wall–floor, wall–ceiling, wall–window junctions)
 *   • Paint blob boundaries against white paper
 *   • Object silhouettes (colour buckets, window frames, trim)
 *
 * Tuning for 1 px precision:
 *   smoothstep range = 0.04  →  very narrow transition band ≈ 1 screen pixel.
 *   lineColor near-black (0.06, 0.05, 0.04) — ink on cold-press paper look.
 *   mix at 0.92  →  lines almost opaque, paper colour barely bleeds through.
 */

precision highp float;

uniform sampler2D tDiffuse;
uniform vec2      u_resolution;

varying vec2 vUv;

void main() {
  vec2 tx = 1.0 / u_resolution;

  // ── Sobel 3×3 kernel on luminance ────────────────────────────────────────
  // Each sample is 1 texel away — ensures the kernel maps to exactly 1 px.
  const vec3 LUM = vec3(0.299, 0.587, 0.114);

  float tl = dot(texture2D(tDiffuse, vUv + vec2(-tx.x,  tx.y)).rgb, LUM);
  float tc = dot(texture2D(tDiffuse, vUv + vec2( 0.0,   tx.y)).rgb, LUM);
  float tr = dot(texture2D(tDiffuse, vUv + vec2( tx.x,  tx.y)).rgb, LUM);
  float ml = dot(texture2D(tDiffuse, vUv + vec2(-tx.x,  0.0 )).rgb, LUM);
  float mr = dot(texture2D(tDiffuse, vUv + vec2( tx.x,  0.0 )).rgb, LUM);
  float bl = dot(texture2D(tDiffuse, vUv + vec2(-tx.x, -tx.y)).rgb, LUM);
  float bc = dot(texture2D(tDiffuse, vUv + vec2( 0.0,  -tx.y)).rgb, LUM);
  float br = dot(texture2D(tDiffuse, vUv + vec2( tx.x, -tx.y)).rgb, LUM);

  float gx = -tl - 2.0*ml - bl + tr + 2.0*mr + br;
  float gy = -tl - 2.0*tc - tr + bl + 2.0*bc + br;
  float edge = sqrt(gx*gx + gy*gy);

  // ── Sharp 1 px threshold ──────────────────────────────────────────────────
  // Narrow smoothstep band (0.10 → 0.14) → transition span ≈ 1–2 px.
  // Values below 0.10 produce no line; above 0.14 = fully inked.
  float outline = smoothstep(0.10, 0.14, edge);

  // ── Ink colour — near-black, like a fine-liner on watercolour paper ───────
  vec3 inkColor = vec3(0.06, 0.05, 0.04);

  vec4 base   = texture2D(tDiffuse, vUv);
  vec3 result = mix(base.rgb, inkColor, outline * 0.92);

  gl_FragColor = vec4(result, base.a);
}
