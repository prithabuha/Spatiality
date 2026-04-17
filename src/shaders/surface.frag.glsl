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
uniform sampler2D u_paperTex;   // high-res canvas paper texture
uniform vec3  u_lightDir;
uniform vec3  u_baseColor;
uniform float u_time;
uniform vec2  u_screenSize;
uniform vec2  u_paintUvOffset;
uniform vec2  u_paintUvScale;
uniform vec2  u_simTexelSize;   // 1/simResolution — for anti-pixelation soft fetch
uniform vec2  u_substrateTexelSize;
uniform vec2  u_paperTexScale;  // UV repeat scale per surface
uniform float u_borderBlur;     // 0=sharp edge, 1=very soft dissolve

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

  // (grainDryBoost applied below with combined texture)

  // ── High-res paper texture (canvas-generated fibre structure) ────────────
  // Sample at scaled UV so fibres appear physically correct per surface.
  vec2 paperUV = vUv * u_paperTexScale;
  vec3 paperTex = texture2D(u_paperTex, paperUV).rgb;

  // Blend procedural Worley grain with the canvas fibre texture
  // → Worley controls pigment trapping; canvas texture controls visual look.
  float combinedGrain = paperGrain * 0.45 + paperTex.r * 0.55;
  combinedGrain = pow(clamp(combinedGrain, 0.0, 1.0), 0.62);

  // Grain intensifies as paint dries and settles into paper fibres
  float grainDryBoost2 = 1.0 + dryProgress * 0.35;
  combinedGrain = clamp(combinedGrain * grainDryBoost2, 0.0, 1.0);

  // ── Watercolour paper surface — pure white cold-press ─────────────────────
  // Real cotton-rag paper: pure white base, dark fiber valleys, bright ridges.
  vec3 valleyCol = vec3(0.910, 0.910, 0.912);  // lighter valleys — reduce dark shadow at paint edges
  vec3 ridgeCol  = vec3(0.990, 0.990, 0.992);  // near-white fiber ridges
  vec3 paperColor = mix(valleyCol, ridgeCol, combinedGrain);

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

  // ── Anti-pixelation: 5-tap tent filter on full RGBA ─────────────────────
  // The sim texture (512×512) is displayed on large 3-D planes. Bilinear
  // alone gives blocky edges because the paint/paper transition spans only
  // 1-2 texels. A tent filter spreads that transition over ~3 texels.
  //
  // CRITICAL: we filter the full RGBA together (premultiplied), then extract
  // hue from smoothedRGB / smoothedAlpha.  Filtering alpha alone and dividing
  // by the single-tap alpha causes black artefacts at the paint edge because
  // edge texels have non-zero smoothed density but zero centre RGB.
  vec2  stx = u_simTexelSize;
  vec4  paintData  = texture2D(tPaint, paintUV);
  vec4  paintDataN = texture2D(tPaint, paintUV + vec2( 0.0,   stx.y));
  vec4  paintDataS = texture2D(tPaint, paintUV + vec2( 0.0,  -stx.y));
  vec4  paintDataE = texture2D(tPaint, paintUV + vec2( stx.x,  0.0 ));
  vec4  paintDataW = texture2D(tPaint, paintUV + vec2(-stx.x,  0.0 ));
  vec4  paintSmooth = paintData * 0.40
                    + (paintDataN + paintDataS + paintDataE + paintDataW) * 0.15;
  float density = paintSmooth.a;

  // Hue extracted from the smoothed premul RGBA — stays correct at all edges
  vec3 paintHue = density > 0.008
    ? clamp(paintSmooth.rgb / max(density, 0.001), vec3(0.0), vec3(1.0))
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

  // ── Paper grain break-up at low density ───────────────────────────────────
  // Reduced breakup: paint stays visible at edges instead of vanishing.
  // Paper texture shows through only at very low density washes.
  float granule      = smoothstep(0.40, 0.80, combinedGrain);
  float grainBreakup = granule * 0.10 * clamp(1.0 - density * 3.0, 0.0, 1.0);
  kmResult = mix(kmResult, canvas, grainBreakup);

  // ── Soft lighting on paint ────────────────────────────────────────────────
  float surfaceShade = 0.88 + combinedGrain * 0.16;
  float lightOnPaint = NdotL * 0.15 + 0.92;
  kmResult *= surfaceShade * lightOnPaint;

  // ── Wet dilution — water dilutes pigment concentration ────────────────────
  float wetDilute = mix(1.0, 0.94, wetness * density);
  kmResult *= wetDilute;

  // ── Water film shimmer — faint cool reflection on wet areas ───────────────
  vec3 waterTint = vec3(0.008, 0.013, 0.020) * wetness;
  kmResult += waterTint * 0.12;

  // ── Watercolor border noise — organic deckled edge ────────────────────────
  // Real watercolor spreads unevenly along the paper grain. Three noise octaves
  // at different scales create the characteristic ragged bloom edge.
  // All offsets are STATIC (no u_time) so the edge stays fixed once dried.
  float bN1 = _gnoise(vUv * 55.0  + vec2(31.41, 17.73)) * 0.5 + 0.5; // coarse flow
  float bN2 = _gnoise(vUv * 140.0 + vec2(61.07, 43.21)) * 0.5 + 0.5; // medium fibre
  float bN3 = _gnoise(vUv * 295.0 + vec2(11.23, 71.89)) * 0.5 + 0.5; // fine grain
  float borderNoise = bN1 * 0.42 + bN2 * 0.35 + bN3 * 0.23;

  // Edge zone: thin wash transition (not solid interior, not empty paper)
  // Bell-shaped: rises from zero at density=0.003, peaks near 0.06, falls to 0 at 0.30
  float edginess = smoothstep(0.003, 0.065, density)
                 * (1.0 - smoothstep(0.065, 0.300, density));

  // Noise modulates the blend density at the edge only.
  // Dark noise holes → paint didn't reach those micro-valleys.
  // The colour itself is unchanged — only the visibility at the edge varies.
  float noiseDensity = density * (0.08 + borderNoise * 1.84);
  float blendDensity = mix(density, noiseDensity, edginess * 0.82);

  // ── Final blend: painted vs unpainted — border blur controlled by slider ──
  float blurHigh = 0.014 + u_borderBlur * 0.10;  // 0=sharp(0.014), 1=soft(0.114)
  float kmBlend  = smoothstep(0.001, blurHigh, blendDensity);
  vec3 result = mix(canvas, kmResult, kmBlend);

  // Paper grain subtly visible even through paint (cold-press texture feel)
  float midDensity = kmBlend * (1.0 - kmBlend) * 2.0;
  result = mix(result, result * (0.92 + paperGrain * 0.10), midDensity * 0.40);

  gl_FragColor = vec4(clamp(result, vec3(0.0), vec3(1.0)), 1.0);
}
