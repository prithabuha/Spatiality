/**
 * Toon Outline — depth-based Sobel edge detection.
 *
 * Key design decision: edge detection runs on the LINEAR EYE-SPACE DEPTH
 * buffer, NOT on luminance.
 *
 * Why depth instead of colour/luminance?
 *   • Paint strokes live on flat geometry surfaces → zero depth discontinuity
 *     → the Sobel gradient is ~0 → NO outline drawn on paint.
 *   • Room corners, window frames, sills, trim → sharp depth steps (metres) →
 *     Sobel gradient large → crisp ink border drawn.
 *   • Water-colour wetness, pigment spreads, dry rings — completely unaffected.
 *
 * Normalization:
 *   Linearised depth is in world units (≈ metres). Room corners produce depth
 *   gradients of 5-15 m; flat wall pixels produce < 0.05 m.
 *   Dividing by 8.0 maps a 5 m step to edge ≈ 0.625 (above threshold) and a
 *   0.05 m flat-wall variation to edge ≈ 0.006 (far below threshold).
 *
 * Border tuning (thinner than luminance version):
 *   smoothstep(0.07, 0.11) → transition ≈ 1-2 px at typical view distances.
 *   mix at 0.78 → ink almost opaque, tiny hint of base colour bleeds through.
 *   inkColor (0.06, 0.05, 0.04) — fine-liner on cold-press watercolour paper.
 */

precision highp float;

uniform sampler2D tDiffuse;     // gamma-corrected scene colour (from composer chain)
uniform sampler2D tDepth;       // raw depth [0,1] from RenderPass (renderTarget1)
uniform vec2      u_resolution;
uniform float     u_near;
uniform float     u_far;

varying vec2 vUv;

// Convert non-linear NDC depth [0,1] → linear eye-space depth (world units).
float linearDepth(float raw) {
  float z = raw * 2.0 - 1.0;
  return (2.0 * u_near * u_far) / (u_far + u_near - z * (u_far - u_near));
}

void main() {
  vec2 tx = 1.0 / u_resolution;

  // ── Sobel 3×3 kernel on linearised depth ─────────────────────────────────
  float tl = linearDepth(texture2D(tDepth, vUv + vec2(-tx.x,  tx.y)).r);
  float tc = linearDepth(texture2D(tDepth, vUv + vec2( 0.0,   tx.y)).r);
  float tr = linearDepth(texture2D(tDepth, vUv + vec2( tx.x,  tx.y)).r);
  float ml = linearDepth(texture2D(tDepth, vUv + vec2(-tx.x,  0.0 )).r);
  float mr = linearDepth(texture2D(tDepth, vUv + vec2( tx.x,  0.0 )).r);
  float bl = linearDepth(texture2D(tDepth, vUv + vec2(-tx.x, -tx.y)).r);
  float bc = linearDepth(texture2D(tDepth, vUv + vec2( 0.0,  -tx.y)).r);
  float br = linearDepth(texture2D(tDepth, vUv + vec2( tx.x, -tx.y)).r);

  float gx = -tl - 2.0*ml - bl + tr + 2.0*mr + br;
  float gy = -tl - 2.0*tc - tr + bl + 2.0*bc + br;
  float edge = sqrt(gx*gx + gy*gy);

  // Normalise: 5-15 m room corners map to 0.6-1.9; flat wall ~0.006.
  edge /= 8.0;

  // ── Ultra-thin ~0.25 px threshold ────────────────────────────────────────
  // Extremely narrow smoothstep band (0.005 wide) collapses the transition to
  // a sub-pixel sliver — visually ≈ 0.25 screen pixels.
  float outline = smoothstep(0.088, 0.093, edge);

  // ── Ink colour — fine-liner black on watercolour paper ────────────────────
  vec3 inkColor = vec3(0.06, 0.05, 0.04);

  vec4 base   = texture2D(tDiffuse, vUv);
  vec3 result = mix(base.rgb, inkColor, outline * 0.70);

  gl_FragColor = vec4(result, base.a);
}
