/**
 * KMRenderer — Kubelka-Munk reflectance on wet watercolour paper.
 *
 * Tint / DiVerdi et al. (2013) inspired rendering:
 *   NO outlines. NO toon steps. NO hard edges.
 *   Colours are saturated, luminous, and merge into each other naturally.
 *   The paper is the primary reflector — pigment absorbs light through it.
 *   Wet areas glisten softly. Dry areas show paper grain.
 *   Everything feels like real watercolour on cold-press paper.
 *
 * Kubelka-Munk thin-film equation:
 *   R_total = R∞ + (R_paper - R∞) · exp(-b · thickness)
 *   K/S boosted for high saturation.  Paper grain breaks up thin washes.
 */

precision highp float;

varying vec3 vNormal;
varying vec3 vViewDir;
varying vec3 vWorldPos;
varying vec2 vUv;

uniform sampler2D tPaint;
uniform sampler2D tVelocity;
uniform sampler2D tSubstrate;
uniform vec3  u_lightDir;
uniform vec3  u_baseColor;
uniform float u_time;
uniform vec2  u_screenSize;
uniform vec2  u_paintUvOffset;
uniform vec2  u_paintUvScale;
uniform vec2  u_substrateTexelSize;

// ── Noise ────────────────────────────────────────────────────────────────────
vec2 _h2(vec2 p) {
  p = vec2(dot(p,vec2(127.1,311.7)), dot(p,vec2(269.5,183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}
float _gnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f*f*(3.0-2.0*f);
  return mix(
    mix(dot(_h2(i),         f),         dot(_h2(i+vec2(1,0)), f-vec2(1,0)), u.x),
    mix(dot(_h2(i+vec2(0,1)),f-vec2(0,1)),dot(_h2(i+vec2(1,1)),f-vec2(1,1)),u.x),
    u.y);
}

// ── Kubelka-Munk ─────────────────────────────────────────────────────────────
vec3 _kmReflToKS(vec3 R) {
  R = clamp(R, vec3(0.004), vec3(0.996));
  return (1.0 - R) * (1.0 - R) / (2.0 * R);
}
vec3 _kmKSToRefl(vec3 ks) {
  ks = max(ks, vec3(0.0));
  return 1.0 + ks - sqrt(ks * ks + 2.0 * ks);
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 L = normalize(u_lightDir);
  vec3 V = normalize(vViewDir);
  vec3 H = normalize(L + V);

  vec2 simUV = clamp(
    u_paintUvOffset + vUv * u_paintUvScale,
    u_paintUvOffset + vec2(0.001),
    u_paintUvOffset + u_paintUvScale - vec2(0.001)
  );

  // ── Water & drying state ──────────────────────────────────────────────────
  vec4  velData     = texture2D(tVelocity, simUV);
  float water       = velData.b;
  float dryTimer    = velData.a;
  float dryProgress = smoothstep(0.625, 1.0, dryTimer);
  float wetness     = smoothstep(0.0, 0.22, water) * (1.0 - dryProgress * 0.85);

  // ── Paper bump normals from substrate height ──────────────────────────────
  vec2  stx = u_substrateTexelSize;
  float hC  = texture2D(tSubstrate, vUv).r;
  float hR  = texture2D(tSubstrate, vUv + vec2(stx.x, 0.0)).r;
  float hL  = texture2D(tSubstrate, vUv - vec2(stx.x, 0.0)).r;
  float hU  = texture2D(tSubstrate, vUv + vec2(0.0, stx.y)).r;
  float hD  = texture2D(tSubstrate, vUv - vec2(0.0, stx.y)).r;

  float bumpScale = 0.28;
  float dhdx = (hR - hL) * bumpScale;
  float dhdy = (hU - hD) * bumpScale;
  vec3  bumpN = normalize(N + vec3(-dhdx, -dhdy, 0.0));
  N = normalize(mix(N, bumpN, 0.50));

  // ── Soft continuous lighting — NO toon steps ──────────────────────────────
  // Smooth diffuse wrap: light wraps around surface for watercolour softness.
  // No harsh shadows, no stepped banding — just gentle luminance variation.
  float NdotL = dot(N, L);
  float diffuse = clamp(NdotL * 0.40 + 0.60, 0.0, 1.0);  // wide wrap

  // ── Multi-scale paper grain (cold-press watercolour paper) ────────────────
  float coarseGrain = hC;
  float fineGrain   = _gnoise(vUv * 82.0) * 0.5 + 0.5;
  float microGrain  = _gnoise(vUv * 220.0 + vec2(17.3, 43.7)) * 0.5 + 0.5;
  float paperGrain  = coarseGrain * 0.50 + fineGrain * 0.32 + microGrain * 0.18;
  paperGrain        = pow(paperGrain, 0.60);

  // Grain intensifies as paint dries and settles into paper fibres
  float grainDryBoost = 1.0 + dryProgress * 0.35;
  paperGrain = clamp(paperGrain * grainDryBoost, 0.0, 1.0);

  // ── Watercolour paper surface — warm, slightly off-white, textured ────────
  // The paper IS the primary light source in K-M theory.
  // Valleys are slightly darker (pigment pools there), ridges are bright.
  vec3 valleyCol = vec3(0.930, 0.915, 0.890);  // warm cream in valleys
  vec3 ridgeCol  = vec3(0.996, 0.992, 0.982);  // near-white ridges
  vec3 paperColor = mix(valleyCol, ridgeCol, paperGrain);

  // Apply soft diffuse lighting to paper
  vec3 canvas = paperColor * diffuse;

  // ── Wet paper glisten — smooth specular, NOT toon-stepped ─────────────────
  float NdotH = max(dot(N, H), 0.0);
  float NdotV = max(dot(N, V), 0.0);
  float sheenFactor = (1.0 - dryProgress) * wetness;

  // Smooth Blinn-Phong specular — wet paper glistens gently
  float spec = pow(NdotH, 64.0) * 0.18 * sheenFactor;
  // Fresnel rim on wet edges
  float fresnel = pow(1.0 - NdotV, 3.5) * sheenFactor * 0.10;

  vec4  paintDataSheen = texture2D(tPaint, simUV);
  float densitySheen   = clamp(paintDataSheen.a * 2.5 + 0.15, 0.0, 1.0);
  canvas += (spec + fresnel) * densitySheen;

  // ── Paint UV lookup ───────────────────────────────────────────────────────
  vec2 paintUV = clamp(
    u_paintUvOffset + vUv * u_paintUvScale,
    u_paintUvOffset + vec2(0.001),
    u_paintUvOffset + u_paintUvScale - vec2(0.001)
  );

  vec4  paintData = texture2D(tPaint, paintUV);
  float density   = paintData.a;

  vec3 paintHue = density > 0.008
    ? clamp(paintData.rgb / density, vec3(0.0), vec3(1.0))
    : vec3(0.0);

  // ── Vibrance boost — saturated watercolour look ───────────────────────────
  // High saturation expansion: pull away from grey toward pure hue.
  // This is how Tint gets its vibrant, luminous colour-on-paper feel.
  float luma = dot(paintHue, vec3(0.299, 0.587, 0.114));
  vec3  vivid = mix(vec3(luma), paintHue, 1.95);  // strong saturation boost
  vivid = clamp(vivid, 0.0, 1.0);

  // ── Kubelka-Munk thin-film reflectance ────────────────────────────────────
  //
  //   R = R∞ + (R_paper - R∞) · exp(-b · thickness)
  //
  //   Light enters pigment film → partially absorbed → reflects off paper →
  //   passes through pigment again.  Thicker film = more absorption = richer
  //   colour.  Paper grain modulates R_paper → texture shows through.
  //
  //   K/S boosted ×2.2 for high absorption → vivid saturated pigments.
  //   This matches the DiVerdi "Painting with Polygons" aesthetic where
  //   watercolour washes are luminous and transparent, not washed-out.

  float thickness = density * 2.0;

  // K/S from paint hue — boosted absorption for saturated pigment
  vec3 ks = _kmReflToKS(vivid);
  ks *= 2.2;  // high K (absorption), low S (scattering) → vivid colour

  // Infinite-layer reflectance R∞ and extinction coefficient b
  vec3 Rinf = _kmKSToRefl(ks);
  vec3 b    = sqrt(ks * ks + 2.0 * ks);

  // Thin-film absorption: exponential decay through pigment layer
  vec3 kmResult = Rinf + (canvas - Rinf) * exp(-b * thickness * 2.5);

  // ── Paper grain break-up at low density (dry brush / wash edges) ──────────
  // Where paint is thin, paper fibre peaks resist pigment → grain shows through.
  // This is the hallmark watercolour look: colour pooled in valleys, paper
  // showing on ridges.  No outlines needed — the physics creates the edges.
  float granule      = smoothstep(0.35, 0.75, paperGrain);
  float grainBreakup = granule * 0.32 * clamp(1.0 - density * 1.8, 0.0, 1.0);
  kmResult = mix(kmResult, canvas, grainBreakup);

  // ── Soft lighting on paint ────────────────────────────────────────────────
  float surfaceShade = 0.88 + paperGrain * 0.16;
  float lightOnPaint = NdotL * 0.15 + 0.92;
  kmResult *= surfaceShade * lightOnPaint;

  // ── Wet dilution — water dilutes pigment concentration ────────────────────
  float wetDilute = mix(1.0, 0.94, wetness * density);
  kmResult *= wetDilute;

  // ── Water film shimmer — faint cool reflection on wet areas ───────────────
  vec3 waterTint = vec3(0.008, 0.013, 0.020) * wetness;
  kmResult += waterTint * 0.12;

  // ── Final blend: painted vs unpainted ─────────────────────────────────────
  // Smooth crossfade at low density → colours naturally merge into paper.
  // NO hard boundaries, NO outlines — just soft K-M absorption transition.
  float kmBlend = smoothstep(0.004, 0.06, density);
  vec3 result = mix(canvas, kmResult, kmBlend);

  // Paper grain subtly visible even through paint (cold-press texture feel)
  float midDensity = kmBlend * (1.0 - kmBlend) * 2.0;
  result = mix(result, result * (0.92 + paperGrain * 0.10), midDensity * 0.40);

  gl_FragColor = vec4(clamp(result, vec3(0.0), vec3(1.0)), 1.0);
}
