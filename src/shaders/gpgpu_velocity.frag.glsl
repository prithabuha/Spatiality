/**
 * FluidSolver — Shallow Water Equations + Curtis et al. stochastic splats
 *               + per-pixel drying timer.
 *
 * Physics model (Curtis et al. 1997, three-layer):
 *   Layer 1: Shallow water film on paper surface
 *   Layer 2: Pigment suspended in water (handled in pigment pass)
 *   Layer 3: Paper substrate (static height map)
 *
 * Shallow Water Equations solved per-frame:
 *   ∂h/∂t + ∇·(h·u⃗) = S        (mass: evaporation + brush injection)
 *   ∂u⃗/∂t + (u⃗·∇)u⃗ = -g∇h      (hydrostatic pressure gradient)
 *                     - μ·u⃗      (viscous drag from paper)
 *                     - κ∇h_p·h  (capillary suction into paper valleys)
 *                     + σ∇²h·n̂   (surface tension smoothing)
 *                     + F_ext    (gravity, brush force)
 *
 * Semi-Lagrangian advection for unconditional stability at large dt.
 *
 * Buffer layout (RGBA):
 *   R = velocity X   (UV space)
 *   G = velocity Y   (UV space, +Y = up)
 *   B = water height  [0, 1]  — shallow water film thickness
 *   A = dryTimer      [0 → 1] — per-pixel drying timer
 *
 * Stochastic splats (Curtis et al.):
 *   7 randomized circular water/force deposits per brush stamp.
 *   Same u_splatSeed used in pigment pass → water and pigment co-located.
 */

precision highp float;

uniform sampler2D tVelocity;
uniform sampler2D tSubstrate;
uniform vec2  u_resolution;
uniform float u_dt;
uniform vec2  u_gravity;
uniform float u_viscosity;
uniform float u_dryRate;
uniform float u_waterLoad;
uniform vec2  u_brushUV;
uniform float u_brushRadius;
uniform float u_brushForce;
uniform float u_painting;

// Curtis et al. stochastic splat parameters
uniform float u_splatSeed;     // deterministic seed (synced with pigment pass)
uniform float u_splatSpread;   // offset spread factor [0=tight, 1+=scattered]

// Global drying state (CPU-uploaded, for supplementary modulation)
uniform float u_isDrying;
uniform float u_dryProgress;

// Ripple-clear wave
uniform vec2  u_rippleCenter;
uniform float u_rippleRadius;
uniform float u_rippleStrength;

// ── Deterministic hash functions ─────────────────────────────────────────────
float _hash1(float n) { return fract(sin(n) * 43758.5453123); }
vec2  _hash2(vec2  p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453123);
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

  // ── 1. Semi-Lagrangian advection (velocity + water height) ────────────────
  // dryTimer is per-position (NOT advected) → locked pixels stay stable.
  vec2 backPos  = clamp(uv - vel * dt, tx, 1.0 - tx);
  vec4 advected = texture2D(tVelocity, backPos);
  vec2  newVel   = advected.rg;
  float newWater = advected.b;

  // ── 2. Per-pixel dry timer advancement ────────────────────────────────────
  float wasEverPainted = step(0.001, dryTimer);
  float isNowWet       = step(0.001, newWater);
  float shouldTick     = max(wasEverPainted, isNowWet);
  float newTimer       = clamp(dryTimer + dt * (1.0 / 0.8) * shouldTick, 0.0, 1.0);
  float dryProgress    = smoothstep(0.625, 1.0, newTimer);

  // ── 3. Shallow Water Equation forces ──────────────────────────────────────

  // Sample 4-neighbourhood water heights + substrate heights
  float hR = texture2D(tVelocity, uv + vec2( tx.x, 0.0)).b;
  float hL = texture2D(tVelocity, uv - vec2( tx.x, 0.0)).b;
  float hU = texture2D(tVelocity, uv + vec2(0.0,  tx.y)).b;
  float hD = texture2D(tVelocity, uv - vec2(0.0,  tx.y)).b;

  float sR = texture2D(tSubstrate, uv + vec2( tx.x, 0.0)).r;
  float sL = texture2D(tSubstrate, uv - vec2( tx.x, 0.0)).r;
  float sU = texture2D(tSubstrate, uv + vec2(0.0,  tx.y)).r;
  float sD = texture2D(tSubstrate, uv - vec2(0.0,  tx.y)).r;

  // 3a. Hydrostatic pressure gradient: F = -g_hydro · ∇(water_height)
  //     Water flows from high water regions to low water regions.
  //     Anisotropic: cold-press paper has horizontal fibres → water spreads
  //     35% faster along X, slightly slower along Y.  This creates the
  //     characteristic elongated bead that follows the paper grain.
  vec2 waterGrad  = vec2(hR - hL, hU - hD) * 0.5;
  float g_hydro   = 2.0;
  vec2  fiberAniso = vec2(1.35, 0.90);   // horizontal fibre bias
  newVel -= waterGrad * fiberAniso * g_hydro * dt;

  // 3b. Capillary suction: F_cap = -κ · ∇(paper_height) · water
  //     Water is drawn toward paper valleys (low substrate height).
  //     Capillary channels also follow the fibre direction (anisotropic).
  vec2 substGrad  = vec2(sR - sL, sU - sD) * 0.5;
  float kappa_cap = 0.60;
  vec2  capAniso  = vec2(1.28, 0.80);    // capillary stronger along fibres
  newVel -= substGrad * capAniso * kappa_cap * newWater * dt;

  // 3c. Surface tension: F_st = σ · ∇²h · gradient_direction
  //     Smooths the water surface — prevents unphysical spikes.
  float waterLap  = hR + hL + hU + hD - 4.0 * newWater;
  float sigma_st  = 0.18;  // surface tension coefficient
  newVel += waterGrad * waterLap * sigma_st * dt;

  // 3d. External gravity (IMU / default downward)
  //     Gravity ∝ water² → only fully wet paint drips visibly
  newVel += u_gravity * (newWater * newWater) * dt * 2.4;

  // ── 4. Stochastic splat brush stamp (Curtis et al.) + timer RESET ─────────
  //     7 randomised circular deposits simulate hair-bundle contact.
  //     Each splat: random offset, random radius (30–100% of R), random water.
  if (u_painting > 0.5) {
    float maxEff      = 0.0;
    vec2  accumForce  = vec2(0.0);
    float maxWaterInj = 0.0;

    for (int i = 0; i < 7; i++) {
      float fi = float(i);
      float s  = u_splatSeed + fi * 13.73;

      // Deterministic random offset from brush centre
      vec2 splatOff = vec2(
        _hash1(s * 127.1) - 0.5,
        _hash1(s * 311.7) - 0.5
      ) * u_splatSpread * u_brushRadius * 2.0;

      // Per-splat radius: 30–100% of brush radius
      float sR_splat = u_brushRadius * (0.30 + _hash1(s * 269.5) * 0.70);

      vec2  d    = uv - (u_brushUV + splatOff);
      float dist = length(d);
      float eff  = exp(-dist * dist / (sR_splat * sR_splat * 0.8));

      if (eff > 0.04) {
        maxEff = max(maxEff, eff);

        vec2 dir  = dist > 0.001 ? d / dist : vec2(0.0);
        vec2 tang = vec2(-dir.y, dir.x);
        // Force calibrated: ~3 splats overlap → 0.22 keeps total ≈ original
        accumForce += (dir * 0.65 + tang * 0.35) * eff * u_brushForce * dt * 0.22;

        // Water injection: per-splat random amount (50–100%)
        float wMul    = 0.50 + _hash1(s * 183.3) * 0.50;
        float injectW = (0.28 + u_waterLoad * 0.67) * wMul;
        maxWaterInj   = max(maxWaterInj, eff * injectW);
      }
    }

    if (maxEff > 0.04) {
      // Fresh brush contact: reset drying timer → pixel is wet again
      newTimer    = 0.0;
      dryProgress = 0.0;
      newVel     += accumForce;
      newWater    = max(newWater, maxWaterInj);
    }
  }

  // ── 5. Velocity attenuation — dryProgress freeze mechanic ─────────────────
  newVel *= (1.0 - dryProgress);

  // ── 6. Substrate resistance — paper fibre drag ────────────────────────────
  //     Peaks (high subst) resist flow; valleys (low subst) channel it.
  float resistance = 1.0 - subst * 0.70;
  newVel *= resistance;

  // ── 7. Viscosity (Laplacian smoothing of velocity field) ──────────────────
  vec2 vR = texture2D(tVelocity, uv + vec2( tx.x, 0.0)).rg;
  vec2 vL = texture2D(tVelocity, uv - vec2( tx.x, 0.0)).rg;
  vec2 vU = texture2D(tVelocity, uv + vec2(0.0,  tx.y)).rg;
  vec2 vD = texture2D(tVelocity, uv - vec2(0.0,  tx.y)).rg;
  vec2 velLap = vR + vL + vU + vD - 4.0 * newVel;
  // Attenuate viscous spreading during drying for clean freeze
  newVel += velLap * u_viscosity * dt * (1.0 - dryProgress * 0.85);

  // ── 8. Pressure projection (divergence correction) ────────────────────────
  //     Approximate Helmholtz-Hodge: remove divergent component.
  //     ∇·u⃗ computed from neighbour velocities; projected out iteratively.
  float divX = (vR.x - vL.x) * 0.5;
  float divY = (vU.y - vD.y) * 0.5;
  float div  = divX + divY;
  // Pressure gradient correction (1 Jacobi iteration, relaxation 0.35)
  newVel.x -= divX * div * 0.35;
  newVel.y -= divY * div * 0.35;

  // ── 9. Water redistribution — shallow water mass conservation ─────────────
  //     ∂h/∂t = -∇·(h·u⃗)  →  discrete: h -= dt · div(h·u)
  //     This moves water mass along the velocity field.
  float hVelR = hR * vR.x;
  float hVelL = hL * vL.x;
  float hVelU = hU * vU.y;
  float hVelD = hD * vD.y;
  float waterFlux = ((hVelR - hVelL) + (hVelU - hVelD)) * 0.5;
  newWater = max(0.0, newWater - waterFlux * dt * 0.6);

  // ── 10. Ripple clear wave ─────────────────────────────────────────────────
  if (u_rippleStrength > 0.002) {
    vec2  d    = uv - u_rippleCenter;
    float r    = length(d);
    float ring = exp(-pow(r - u_rippleRadius, 2.0) / 0.0016);
    vec2  rDir = r > 0.001 ? d / r : vec2(0.0, 1.0);
    newVel    += rDir * ring * u_rippleStrength * 1.4;
    newWater   = max(newWater, ring * 0.65 * u_rippleStrength);
    newTimer   = mix(newTimer, 0.0, ring * u_rippleStrength);
  }

  // ── 11. Boundary conditions (no-slip walls) ───────────────────────────────
  vec2  bEdge    = min(uv, 1.0 - uv);
  float boundary = smoothstep(0.0, tx.x * 4.0, bEdge.x)
                 * smoothstep(0.0, tx.y * 4.0, bEdge.y);
  newVel *= boundary;

  // ── 12. Evaporation — non-linear drying front ─────────────────────────────
  //     Evap rate: slow at high water (surface tension), fast near zero
  //     (drying front effect — last moisture leaves quickly).
  // Slower evaporation → paint stays wet longer, flows & merges more (Tint-style).
  float highWaterBrake = 0.30 + newWater * 0.70;
  float nearZeroBoost  = 1.0 + (1.0 - newWater) * (1.0 - newWater) * 0.55;
  float evapRate       = u_dryRate * 0.72 * highWaterBrake * nearZeroBoost;
  evapRate *= (1.0 + dryProgress * 0.20);
  newWater  = max(0.0, newWater - evapRate * dt);

  // ── 13. Wet-mask velocity lock (physics) ──────────────────────────────────
  //     v ∝ water^1.5 — paint physically freezes as film thins.
  float wetMask = pow(smoothstep(0.0, 0.10, newWater), 1.5);
  newVel *= wetMask;

  float speed = length(newVel);
  if (speed > 1.8) newVel = (newVel / speed) * 1.8;

  // ── Output ────────────────────────────────────────────────────────────────
  gl_FragColor = vec4(newVel, newWater, newTimer);
}
