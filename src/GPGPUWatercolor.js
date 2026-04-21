/**
 * GPGPUWatercolor — Professional-grade fluid simulation engine.
 *
 * Architecture:
 *   • 2 ping-pong velocity RTs  (RG=vel, B=water, A=dryTimer [0→1])
 *   • 2 ping-pong pigment RTs   (RGB=premul pigment, A=density)
 *   • 1 static substrate RT     (R=Worley paper grain height)
 *
 * Per-frame (2 render passes):
 *   Pass 1: Velocity — semi-Lagrangian advection, gravity, brush force,
 *                       substrate resistance, pressure correction,
 *                       per-pixel dryTimer advancement, velocity attenuation
 *   Pass 2: Pigment  — advection (baked-layer protected), wet-on-wet bleed,
 *                       fringing, granulation (dry-boosted), brush stamp,
 *                       drying concentration, pigment lock
 *
 * Drying timeline (per pixel):
 *   0 s → 0.5 s   dryTimer 0.000 → 0.625   full fluid motion
 *   0.5 s → 0.8 s dryTimer 0.625 → 1.000   velocity ramps to 0, pigment locks
 *   > 0.8 s        dryTimer = 1.000          baked — immovable until clear()
 */

import * as THREE from 'three';
import passthroughVert from './shaders/passthrough.vert.glsl?raw';
import velFrag         from './shaders/gpgpu_velocity.frag.glsl?raw';
import pigFrag         from './shaders/gpgpu_pigment.frag.glsl?raw';

const DEFAULT_SIM_RES = 512;

export class GPGPUWatercolor {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    const simRes = Math.max(192, Math.min(2048, Math.round(opts.simResolution ?? DEFAULT_SIM_RES)));
    this.simResolution = simRes;

    // Prefer half-float for mobile performance (WebGL2 has it natively)
    const gl  = renderer.getContext();
    const isWGL2 = (gl instanceof WebGL2RenderingContext);
    const texType = isWGL2 ? THREE.HalfFloatType
      : (renderer.extensions.get('OES_texture_half_float') ? THREE.HalfFloatType : THREE.FloatType);

    const rtBase = {
      minFilter:     THREE.LinearFilter,
      magFilter:     THREE.LinearFilter,
      format:        THREE.RGBAFormat,
      type:          texType,
      depthBuffer:   false,
      stencilBuffer: false,
      wrapS:         THREE.ClampToEdgeWrapping,
      wrapT:         THREE.ClampToEdgeWrapping,
    };

    // Ping-pong pairs
    this.velRT  = [new THREE.WebGLRenderTarget(simRes, simRes, rtBase),
             new THREE.WebGLRenderTarget(simRes, simRes, rtBase)];
    this.pigRT  = [new THREE.WebGLRenderTarget(simRes, simRes, rtBase),
             new THREE.WebGLRenderTarget(simRes, simRes, rtBase)];
    this._velIdx = 0;
    this._pigIdx = 0;
    // Queue of brush positions collected during a frame; processed as sub-steps
    // in update() so every interpolated stamp gets its own GPU render pair.
    this._pendingStrokes = [];

    // Static substrate texture (CPU-generated paper grain)
    this.substrateRT = this._buildSubstrate(simRes >= 512 ? 256 : 192, texType, rtBase);

    // Fullscreen quad scene used by both passes
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geo    = new THREE.PlaneGeometry(2, 2);

    // ── Velocity uniforms ────────────────────────────────────────────────────
    this.velUniforms = {
      tVelocity:        { value: this.velRT[0].texture },
      tSubstrate:       { value: this.substrateRT.texture },
      u_resolution:     { value: new THREE.Vector2(simRes, simRes) },
      u_dt:             { value: 0.016 },
      u_gravity:        { value: new THREE.Vector2(0.0, -0.05) },
      u_viscosity:      { value: 0.12 },
      u_dryRate:        { value: 0.18 },   // slow dry → paint spreads before baking
      u_waterLoad:      { value: 0.50 },   // brush water injection [0=dry, 1=wet]
      u_brushUV:        { value: new THREE.Vector2(0.5, 0.5) },
      u_brushRadius:    { value: 0.04 },
      u_brushForce:     { value: 0.8 },
      u_painting:       { value: 0.0 },
      // Curtis et al. stochastic splat parameters
      u_splatSeed:      { value: 0.0 },
      u_splatSpread:    { value: 0.55 },
      // Ripple-clear wave
      u_rippleCenter:   { value: new THREE.Vector2(0.5, 0.5) },
      u_rippleRadius:   { value: 0.0 },
      u_rippleStrength: { value: 0.0 },
      // Global drying state (CPU-driven, time-since-last-stroke)
      u_isDrying:       { value: 0.0 },   // 1.0 when last stroke was > 0.5 s ago
      u_dryProgress:    { value: 0.0 },   // 0→1 global drying progress
    };

    // Ripple animation state
    this._ripple = null;

    // Drying timer state (CPU-side, global — complements per-pixel GPU timer)
    this._totalTime      = 0.0;   // total simulation time elapsed
    this._lastStrokeTime = -99.0; // time of most recent brush stroke

    // ── God Mode controls (set from UI sliders) ───────────────────────────────
    this.wetDuration      = 0.5;   // seconds paint stays fully wet (0.1 = fast dry, 2.0 = slow)
    this.evaporationRate  = 1.0;   // multiplier on drying speed (1=normal, 2=double speed)
    this.backgroundWetness = 0.4;  // base humidity of paper [0=bone dry, 1=soaking wet]

    // ── Pigment uniforms ─────────────────────────────────────────────────────
    this.pigUniforms = {
      tPigment:     { value: this.pigRT[0].texture },
      tVelocity:    { value: this.velRT[0].texture },
      tSubstrate:   { value: this.substrateRT.texture },
      u_resolution: { value: new THREE.Vector2(simRes, simRes) },
      u_dt:         { value: 0.016 },
      u_brushUV:    { value: new THREE.Vector2(0.5, 0.5) },
      u_color:      { value: new THREE.Vector3(0.23, 0.48, 0.85) },
      u_brushRadius:{ value: 0.04 },
      u_pigmentLoad:{ value: 0.60 },
      u_waterAmount:{ value: 0.25 },
      u_colorMix:   { value: 0.30 },
      u_edgeStrength:{ value: 1.0 },
      u_granulationStrength:{ value: 1.0 },
      u_backrunStrength:{ value: 1.0 },
      u_retentionStrength:{ value: 1.0 },
      u_concentrationRate:{ value: 1.0 },
      u_painting:    { value: 0.0 },
      u_brushType:   { value: 0.0 },
      u_screenAspect:{ value: 1.0 },
      u_time:        { value: 0.0 },
      u_wetCanvas:   { value: 0.0 },
      // Curtis et al. stochastic splat parameters (synced with velocity pass)
      u_splatSeed:   { value: 0.0 },
      u_splatSpread: { value: 0.55 },
      // Global drying state (mirrors velUniforms for pigment pass access)
      u_isDrying:    { value: 0.0 },
      u_dryProgress: { value: 0.0 },
    };

    // Build pass scenes
    const velMat = new THREE.RawShaderMaterial({
      vertexShader: passthroughVert, fragmentShader: velFrag,
      uniforms: this.velUniforms,
    });
    const pigMat = new THREE.RawShaderMaterial({
      vertexShader: passthroughVert, fragmentShader: pigFrag,
      uniforms: this.pigUniforms,
    });

    this._velScene = new THREE.Scene();
    this._velScene.add(new THREE.Mesh(geo, velMat));

    this._pigScene = new THREE.Scene();
    this._pigScene.add(new THREE.Mesh(geo, pigMat));

    this.outputTexture    = this.pigRT[0].texture;
    this.velOutputTexture = this.velRT[0].texture;

    // Expose a flat uniform bag for compatibility with main.js
    this.uniforms = {
      u_waterAmount:   this.pigUniforms.u_waterAmount,
      u_colorMix:      this.pigUniforms.u_colorMix,
      u_edgeStrength:  this.pigUniforms.u_edgeStrength,
      u_granulationStrength: this.pigUniforms.u_granulationStrength,
      u_backrunStrength: this.pigUniforms.u_backrunStrength,
      u_retentionStrength: this.pigUniforms.u_retentionStrength,
      u_concentrationRate: this.pigUniforms.u_concentrationRate,
      u_pigmentLoad:   this.pigUniforms.u_pigmentLoad,
      u_diffusionRate: { value: 0.40 },
      u_flowVelocity:  { value: 0.50 },
      u_wetCanvas:     this.pigUniforms.u_wetCanvas,
      u_time:          this.pigUniforms.u_time,
      u_painting:      this.pigUniforms.u_painting,
      u_brushType:     this.pigUniforms.u_brushType,
      u_brushSize:     { value: 0.04 },
      u_screenAspect:  this.pigUniforms.u_screenAspect,
      u_gravity:       this.velUniforms.u_gravity,
      u_waterLoad:     this.velUniforms.u_waterLoad,
      // Curtis et al. stochastic splats
      u_splatSeed:     this.velUniforms.u_splatSeed,
      u_splatSpread:   this.velUniforms.u_splatSpread,
      // Global drying state — shared references so one write updates all passes
      u_isDrying:      this.velUniforms.u_isDrying,
      u_dryProgress:   this.velUniforms.u_dryProgress,
    };

    // Substrate texel size (for bump normal computation in surface shader)
    const subRes = simRes >= 512 ? 256 : 192;
    this.substrateTexelSize = new THREE.Vector2(1.0 / subRes, 1.0 / subRes);
  }

  // ── CPU-side Worley cell-noise substrate (upgraded paper grain) ─────────────
  // Worley noise creates the organic cell structure of paper fibres:
  // valleys between cells → pigment accumulates here (granulation)
  // ridges at cell edges  → pigment resisted, lifted off by fibres
  // Combined with FBM macro variation for realistic cold-press paper texture.
  _buildSubstrate(res, texType, rtBase) {
    // Hash helpers (deterministic pseudo-random)
    const h = (px, py) => {
      const v = Math.sin(px * 127.1 + py * 311.7) * 43758.5453;
      return v - Math.floor(v);
    };

    // Worley cell noise: returns distance to nearest cell centre [0..1]
    // Inverted (1 - dist) → high value at cell centres (valley of each cell),
    // low value at cell boundaries (ridges between cells).
    const worley = (x, y, scale) => {
      const sx = x * scale, sy = y * scale;
      const ix = Math.floor(sx), iy = Math.floor(sy);
      let minDist = 9999;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const jx = ix + dx, jy = iy + dy;
          // Pseudo-random cell centre offset [0,1]
          const cx = jx + h(jx + 17, jy + 3);
          const cy = jy + h(jy + 43, jx + 7);
          const d  = Math.sqrt((sx - cx) ** 2 + (sy - cy) ** 2);
          minDist  = Math.min(minDist, d);
        }
      }
      return Math.min(minDist / 0.9, 1.0);  // normalise to [0..1]
    };

    // Value noise for macro FBM (paper thickness / sizing variation)
    const vnoise = (x, y) => {
      const ix = Math.floor(x), iy = Math.floor(y);
      const fx = x - ix, fy = y - iy;
      const ux = fx*fx*(3-2*fx), uy = fy*fy*(3-2*fy);
      return (h(ix,iy)*(1-ux) + h(ix+1,iy)*ux) * (1-uy) +
             (h(ix,iy+1)*(1-ux) + h(ix+1,iy+1)*ux) * uy;
    };
    const fbm = (x, y, oct) => {
      let val = 0, amp = 0.5, freq = 1;
      for (let i = 0; i < oct; i++) {
        val += vnoise(x*freq, y*freq) * amp;
        freq *= 2.07; amp *= 0.50;
      }
      return Math.max(0, Math.min(1, val));
    };

    // Allocate Float32 data (RGBA — R = grain height used by shaders)
    const data = new Float32Array(res * res * 4);
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const ux = x / res, uy = y / res;

        // Worley at 3 scales — coarse fibre bundles, medium fibres, micro pits
        const wCoarse = worley(ux, uy, 6.0);    // coarse paper fibre cells
        const wMedium = worley(ux, uy, 16.0);   // individual fibres
        const wFine   = worley(ux, uy, 38.0);   // micro pit structure

        // FBM macro variation — paper is not perfectly uniform
        const macro = fbm(ux * 3.5, uy * 3.5, 4);

        // Combine: inverted Worley → high at fibre centres (pigment collects)
        // Low at fibre edges (boundaries = ridges = pigment-resistant peaks)
        let val = (1.0 - wCoarse) * 0.30
                + (1.0 - wMedium) * 0.35
                + (1.0 - wFine  ) * 0.20
                + macro           * 0.15;

        // Sharpen: paper has distinct ridges and valleys (cold-press characteristic)
        val = Math.pow(Math.max(0, Math.min(1, val)), 0.72);

        const idx = (y * res + x) * 4;
        data[idx]   = val;     // R = grain height (main channel used by shaders)
        data[idx+1] = wMedium; // G = medium Worley (anisotropy hint, optional)
        data[idx+2] = 0;
        data[idx+3] = 1;
      }
    }

    const tex = new THREE.DataTexture(data, res, res, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;

    // Wrap in a fake RT so the API matches
    return { texture: tex };
  }

  // ── Internal: execute one vel+pig render pair ──────────────────────────────
  // Called once per sub-step inside update().  Handles ping-pong internally.
  _runPasses(dt, painting) {
    const vRead  = this._velIdx;
    const vWrite = 1 - this._velIdx;
    this.velUniforms.tVelocity.value  = this.velRT[vRead].texture;
    this.velUniforms.u_dt.value       = dt;
    this.velUniforms.u_painting.value = painting;
    this.renderer.setRenderTarget(this.velRT[vWrite]);
    this.renderer.render(this._velScene, this._camera);
    this._velIdx = vWrite;

    const pRead  = this._pigIdx;
    const pWrite = 1 - this._pigIdx;
    this.pigUniforms.tPigment.value   = this.pigRT[pRead].texture;
    this.pigUniforms.tVelocity.value  = this.velRT[vWrite].texture;
    this.pigUniforms.u_dt.value       = dt;
    this.pigUniforms.u_painting.value = painting;
    this.renderer.setRenderTarget(this.pigRT[pWrite]);
    this.renderer.render(this._pigScene, this._camera);
    this._pigIdx = pWrite;

    this.renderer.setRenderTarget(null);
    this.outputTexture    = this.pigRT[this._pigIdx].texture;
    this.velOutputTexture = this.velRT[this._velIdx].texture;
  }

  // ── Notify the engine that a brush stroke just occurred ────────────────────
  // Call this each frame that gpgpu.paint() is called.
  // Resets the CPU-side global drying clock so u_isDrying / u_dryProgress
  // go back to 0.0, giving fresh strokes their full 0.5 s wet window.
  notifyStroke() {
    this._lastStrokeTime = this._totalTime;
  }

  // ── Main simulation step ────────────────────────────────────────────────────
  update(dt, time) {
    const clampedDt = Math.min(dt, 0.033);

    // Advance CPU-side simulation clock
    this._totalTime += clampedDt;

    // ── Global drying state (time since last brush stroke) ─────────────────
    // 0 s → 0.5 s:  isDrying = 0, dryProgress = 0   (active wet phase)
    // 0.5 s → 0.8 s: dryProgress lerps 0 → 1         (drying transition)
    // > 0.8 s:        dryProgress = 1                  (fully dried)
    const elapsed      = this._totalTime - this._lastStrokeTime;
    const wetWindow    = Math.max(0.05, this.wetDuration);
    const dryWindow    = Math.max(0.05, 0.3 / Math.max(0.1, this.evaporationRate));
    const globalDryProg = Math.max(0, Math.min(1, (elapsed - wetWindow) / dryWindow));
    const isDrying      = globalDryProg > 0.01 ? 1.0 : 0.0;
    // Write to velUniforms — pigUniforms share the same uniform objects
    this.velUniforms.u_isDrying.value    = isDrying;
    this.velUniforms.u_dryProgress.value = globalDryProg;
    // Mirror into pigUniforms (separate objects — must sync explicitly)
    this.pigUniforms.u_isDrying.value    = isDrying;
    this.pigUniforms.u_dryProgress.value = globalDryProg;

    // Sync uniform mappings
    this.velUniforms.u_viscosity.value   = 0.05 + this.uniforms.u_diffusionRate.value * 0.25;
    this.velUniforms.u_brushForce.value  = 0.4  + this.uniforms.u_flowVelocity.value  * 1.0;
    // Base dryRate driven by wetness + evaporation; backgroundWetness slows evaporation
    const wetFactor = Math.max(0, 1.0 - this.backgroundWetness * 0.7);
    this.velUniforms.u_dryRate.value     = (0.12 + wetFactor * 0.18) * Math.max(0.05, this.evaporationRate);
    this.velUniforms.u_brushRadius.value = this.uniforms.u_brushSize.value;
    this.velUniforms.u_waterLoad.value   = this.uniforms.u_waterLoad.value;
    this.pigUniforms.u_brushRadius.value = this.uniforms.u_brushSize.value;
    this.pigUniforms.u_time.value        = time;

    // ── Splat seed base (varied per-stamp in the render loop below) ───────────
    const splatSeed = (this._totalTime * 7.31) % 1000.0;
    // Sync splatSpread (shared across all stamps in a frame)
    this.velUniforms.u_splatSpread.value = this.uniforms.u_splatSpread.value;
    this.pigUniforms.u_splatSpread.value = this.uniforms.u_splatSpread.value;

    // ── Ripple clear wave animation ────────────────────────────────────────
    if (this._ripple && this._ripple.active) {
      this._ripple.age += clampedDt;
      const t = this._ripple.age;
      this.velUniforms.u_rippleRadius.value   = t * 1.8;          // expand 1.8 UV/s
      this.velUniforms.u_rippleStrength.value = Math.max(0, 1.0 - t / 0.55);
      if (t > 0.55) {
        this._ripple.active = false;
        this.velUniforms.u_rippleStrength.value = 0.0;
      }
    }

    // ── Sub-step rendering: one GPU pair per queued brush position ────────────
    // Each paint() call queued a position.  We now render them in order so
    // every interpolated stamp actually hits the GPU — fixing gaps at high speed.
    // dt is split evenly so the total physics effect per frame stays correct.
    const strokes = this._pendingStrokes;

    if (strokes.length === 0) {
      // No painting this frame: one physics-only pass (drying / gravity / etc.)
      this.velUniforms.u_splatSeed.value = splatSeed;
      this.pigUniforms.u_splatSeed.value = splatSeed;
      this._runPasses(clampedDt, 0.0);
    } else {
      const subDt = clampedDt / strokes.length;
      for (let i = 0; i < strokes.length; i++) {
        const { u, v } = strokes[i];
        this.velUniforms.u_brushUV.value.set(u, v);
        this.pigUniforms.u_brushUV.value.set(u, v);
        // Vary splat seed per stamp → unique stochastic splat patterns per step
        const stepSeed = (splatSeed + i * 13.73) % 1000.0;
        this.velUniforms.u_splatSeed.value = stepSeed;
        this.pigUniforms.u_splatSeed.value = stepSeed;
        this._runPasses(subDt, 1.0);
      }
      this._pendingStrokes = [];
    }

    // Reset paint flag
    this.uniforms.u_painting.value    = 0.0;
    this.velUniforms.u_painting.value = 0.0;
    this.pigUniforms.u_painting.value = 0.0;
  }

  // ── Stamp a brush at surface UV (u, v) ─────────────────────────────────────
  // Shared options (color, size, water, …) are applied immediately to the
  // uniforms.  The position (u, v) is queued; update() will sub-step through
  // all queued positions, giving each its own GPU render pair so no stamp
  // is ever skipped — even at full-speed fast swipes.
  paint(u, v, options = {}) {
    // Set shared (non-position) uniforms — same for all stamps in a stroke.
    if (options.color) {
      this.pigUniforms.u_color.value.set(options.color.r, options.color.g, options.color.b);
    }
    if (options.waterAmount  !== undefined) this.uniforms.u_waterAmount.value  = options.waterAmount;
    if (options.pigmentLoad  !== undefined) this.uniforms.u_pigmentLoad.value  = options.pigmentLoad;
    if (options.flowVelocity !== undefined) this.uniforms.u_flowVelocity.value = options.flowVelocity;
    if (options.diffusionRate!== undefined) this.uniforms.u_diffusionRate.value= options.diffusionRate;
    if (options.wetCanvas    !== undefined) this.uniforms.u_wetCanvas.value    = options.wetCanvas ? 1.0 : 0.0;
    if (options.brushType    !== undefined) this.uniforms.u_brushType.value    = options.brushType;
    if (options.brushSize    !== undefined) this.uniforms.u_brushSize.value    = options.brushSize;
    if (options.screenAspect !== undefined) this.uniforms.u_screenAspect.value = options.screenAspect;
    if (options.colorMix     !== undefined) this.uniforms.u_colorMix.value     = options.colorMix;
    if (options.edgeStrength !== undefined) this.uniforms.u_edgeStrength.value  = options.edgeStrength;
    if (options.granulationStrength !== undefined) this.uniforms.u_granulationStrength.value = options.granulationStrength;
    if (options.backrunStrength !== undefined) this.uniforms.u_backrunStrength.value = options.backrunStrength;
    if (options.retentionStrength !== undefined) this.uniforms.u_retentionStrength.value = options.retentionStrength;
    if (options.pigmentLoad  !== undefined) this.pigUniforms.u_pigmentLoad.value= options.pigmentLoad;
    if (options.waterAmount  !== undefined) this.pigUniforms.u_waterAmount.value= options.waterAmount;

    this.uniforms.u_painting.value = 1.0;

    // Queue this position — update() will render a GPU pass for each entry.
    this._pendingStrokes.push({ u, v });
  }

  // ── Trigger expanding ripple (wave-clear animation) ────────────────────────
  // cx, cy in UV space [0..1]. Call this BEFORE clear() — give it ~650 ms.
  triggerRipple(cx = 0.5, cy = 0.5) {
    this._ripple = { age: 0, active: true };
    this.velUniforms.u_rippleCenter.value.set(cx, cy);
    this.velUniforms.u_rippleRadius.value   = 0.0;
    this.velUniforms.u_rippleStrength.value = 1.0;
  }

  // ── Clear both buffers + reset drying clock ────────────────────────────────
  // Clears all velocity (including dryTimer A channel), pigment, and baked state.
  // The wave gesture calls this after the ripple animation completes.
  clear() {
    const savedColor = new THREE.Color();
    const savedAlpha = this.renderer.getClearAlpha();
    this.renderer.getClearColor(savedColor);
    this.renderer.setClearColor(0x000000, 0);

    for (const rt of [...this.velRT, ...this.pigRT]) {
      this.renderer.setRenderTarget(rt);
      this.renderer.clear(true, false, false);
    }
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(savedColor, savedAlpha);

    // Reset global drying clock — fresh canvas = no drying in progress
    this._lastStrokeTime             = -99.0;
    this.velUniforms.u_isDrying.value    = 0.0;
    this.velUniforms.u_dryProgress.value = 0.0;
    this.pigUniforms.u_isDrying.value    = 0.0;
    this.pigUniforms.u_dryProgress.value = 0.0;
  }

  dispose() {
    [...this.velRT, ...this.pigRT].forEach(rt => rt.dispose());
  }
}
