/**
 * Toon Outline — Sobel edge detection with hand-drawn wobble.
 *
 * Post-processing pass applied after the main scene render.
 * Detects edges via Sobel 3×3 on luminance, with organic
 * UV perturbation that makes outlines feel sketched by hand.
 * Warm sepia line colour blends softly over the scene.
 *
 * Used with Three.js ShaderPass (ShaderMaterial auto-adds precision).
 */

uniform sampler2D tDiffuse;
uniform vec2  u_resolution;
uniform float u_time;

varying vec2 vUv;

void main() {
  vec2 texel = 1.0 / u_resolution;

  // ── Hand-drawn wobble: organic UV perturbation ────────────────────────────
  float wobX = sin(u_time * 2.1 + vUv.y * 41.0) * 0.0006
             + sin(u_time * 0.7 + vUv.x * 67.0) * 0.0003;
  float wobY = cos(u_time * 1.7 + vUv.x * 37.0) * 0.0006
             + cos(u_time * 1.1 + vUv.y * 53.0) * 0.0003;
  vec2 wUv = vUv + vec2(wobX, wobY);

  // ── Sobel 3×3 on luminance ────────────────────────────────────────────────
  vec3 lumW = vec3(0.299, 0.587, 0.114);

  float tl = dot(texture2D(tDiffuse, wUv + vec2(-texel.x,  texel.y)).rgb, lumW);
  float tc = dot(texture2D(tDiffuse, wUv + vec2(     0.0,  texel.y)).rgb, lumW);
  float tr = dot(texture2D(tDiffuse, wUv + vec2( texel.x,  texel.y)).rgb, lumW);
  float ml = dot(texture2D(tDiffuse, wUv + vec2(-texel.x,      0.0)).rgb, lumW);
  float mr = dot(texture2D(tDiffuse, wUv + vec2( texel.x,      0.0)).rgb, lumW);
  float bl = dot(texture2D(tDiffuse, wUv + vec2(-texel.x, -texel.y)).rgb, lumW);
  float bc = dot(texture2D(tDiffuse, wUv + vec2(     0.0, -texel.y)).rgb, lumW);
  float br = dot(texture2D(tDiffuse, wUv + vec2( texel.x, -texel.y)).rgb, lumW);

  // Sobel horizontal (Gx) and vertical (Gy)
  float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
  float gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
  float edge = sqrt(gx * gx + gy * gy);

  // Smooth threshold → hand-drawn feel (not hard binary edges)
  float outline = smoothstep(0.06, 0.22, edge);

  // Warm sepia outline colour — feels like ink on sketchbook paper
  vec3 lineColor = vec3(0.35, 0.28, 0.18);

  vec4 base   = texture2D(tDiffuse, vUv);
  vec3 result = mix(base.rgb, lineColor, outline * 0.60);

  gl_FragColor = vec4(result, base.a);
}
