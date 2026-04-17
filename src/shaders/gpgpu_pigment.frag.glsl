/**
 * Pigment Transport — Curtis et al. three-layer model
 *                   + Kubelka-Munk subtractive colour mixing
 *                   + divergence-driven fringing
 *                   + capillary deposition into paper valleys.
 *
 * Kubelka-Munk two-flux theory:
 *   K/S = (1-R)² / (2R)          — reflectance → absorption ratio
 *   R∞  = 1 + K/S - √((K/S)²+2K/S) — infinite-layer reflectance
 *
 *   Mixing: (K/S)_mix = Σ cᵢ(K/S)ᵢ  — LINEAR in absorption space
 *   This gives physically correct subtractive mixing:
 *     Red + Blue  → deep violet  (not grey)
 *     Red + Yellow → warm orange (not brown)
 *
 * Pigment transport (Curtis et al.):
 *   ∂c/∂t + u⃗·∇c = D∇²c + S_deposit(h,c) + S_fringe(∇·u⃗)
 *   - Advection by velocity field (semi-Lagrangian, baked-layer protected)
 *   - Diffusion gated by (1-dryProgress)
 *   - Deposition: pigment settles into paper valleys (subst < 0.5)
 *   - Fringing: pigment accumulates where ∇·u⃗ < 0 (flow stalls at edges)
 *
 * Stochastic splats: same u_splatSeed as velocity pass → co-located deposits.
 *
 * Buffer: RGB = colour × density (premultiplied),  A = density [0,1]
 * Velocity buffer: RG=vel, B=water, A=dryTimer [0→1]
 */

precision highp float;

uniform sampler2D tPigment;
uniform sampler2D tVelocity;
uniform sampler2D tSubstrate;
uniform vec2  u_resolution;
uniform float u_dt;

uniform vec2  u_brushUV;
uniform vec3  u_color;
uniform float u_brushRadius;
uniform float u_pigmentLoad;
uniform float u_waterAmount;
uniform float u_colorMix;
uniform float u_edgeStrength;
uniform float u_granulationStrength;
uniform float u_backrunStrength;
uniform float u_retentionStrength;
uniform float u_concentrationRate;
uniform float u_painting;
uniform float u_brushType;
uniform float u_screenAspect;
uniform float u_time;
uniform float u_wetCanvas;

// Curtis et al. stochastic splat parameters (synced with velocity pass)
uniform float u_splatSeed;
uniform float u_splatSpread;

// Global drying state
uniform float u_isDrying;
uniform float u_dryProgress;

// ── Noise ─────────────────────────────────────────────────────────────────────
vec2 hash2(vec2 p) {
  p = vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3)));
  return -1.0+2.0*fract(sin(p)*43758.5453123);
}
float gnoise(vec2 p) {
  vec2 i=floor(p),f=fract(p),u=f*f*(3.0-2.0*f);
  return mix(mix(dot(hash2(i),f),dot(hash2(i+vec2(1,0)),f-vec2(1,0)),u.x),
             mix(dot(hash2(i+vec2(0,1)),f-vec2(0,1)),dot(hash2(i+vec2(1,1)),f-vec2(1,1)),u.x),u.y);
}
float _hash1(float n) { return fract(sin(n) * 43758.5453123); }
float _luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// ── Kubelka-Munk two-flux functions ──────────────────────────────────────────
//  K/S = (1-R)² / (2R)  — Reflectance to absorption/scattering ratio
vec3 _kmReflToKS(vec3 R) {
  R = clamp(R, vec3(0.005), vec3(0.995));
  return (1.0 - R) * (1.0 - R) / (2.0 * R);
}

//  R∞ = 1 + K/S - √((K/S)² + 2·K/S)  — K/S back to reflectance
vec3 _kmKSToRefl(vec3 ks) {
  ks = max(ks, vec3(0.0));
  return 1.0 + ks - sqrt(ks * ks + 2.0 * ks);
}

// K-M mix: linear interpolation in K/S space → physically correct subtractive
vec3 _kmMix(vec3 colA, vec3 colB, float t) {
  vec3 ksA = _kmReflToKS(colA);
  vec3 ksB = _kmReflToKS(colB);
  vec3 ksMixed = mix(ksA, ksB, t);
  return _kmKSToRefl(ksMixed);
}

// K-M additive absorption: layer colB absorbed into colA at concentration c
vec3 _kmAbsorb(vec3 baseRefl, vec3 pigRefl, float concentration) {
  vec3 ksBase = _kmReflToKS(baseRefl);
  vec3 ksPig  = _kmReflToKS(pigRefl);
  // Additive absorption: K/S values sum (Beer-Lambert in K-M domain)
  vec3 ksOut  = ksBase + ksPig * concentration;
  return _kmKSToRefl(ksOut);
}

vec3 _clampHueRange(vec3 hue) {
  float lum = _luma(hue);
  float targetLum = clamp(lum, 0.10, 0.92);
  if (lum > 0.0005) hue *= targetLum / lum;
  return clamp(hue, 0.0, 1.0);
}

void main() {
  vec2  uv  = gl_FragCoord.xy / u_resolution;
  vec2  tx  = 1.0 / u_resolution;
  float dt  = min(u_dt, 0.025);

  vec4  fluid    = texture2D(tVelocity, uv);
  vec2  vel      = fluid.rg;
  float water    = fluid.b;
  float dryTimer = fluid.a;
  float subst    = texture2D(tSubstrate, uv).r;
  vec4  prev     = texture2D(tPigment, uv);

  // Per-pixel dryProgress: 0 = wet, 1 = locked
  float dryProgress = smoothstep(0.625, 1.0, dryTimer);

  // ── BAKED LAYER LOCK ──────────────────────────────────────────────────────
  // Dried pixels return prev unchanged unless the active brush is directly
  // over them — this prevents adjacent new strokes from re-diffusing or
  // degrading already-baked paint.
  bool fullyDried   = (dryProgress >= 0.95);
  bool neverPainted = (water < 0.004 && dryTimer < 0.001);
  bool brushAffects = false;
  if (u_painting > 0.5) {
    vec2 bd = uv - u_brushUV;
    bd.x *= u_screenAspect;
    brushAffects = (length(bd) < u_brushRadius * 2.8);
  }
  if ((fullyDried || neverPainted) && !brushAffects) {
    gl_FragColor = prev;
    return;
  }

  // ── A. Semi-Lagrangian advection — baked-layer protection ────────────────
  vec2 backPos = clamp(uv - vel * dt, tx, 1.0 - tx);

  vec4  backFluid    = texture2D(tVelocity, backPos);
  float backDryTimer = backFluid.a;
  float backDryProg  = smoothstep(0.625, 1.0, backDryTimer);

  vec4 advected;
  if (backDryProg >= 0.90) {
    // Source pixel locked — do not smear baked pigment
    advected = prev;
  } else {
    advected = mix(texture2D(tPigment, backPos), prev, backDryProg * 0.85);
  }

  float newA   = advected.a;
  vec3  newRGB = advected.rgb;

  // ── B. Wet-on-wet diffusion (Laplacian + capillary flow) ─────────────────
  // Diffusion gated by (1 - dryProgress): fully dry = zero diffusion.
  // Tint-style diffusion: strong wet-on-wet bleeding.
  // Quadratic + linear water dependency creates natural flow:
  //   lots of water → fast spreading, little water → pigment stays put.
  float D = (water * water * 0.048 + water * 0.008) * u_backrunStrength;
  D *= (1.0 - dryProgress);

  // Burst: new stroke landing on existing wet paint → turbulent bleed
  float wetOnWetBurst = 0.0;
  if (u_painting > 0.5 && water > 0.18 && prev.a > 0.04) {
    wetOnWetBurst = water * prev.a * u_backrunStrength;
  }
  D = max(D, wetOnWetBurst * 0.22);

  if (D > 0.001) {
    float wR = texture2D(tVelocity, uv + vec2( tx.x, 0.0)).b;
    float wL = texture2D(tVelocity, uv - vec2( tx.x, 0.0)).b;
    float wU = texture2D(tVelocity, uv + vec2(0.0,  tx.y)).b;
    float wD = texture2D(tVelocity, uv - vec2(0.0,  tx.y)).b;
    vec2  wGrad = vec2(wR - wL, wU - wD) * 0.5;
    float gradLen = length(wGrad);
    vec2  flowDir = gradLen > 0.001 ? wGrad / gradLen : vec2(0.0);
    vec2  capFlow = flowDir * gradLen * D * 0.95;

    // 8-tap Laplacian (more isotropic)
    vec4 pN  = texture2D(tPigment, uv + vec2( 0.0,   tx.y));
    vec4 pS  = texture2D(tPigment, uv - vec2( 0.0,   tx.y));
    vec4 pE  = texture2D(tPigment, uv + vec2( tx.x,  0.0));
    vec4 pW  = texture2D(tPigment, uv - vec2( tx.x,  0.0));
    vec4 pNE = texture2D(tPigment, uv + vec2( tx.x,  tx.y));
    vec4 pNW = texture2D(tPigment, uv + vec2(-tx.x,  tx.y));
    vec4 pSE = texture2D(tPigment, uv + vec2( tx.x, -tx.y));
    vec4 pSW = texture2D(tPigment, uv + vec2(-tx.x, -tx.y));
    vec4 iso8 = (pN + pS + pE + pW) * 0.15 + (pNE + pNW + pSE + pSW) * 0.10;

    vec4 cap  = texture2D(tPigment, clamp(uv - capFlow, tx, 1.0 - tx));

    float isoBld = D * (0.50 + wetOnWetBurst * 0.35);
    float capBld = min(gradLen * D * 1.4, 0.12);
    float total  = max(isoBld + capBld, 0.001);
    newA   = mix(newA,   mix(iso8.a,   cap.a,   capBld / total), isoBld + capBld);
    newRGB = mix(newRGB, mix(iso8.rgb, cap.rgb, capBld / total), isoBld + capBld);
  }

  // ── C. Divergence-driven fringing (Curtis et al. "dried ring") ────────────
  //     ∇·u⃗ < 0 → flow stalls → pigment accumulates at drying front edges.
  //     This is the primary mechanism for the characteristic dark-edge ring
  //     visible in every watercolour wash as it dries.
  vec2 vR_f = texture2D(tVelocity, uv + vec2( tx.x, 0.0)).rg;
  vec2 vL_f = texture2D(tVelocity, uv - vec2( tx.x, 0.0)).rg;
  vec2 vU_f = texture2D(tVelocity, uv + vec2(0.0,  tx.y)).rg;
  vec2 vD_f = texture2D(tVelocity, uv - vec2(0.0,  tx.y)).rg;

  // Velocity divergence: ∂u/∂x + ∂v/∂y
  float divU = (vR_f.x - vL_f.x + vU_f.y - vD_f.y) * 0.5;

  // Water gradient magnitude (drying front detection)
  float wN_f = texture2D(tVelocity, uv + vec2(0.0,  tx.y)).b;
  float wS_f = texture2D(tVelocity, uv - vec2(0.0,  tx.y)).b;
  float wE_f = texture2D(tVelocity, uv + vec2(tx.x,  0.0)).b;
  float wW_f = texture2D(tVelocity, uv - vec2(tx.x,  0.0)).b;
  float waterGradMag = (abs(wN_f - wS_f) + abs(wE_f - wW_f)) * 0.5;

  // Divergence-based fringing: negative divergence = converging flow = pigment piles up
  float convergence   = max(-divU, 0.0);
  float dryingFront   = smoothstep(0.22, 0.0, water);
  float fringeSignal  = smoothstep(0.01, 0.18, waterGradMag) + convergence * 2.8;
  float midDensity    = smoothstep(0.03, 0.55, newA) * (1.0 - smoothstep(0.60, 0.92, newA));

  float globalBoost   = 1.0 + u_dryProgress * 0.18; // reduced from 0.50 — less dark rings
  float fringe        = fringeSignal * midDensity * dryingFront
                      * (0.008 + dryProgress * 0.020) * u_edgeStrength * globalBoost;

  float preFringeA = max(newA, 0.001);
  newA = clamp(newA + fringe, 0.0, 1.0);

  // Fringe darkening: K-M absorption at edge — REDUCED to avoid harsh dark rings
  if (fringe > 0.004 && newA > 0.01) {
    vec3  hue      = newRGB / preFringeA;
    vec3  ks       = _kmReflToKS(clamp(hue, vec3(0.01), vec3(0.99)));
    ks            *= (1.0 + fringe * 1.2);  // was 4.0 — now subtle concentration
    hue            = _kmKSToRefl(ks);
    hue            = _clampHueRange(hue);
    newRGB         = hue * newA;
  }

  // ── D. Substrate granulation — capillary deposition ───────────────────────
  //     Pigment settles into paper valleys (subst < 0.5) and is wiped from
  //     peaks (subst > 0.5).  Effect INCREASES as paint dries (Curtis model).
  float gran1   = gnoise(uv * 72.0) * 0.5 + 0.5;
  float gran2   = gnoise(uv * 140.0 + vec2(31.4, 17.7)) * 0.5 + 0.5;
  float gran    = gran1 * 0.65 + gran2 * 0.35;
  float valley  = 1.0 - subst;   // 1.0 at paper valleys, 0.0 at peaks
  float peak    = subst;          // 1.0 at paper peaks, 0.0 at valleys
  float beforeGranA = max(newA, 0.001);

  // Wet granulation + dry-settling boost
  float granInfluence = water * u_granulationStrength;
  float dryGrainBoost = dryProgress * 0.60 * u_granulationStrength;

  // Deposition: pigment INTO valleys, AWAY from peaks
  float depositValley = valley * gran * newA * 0.080 * granInfluence;
  float wipeFromPeak  = peak   * gran * newA * 0.055 * granInfluence;
  float drySettle     = valley * gran * newA * 0.035 * dryGrainBoost;

  newA = clamp(newA + depositValley - wipeFromPeak + drySettle, 0.0, 1.0);
  newRGB *= newA / beforeGranA;

  // ── E. Wet-on-wet backrun bloom (zero when dry) ──────────────────────────
  float bloomScale = 1.0 - dryProgress;
  if (bloomScale > 0.02 && water > 0.30 / max(u_backrunStrength, 0.4)) {
    float bloomZone = smoothstep(0.06, 0.28, prev.a)
                    * (1.0 - smoothstep(0.55, 0.82, prev.a));
    if (bloomZone > 0.01) {
      float angle = gnoise(uv*18.0 + u_time*0.45) * 6.2832;
      vec2  bv    = vec2(cos(angle), sin(angle)) * tx * 1.0 * bloomZone;
      vec4  bs    = texture2D(tPigment, uv - bv);
      newRGB = mix(newRGB, bs.rgb, bloomZone * 0.050 * u_backrunStrength * bloomScale);
      newA   = mix(newA,   bs.a,   bloomZone * 0.042 * u_backrunStrength * bloomScale);
    }
  }

  // ── F. Stochastic splat brush stamp with Kubelka-Munk mixing ─────────────
  //     Instead of alpha-over compositing, new pigment is mixed with existing
  //     pigment in K/S absorption space.  This gives physically correct
  //     subtractive colour behaviour: R+B→violet, R+Y→orange, not grey/brown.
  //     Brush colours below 0.01 are rejected to prevent black artifacts.
  float brushMax = max(u_color.r, max(u_color.g, u_color.b));
  if (u_painting > 0.5 && brushMax >= 0.01) {
    float totalStamp = 0.0;
    float totalHalo  = 0.0;

    // Accumulate from 7 stochastic splats (same seed as velocity pass)
    for (int i = 0; i < 7; i++) {
      float fi = float(i);
      float s  = u_splatSeed + fi * 13.73;

      vec2 splatOff = vec2(
        _hash1(s * 127.1) - 0.5,
        _hash1(s * 311.7) - 0.5
      ) * u_splatSpread * u_brushRadius * 2.0;

      float sR_splat = u_brushRadius * (0.30 + _hash1(s * 269.5) * 0.70);

      vec2  d    = uv - (u_brushUV + splatOff);
      d.x       *= u_screenAspect;
      float dist  = length(d);

      // Brush shape: round / dry / splatter
      float splatStamp = 0.0;
      float splatHalo  = 0.0;

      if (u_brushType < 0.5) {
        // Round: Gaussian core + noisy edge
        float gauss = exp(-dist*dist / (sR_splat*sR_splat*1.0)) * 0.72;
        float en    = gnoise(uv * 32.0 + vec2(u_time * 1.1 + fi)) * 0.28;
        float edge  = smoothstep(sR_splat*(1.05+abs(en)*0.25), sR_splat*0.15, dist)*0.40;
        splatStamp  = max(gauss, edge);
        splatHalo   = smoothstep(sR_splat*1.6, sR_splat*1.0, dist) * u_waterAmount * 0.18;
      } else if (u_brushType < 1.5) {
        // Dry brush: rectangular with noise break-up
        float fx = abs(d.x)/(sR_splat*2.6);
        float fy = abs(d.y)/(sR_splat*0.30);
        float en = gnoise(uv*32.0+u_time+fi*7.0)*0.22;
        splatStamp = smoothstep(1.0+en, 0.25, max(fx,fy)) * 0.65;
        splatHalo  = smoothstep(sR_splat*1.4, sR_splat*0.65, dist) * u_waterAmount * 0.16;
      } else {
        // Splatter: random sub-droplets
        for(int k=0;k<3;k++){
          float kf=float(k)+fi*3.0;
          vec2 off=hash2(vec2(kf*.137,u_time*.5+kf*.07))*sR_splat*2.4;
          splatStamp=max(splatStamp,smoothstep(1.,0.,length(d-off)/(sR_splat*.18))*0.60);
        }
        splatHalo = smoothstep(sR_splat*2.0, sR_splat*0.8, dist) * u_waterAmount * 0.12;
      }

      // Per-splat pigment load variation: 60–100%
      float loadMul = 0.60 + _hash1(s * 419.3) * 0.40;
      totalStamp += splatStamp * loadMul;
      totalHalo  += splatHalo  * loadMul;
    }

    // Normalise: ~3 splats overlap on average
    totalStamp = min(totalStamp * 0.34, 1.0);
    totalHalo  = min(totalHalo  * 0.34, 0.30);

    if (totalStamp > 0.005) {
      float safeA     = max(newA, 0.001);
      vec3  exCol     = newRGB / safeA;
      float wetPickup = smoothstep(0.06, 0.60, water) * smoothstep(0.03, 0.55, newA);
      float mixAmt    = clamp(u_colorMix * wetPickup, 0.0, 0.85);

      // ── Kubelka-Munk colour mixing ──────────────────────────────────────
      //  Instead of linear RGB lerp, mix in K/S space for correct subtractive
      //  behaviour.  Red+Blue → violet, Red+Yellow → orange (not muddy grey).
      vec3 srcCol;
      if (mixAmt > 0.01 && newA > 0.01) {
        srcCol = _kmMix(u_color, exCol, mixAmt);
      } else {
        srcCol = u_color;
      }

      float srcA = clamp(totalStamp * u_pigmentLoad, 0.0, 0.52);
      float puddleGuard = 1.0 - smoothstep(0.50, 0.95, newA) * smoothstep(0.10, 0.55, water);
      srcA *= mix(1.0, puddleGuard, 0.78);

      // ── K-M layering: new pigment absorbs into existing layer ──────────
      //  compA = total density after compositing
      //  outC  = K-M mixed colour (not alpha-over)
      float compA = srcA + newA * (1.0 - srcA);
      vec3  outC;
      if (compA > 0.001 && newA > 0.01) {
        // Both layers present: K-M absorption composite
        float fNew = srcA / compA;
        outC = _kmMix(srcCol, exCol, 1.0 - fNew);
      } else {
        outC = srcCol;
      }

      float densityCeil = mix(0.62, 0.82, smoothstep(0.10, 0.55, water));
      float outA = min(compA, densityCeil);
      newRGB = clamp(outC * outA, vec3(0.0), vec3(1.0));
      newA   = clamp(outA, 0.0, 1.0);
    }

    if (totalHalo > 0.005) {
      float beforeHaloA = max(newA, 0.001);
      newA = clamp(newA + totalHalo * (0.022 * (1.0 - newA)), 0.0, 1.0);
      newRGB *= newA / beforeHaloA;
    }
  }

  // ── G. Drying concentration ───────────────────────────────────────────────
  //     As dryProgress rises, dissolved pigment concentrates on paper fibres.
  //     Modelled as K/S increase: reflectance drops, colour darkens slightly.
  if (dryProgress > 0.02 && dryProgress < 0.98 && newA > 0.01 && u_painting < 0.5) {
    float concPhase  = smoothstep(0.0, 0.8, dryProgress) * (1.0 - smoothstep(0.8, 1.0, dryProgress));
    float concFactor = concPhase * 0.010 * u_concentrationRate;
    float beforeConcA = max(newA, 0.001);
    newA   = clamp(newA + concFactor * newA, 0.0, 0.88);
    newRGB *= newA / beforeConcA;
  }

  // ── H. Pigment retention / colour lock ───────────────────────────────────
  // Raised base from 0.94 → 0.975 so wet-phase diffusion can only remove
  // at most 2.5 % density per frame (down from 6 %) before the baked lock
  // takes over.  This prevents thin washes from fading during the first 0.8 s.
  if (u_painting < 0.5) {
    float lock   = 1.0 - smoothstep(0.05, 0.75, water);
    float retain = 0.975 + lock * 0.025 * u_retentionStrength;
    newA = max(newA, prev.a * retain);

    float safePrevA = max(prev.a, 0.001);
    float safeNewA  = max(newA, 0.001);
    vec3  prevHue   = prev.rgb / safePrevA;
    vec3  curHue    = newRGB / safeNewA;
    vec3  lockedHue = mix(curHue, prevHue, lock * 0.35 * u_retentionStrength);
    newRGB = clamp(lockedHue, vec3(0.0), vec3(1.0)) * newA;
  }

  newA = clamp(newA, 0.0, 0.88);
  if (newA > 0.001) {
    vec3 hue = _clampHueRange(newRGB / newA);
    newRGB   = hue * newA;
  }

  gl_FragColor = vec4(clamp(newRGB, vec3(0.), vec3(1.)), clamp(newA, 0., 1.));
}
