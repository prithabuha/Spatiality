/**
 * Composite pass — merges the permanent baked layer with the live wet layer.
 *
 * Physics rationale:
 *   The baked layer is a "high-water-mark" of pigment density (see gpgpu_bake).
 *   The wet layer is the live simulation — it starts at the baked peak, then
 *   spreads / diffuses as paint flows.
 *
 *   ratio = wet.a / baked.a
 *     ratio ≈ 1.0  → wet is still at its peak (fresh stroke, spreading)
 *     ratio < 0.82 → wet has spread thin → fall back to permanent stain
 *
 * Display logic:
 *   ratio ≥ 0.97  →  show wet layer   (live physics: spreading, blooms, flow)
 *   ratio ≤ 0.80  →  show baked layer  (permanent stain — colour never vanishes)
 *   between       →  smooth crossfade
 *
 * This gives:
 *   • Beautiful wet-phase spreading and blooms are fully visible while painting
 *   • As paint dries and spreads thin, the permanent stain fades in naturally
 *   • Once dry, the stain is permanent — no colour loss after baking
 */

precision highp float;

uniform sampler2D tWet;
uniform sampler2D tBaked;
uniform vec2      u_resolution;

void main() {
  vec2 uv    = gl_FragCoord.xy / u_resolution;
  vec4 baked = texture2D(tBaked, uv);
  vec4 wet   = texture2D(tWet,   uv);

  // Ratio: how close is the current wet density to its lifetime peak?
  // When baked.a ≈ 0 (unpainted paper), ratio is very large → always shows wet.
  float ratio     = wet.a / max(baked.a, 0.001);

  // Crossfade: show wet when fresh, show baked when spread thin
  float wetFactor = smoothstep(0.78, 0.97, ratio);

  gl_FragColor = mix(baked, wet, wetFactor);
}
