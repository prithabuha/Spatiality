/**
 * Bake pass — permanent pigment record (high-water-mark density tracking).
 *
 * Replaces the old threshold-based bake with a simple MAX rule:
 * The baked layer stores the highest pigment density ever reached at each pixel.
 *
 * Why MAX is the right model:
 *   • During active painting   → wet.a rises above baked.a → baked captures stroke
 *   • During wet spreading     → diffused edges exceed their local baked.a → edge
 *                                 baked fills in naturally as paint spreads
 *   • During fringe buildup    → convergence concentrates pigment at edges →
 *                                 fringe density exceeds previous baked → baked captures
 *   • After drying             → wet.a = 0 everywhere → baked wins → permanent stain
 *
 * Result: the baked layer is a true "watercolor stain record" — every pixel holds
 * the richest pigment it ever received.  Physics (diffusion, granulation, blooms)
 * are all captured in the final stain, not lost when the water evaporates.
 *
 * The composite pass then uses a ratio test to show either:
 *   • Wet layer  (wet is nearly as dense as its baked peak → live physics)
 *   • Baked layer (wet has spread thin → permanent stain shows through)
 */

precision highp float;

uniform sampler2D tWet;
uniform sampler2D tBaked;
uniform vec2      u_resolution;

void main() {
  vec2 uv    = gl_FragCoord.xy / u_resolution;
  vec4 baked = texture2D(tBaked, uv);
  vec4 wet   = texture2D(tWet,   uv);

  // High-water-mark: only update when wet has more pigment than the record.
  // Never reduce the permanent stain — watercolour is a cumulative medium.
  gl_FragColor = (wet.a > baked.a) ? wet : baked;
}
