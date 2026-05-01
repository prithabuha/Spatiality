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
uniform vec2  u_substrateTexelSize;
uniform vec2  u_paintTexelSize;  // 1/simRes — for anti-aliased edge blur
uniform vec2  u_paperTexScale;  // UV repeat scale per surface
uniform float u_borderBlur;     // 0=sharp edge, 1=very soft dissolve

// ── Noise ────────────────────────────────────────────────────────────────────
float _hash1(float n) { return fract(sin(n) * 43758.5453123); }

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

  // ── Paper tooth normal map — grain peaks catch the light ─────────────────
  // Sample u_paperTex at ±2 texels → finite-difference surface normals.
  // The paper texture is isotropic Perlin FBM (no directional fibre lines),
  // so these normals represent genuine random bumps, not a grid.
  vec2 earlyPaperUV = vUv * u_paperTexScale;
  float ptOfs = 2.0 / 1024.0;  // 2-texel step in paper texture UV space
  float pt_R  = texture2D(u_paperTex, earlyPaperUV + vec2(ptOfs, 0.0)).r;
  float pt_L  = texture2D(u_paperTex, earlyPaperUV - vec2(ptOfs, 0.0)).r;
  float pt_U  = texture2D(u_paperTex, earlyPaperUV + vec2(0.0, ptOfs)).r;
  float pt_D  = texture2D(u_paperTex, earlyPaperUV - vec2(0.0, ptOfs)).r;
  float pt_dpdx = (pt_R - pt_L) * 3.5;
  float pt_dpdy = (pt_U - pt_D) * 3.5;
  vec3  paperToothN = normalize(N + vec3(-pt_dpdx, -pt_dpdy, 0.0));
  N = normalize(mix(N, paperToothN, 0.50));

  // ── Soft continuous lighting — NO toon steps ──────────────────────────────
  // Smooth diffuse wrap: light wraps around surface for watercolour softness.
  // No harsh shadows, no stepped banding — just gentle luminance variation.
  float NdotL = dot(N, L);
  float diffuse = clamp(NdotL * 0.35 + 0.68, 0.0, 1.0);  // wide wrap — brighter minimum

  // ── Isotropic paper grain — rotated Perlin FBM, no directional axis ────────
  // Each octave rotated by a different angle → no grid, no straight lines.
  // Matches: "use a Perlin noise displacement map instead of a grid."
  // mat2(cos,-sin, sin,cos) rotation applied before each gnoise sample.
  float coarseGrain = hC;

  mat2 gr1 = mat2( 0.7986,  0.6020, -0.6020,  0.7986);  //  37° — medium bumps
  mat2 gr2 = mat2( 0.1908,  0.9816, -0.9816,  0.1908);  //  79° — fine peaks
  mat2 gr3 = mat2(-0.5446,  0.8387, -0.8387, -0.5446);  // 123° — micro pits
  mat2 gr4 = mat2(-0.9744,  0.2250, -0.2250, -0.9744);  // 167° — ultra-fine

  float paperFBM = (_gnoise(       vUv  * 28.0) * 0.40
                  + _gnoise(gr1  * vUv  * 62.0) * 0.27
                  + _gnoise(gr2  * vUv  * 138.0) * 0.18
                  + _gnoise(gr3  * vUv  * 305.0) * 0.10
                  + _gnoise(gr4  * vUv  * 670.0) * 0.05)
                  * 0.5 + 0.5;

  float paperGrain = coarseGrain * 0.50 + paperFBM * 0.50;
  paperGrain       = pow(paperGrain, 0.55);

  // (grainDryBoost applied below with combined texture)

  // ── High-res paper texture (canvas-generated fibre structure) ────────────
  // Sample at scaled UV so fibres appear physically correct per surface.
  vec2 paperUV = vUv * u_paperTexScale;
  vec3 paperTex = texture2D(u_paperTex, paperUV).rgb;

  // Blend procedural Worley grain with the canvas fibre texture
  // → canvas fibre texture weighted higher → more physical paper feel.
  float combinedGrain = paperGrain * 0.30 + paperTex.r * 0.70;
  combinedGrain = pow(clamp(combinedGrain, 0.0, 1.0), 0.45);  // lower power → crispier grain peaks

  // Grain intensifies slightly as paint dries — kept minimal to avoid perceived fading
  float grainDryBoost2 = 1.0 + dryProgress * 0.05;
  combinedGrain = clamp(combinedGrain * grainDryBoost2, 0.0, 1.0);

  // ── Watercolour paper surface — high-contrast warm cold-press ────────────
  // Darker valleys, brighter ridges → grain contrast clearly legible through paint.
  // Base tint matches #f9f7f1 (R:249 G:247 B:241) — warm white cotton-rag paper
  vec3 valleyCol = vec3(0.800, 0.780, 0.755);  // warm-grey valleys
  vec3 ridgeCol  = vec3(0.976, 0.969, 0.945);  // #f9f7f1 warm-white ridges
  vec3 paperColor = mix(valleyCol, ridgeCol, combinedGrain);

  // Apply soft diffuse lighting to paper
  vec3 canvas = paperColor * diffuse;

  // ── Wet paper glisten — smooth specular, NOT toon-stepped ─────────────────
  float NdotH = max(dot(N, H), 0.0);
  float NdotV = max(dot(N, V), 0.0);
  float sheenFactor = (1.0 - dryProgress) * wetness;

  // Smooth Blinn-Phong specular — wet paper glistens gently
  float spec = pow(NdotH, 64.0) * 0.06 * sheenFactor;
  // Fresnel rim on wet edges
  float fresnel = pow(1.0 - NdotV, 3.5) * sheenFactor * 0.04;

  vec4  paintDataSheen = texture2D(tPaint, simUV);
  float densitySheen   = clamp(paintDataSheen.a * 2.5, 0.0, 1.0);
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

  // ── Anti-aliased density for edge blending ───────────────────────────────
  // 2-texel-radius 13-tap weighted blur on density before edge smoothstep.
  // Spreads the edge transition over ~4 texels so it renders smoothly at any
  // display resolution.  Colour and KM physics still use the exact centre
  // sample — only the mix() blend factor benefits from the smooth gradient.
  float tw = u_paintTexelSize.x;
  float th = u_paintTexelSize.y;
  float tw2 = tw * 2.0;
  float th2 = th * 2.0;
  float densitySmooth =
      density                                                     * 6.0
    + texture2D(tPaint, paintUV + vec2( tw,  0.0)).a             * 4.0
    + texture2D(tPaint, paintUV + vec2(-tw,  0.0)).a             * 4.0
    + texture2D(tPaint, paintUV + vec2( 0.0,  th)).a             * 4.0
    + texture2D(tPaint, paintUV + vec2( 0.0, -th)).a             * 4.0
    + texture2D(tPaint, paintUV + vec2( tw,   th)).a             * 2.0
    + texture2D(tPaint, paintUV + vec2(-tw,   th)).a             * 2.0
    + texture2D(tPaint, paintUV + vec2( tw,  -th)).a             * 2.0
    + texture2D(tPaint, paintUV + vec2(-tw,  -th)).a             * 2.0
    + texture2D(tPaint, paintUV + vec2(tw2,  0.0)).a             * 1.0
    + texture2D(tPaint, paintUV + vec2(-tw2, 0.0)).a             * 1.0
    + texture2D(tPaint, paintUV + vec2( 0.0, th2)).a             * 1.0
    + texture2D(tPaint, paintUV + vec2( 0.0,-th2)).a             * 1.0;
  densitySmooth /= 34.0;

  // ── Vibrance boost — natural watercolour saturation ──────────────────────
  // Moderate saturation lift: pull away from grey toward pure hue.
  // Factor 1.65: vibrant but not neon.  Real watercolour is luminous because
  // light passes THROUGH the translucent pigment and bounces off white paper —
  // that luminosity comes from the KM thin-film model below, not from blowing
  // out saturation.  Over-boosting (>2.0) clips channels and creates a
  // synthetic "glowing" artefact.  1.65 gives richness without that effect.
  float luma = dot(paintHue, vec3(0.299, 0.587, 0.114));
  vec3  vivid = mix(vec3(luma), paintHue, 1.65);
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

  // Reduced thickness multiplier → more transparent at low density.
  // Old: density * 5.0 made light washes (density=0.2) behave like thick gouache.
  // New: density * 3.2 keeps transparency at low density, opaque at high density:
  //   density=0.10 → ~55% paper visible (light tint)
  //   density=0.30 → ~20% paper visible (soft wash)
  //   density=0.65 → ~4%  paper visible (rich stain)
  float thickness = density * 1.6;

  // K/S from paint hue — boosted absorption for rich pigment depth
  vec3 ks = _kmReflToKS(vivid);
  ks *= 1.45;  // real-pigment absorption strength; slightly reduced from 1.6

  // Infinite-layer reflectance R∞ and extinction coefficient b
  vec3 Rinf = _kmKSToRefl(ks);
  vec3 b    = sqrt(ks * ks + 2.0 * ks);

  // Thin-film absorption: exponential decay through pigment layer
  vec3 kmResult = Rinf + (canvas - Rinf) * exp(-b * thickness * 2.0);

  // ── Paper grain break-up through paint ────────────────────────────────────
  // Grain clearly shows even through dense paint — valley fibres punch through.
  // grainBreakup 0.55: grain visible at all paint densities including thick strokes.
  // density * 0.85 → grain persists at high density (only fades at density > 1.17).
  float granule      = smoothstep(0.25, 0.70, combinedGrain);
  float grainBreakup = granule * 0.28 * clamp(1.0 - density * 1.20, 0.0, 1.0);
  kmResult = mix(kmResult, canvas, grainBreakup);

  // ── Soft lighting on paint — grain modulates paint brightness ────────────
  float surfaceShade = 0.92 + combinedGrain * 0.10;  // gentle grain modulation, no darkening
  float lightOnPaint = NdotL * 0.12 + 0.95;
  kmResult *= surfaceShade * lightOnPaint;

  // ── Wet dilution — water dilutes pigment concentration ────────────────────
  float wetDilute = mix(1.0, 0.97, wetness * density);  // less wet dilution → colour holds
  kmResult *= wetDilute;

  // (edge darkening and multiply blend removed — were causing dull dark colours)

  // ── Water film shimmer — faint cool reflection on wet areas ───────────────
  vec3 waterTint = vec3(0.008, 0.013, 0.020) * wetness;
  kmResult += waterTint * 0.12;

  // ── Final blend: 100% interior opacity, 30% transparent edges ────────────
  // Paint interior is fully opaque (100%). Edge zone (density < 0.25) fades
  // to a max of 70% — giving soft, organic watercolour edge feathering.
  float blurHigh = 0.018 + u_borderBlur * 0.12;  // 0=sharp(0.018), 1=soft(0.138)
  // Use blurred density for the edge blend — eliminates pixelated step artefacts.
  // Interior colour/KM still uses the exact centre `density` for accuracy.
  float rawBlend  = smoothstep(0.001, blurHigh, densitySmooth);
  // Ramp from 70% at the edge to 100% at density=0.25 (interior body)
  float edgeFade  = mix(0.70, 1.0, smoothstep(blurHigh * 2.0, 0.28, densitySmooth));
  float kmBlend   = rawBlend * edgeFade;
  vec3 result = mix(canvas, kmResult, kmBlend);

  // Paper grain clearly visible through paint — cold-press texture character
  // Higher coefficients → grain remains legible even at medium-to-high densities.
  float midDensity = kmBlend * (1.0 - kmBlend) * 2.0;
  result = mix(result, result * (0.88 + paperGrain * 0.26), midDensity * 0.80);

  // ── Paper tooth — tiny dark speckle dots ──────────────────────────────────
  //
  // Direct port of the Processing setup() technique:
  //   for (int i = 0; i < 50000; i++) {
  //     stroke(0, 0, 0, random(5, 15));
  //     point(random(width), random(height));  // width = height = 400
  //   }
  //
  // 50 000 dots on 400×400 = 0.3125 dots/px → ~31.25% of cells are dotted.
  // Each dot darkens by opacity 5–15 / 255 ≈ 0.020–0.059 (2–6% black).
  // Using floor(vUv * 400) maps one UV cell to one "Processing pixel".
  // Both paper and painted areas receive the tooth — it's a surface property.
  vec2  toothCell  = floor(vUv * 400.0);
  float toothHash  = _hash1(toothCell.x * 73.1  + toothCell.y * 37.7);
  float hasDot     = step(0.6875, toothHash);          // 31.25% density
  float dotOpacity = mix(0.020, 0.059,                 // stroke(0,0,0, 5–15)
    _hash1(toothCell.x * 19.3 + toothCell.y * 83.1));
  result = mix(result, vec3(0.0), hasDot * dotOpacity);

  gl_FragColor = vec4(clamp(result, vec3(0.0), vec3(1.0)), 1.0);
}
