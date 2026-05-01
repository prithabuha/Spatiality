/**
 * main.js — Rebelle-style AR Watercolor  ·  Kids Mode
 *
 * ── Controls ────────────────────────────────────────────────────────────────
 *   Index finger visible  → paint  (no pinch required)
 *   Hand depth (Z)        → brush size + water amount
 *       Close = fine, dry detail strokes
 *       Far   = large, wet, bleeding splatter
 *   Touch colour orb      → switch colour  +  audio "pop"  +  haptic
 *   Wave BOTH hands       → ripple animation → clear canvas
 *   Open hand (hold 1.2s) → clear (single-hand fallback)
 *   Click-drag            → mouse/touch paint fallback
 *   Scroll wheel          → zoom
 *   Device tilt           → gravity drip direction (IMU)
 */

import * as THREE            from 'three';
import { GPGPUWatercolor }   from './GPGPUWatercolor.js';
import { Scene }             from './Scene.js';
import { HandTracker }       from './HandTracker.js';
import { WaterCursor }       from './WaterCursor.js';
import { PaperContainer }    from './PaperContainer.js';
import { MadMapperRelay }    from './madmapper_relay.js';

// ── Paper surface init (grain overlay + warm-white background) ───────────────
const _paper = new PaperContainer();

// ── DOM ──────────────────────────────────────────────────────────────────────
const canvas      = document.getElementById('three-canvas');
const webcamBg    = document.getElementById('webcam-bg');
const handOverlay = document.getElementById('hand-overlay');
const hintChip    = document.getElementById('hint-chip');

// ── God Mode elements (dev-only, toggled with G key) ─────────────────────────
const godModeToggle = document.getElementById('god-mode-toggle');
const godModePanel  = document.getElementById('god-mode');
const gmBrushType   = document.getElementById('gm-brushtype');
const gmSliders = {
  size:       document.getElementById('gm-size'),
  pigment:    document.getElementById('gm-pigment'),
  splat:      document.getElementById('gm-splat'),
  wetness:    document.getElementById('gm-wetness'),
  diffusion:  document.getElementById('gm-diffusion'),
  mix:        document.getElementById('gm-mix'),
  gravity:    document.getElementById('gm-gravity'),
  wetwindow:  document.getElementById('gm-wetwindow'),
  evap:       document.getElementById('gm-evap'),
  edge:       document.getElementById('gm-edge'),
  grain:      document.getElementById('gm-grain'),
  backrun:    document.getElementById('gm-backrun'),
  borderblur: document.getElementById('gm-borderblur'),
};
const gmValues = {
  size:       document.getElementById('gv-size'),
  pigment:    document.getElementById('gv-pigment'),
  splat:      document.getElementById('gv-splat'),
  wetness:    document.getElementById('gv-wetness'),
  diffusion:  document.getElementById('gv-diffusion'),
  mix:        document.getElementById('gv-mix'),
  gravity:    document.getElementById('gv-gravity'),
  wetwindow:  document.getElementById('gv-wetwindow'),
  evap:       document.getElementById('gv-evap'),
  edge:       document.getElementById('gv-edge'),
  grain:      document.getElementById('gv-grain'),
  backrun:    document.getElementById('gv-backrun'),
  borderblur: document.getElementById('gv-borderblur'),
};

function getPerformanceProfile() {
  const profiles = {
    projection: { pixelRatioCap: 4.0,  simResolution: 1024, antialias: true  }, // 4K projector — stable max (2048 causes WebGL OOM)
    high:       { pixelRatioCap: 2.0,  simResolution: 1024, antialias: true  },
    balanced:   { pixelRatioCap: 1.5,  simResolution: 768,  antialias: true  },
    fast:       { pixelRatioCap: 1.25, simResolution: 512,  antialias: false },
  };

  // URL override — e.g. ?quality=fast for low-end devices
  const qualityParam = new URLSearchParams(window.location.search)
    .get('quality')
    ?.toLowerCase();
  if (qualityParam && profiles[qualityParam]) {
    return { name: qualityParam, ...profiles[qualityParam] };
  }

  // Default: full 4K projection quality for thesis / large-screen installs
  return { name: 'projection', ...profiles.projection };
}

const perfProfile = getPerformanceProfile();

// ── Renderer ──────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: perfProfile.antialias,
  powerPreference: 'high-performance',
  // Required for MadMapper relay — lets readPixels read back the rendered frame
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, perfProfile.pixelRatioCap));
renderer.setSize(window.innerWidth, window.innerHeight);
canvas.style.touchAction = 'none';

// ── GPGPU + Scene ─────────────────────────────────────────────────────────────
const gpgpu   = new GPGPUWatercolor(renderer, { simResolution: perfProfile.simResolution });
const scene   = new Scene(renderer, gpgpu);

// ── 4-wall projection: read ?wall=front|back|left|right  &  ?fov=80 ──────────
// Each projector opens this page with a different ?wall= param.
// Omit ?wall= for the default single-display / development view.
const _urlParams  = new URLSearchParams(window.location.search)
const _wallParam  = _urlParams.get('wall')     // 'front' | 'back' | 'left' | 'right' | null
const _fovParam   = parseFloat(_urlParams.get('fov') || '80')
const _isWallView = Boolean(_wallParam)        // true on wall projectors

if (_isWallView) {
  scene.setWallCamera(_wallParam, _fovParam)
  // Hide hand-overlay UI elements — not needed on secondary wall displays
  if (webcamBg)    webcamBg.style.display    = 'none'
  if (handOverlay) handOverlay.style.display = 'none'
  if (hintChip)    hintChip.style.display    = 'none'
  console.info(`[4-wall] Wall view: ${_wallParam}  fov=${_fovParam}°`)
}

const tracker = new HandTracker(webcamBg, handOverlay);

// ── Camera permission gate ────────────────────────────────────────────────────
// Shows a full-screen "Allow Camera" button so the browser permission dialog is
// always triggered from a real user gesture.  Dismissed automatically once the
// hand tracker reports it's ready (camera stream running).
;(function _cameraGate() {
  const gate    = document.getElementById('camera-gate')
  const btn     = document.getElementById('btn-allow-camera')
  const status  = document.getElementById('camera-gate-status')
  const welcome = document.getElementById('ar-welcome')
  if (!gate || !btn) return

  // Wall views don't need camera — skip gate immediately
  if (_isWallView) { gate.style.display = 'none'; _showWelcome(); return }

  function _showWelcome() {
    if (welcome) { welcome.style.display = 'flex'; requestAnimationFrame(() => welcome.classList.remove('hidden')) }
  }
  function _dismissGate() {
    gate.classList.add('hidden')
    setTimeout(() => { gate.style.display = 'none' }, 700)
    _showWelcome()
  }

  // ── Phase-based button flow ──────────────────────────────────────────────
  // Phase 'allow'  → button triggers browser permission dialog
  // Phase 'select' → multiple cameras found; user picks one, button confirms
  // Phase 'start'  → single camera; start immediately after permission
  let _phase          = 'allow'
  let _chosenDeviceId = null

  // Build camera selector (idempotent — only inserts once)
  function _buildCameraSelect(cameras) {
    if (document.getElementById('cam-select')) return   // already built
    const inner = gate.querySelector('.ar-inner')

    const label = document.createElement('p')
    label.id = 'cam-select-label'
    label.style.cssText = 'font-size:15px;color:#7a746e;text-align:center;margin:0'
    label.textContent   = 'Multiple cameras — pick the one facing the room:'
    inner.insertBefore(label, btn)

    const sel = document.createElement('select')
    sel.id = 'cam-select'
    sel.style.cssText = [
      "font-family:'Quicksand',sans-serif", 'font-size:16px', 'font-weight:600',
      'border:2px solid #e0dbd4', 'border-radius:12px', 'padding:10px 16px',
      'background:#fff', 'color:#3a3530', 'cursor:pointer',
      'width:100%', 'max-width:340px',
    ].join(';')
    cameras.forEach((cam, i) => {
      const opt       = document.createElement('option')
      opt.value       = cam.deviceId
      opt.textContent = cam.label || `Camera ${i + 1}`
      sel.appendChild(opt)
    })
    _chosenDeviceId = cameras[0].deviceId
    sel.addEventListener('change', () => { _chosenDeviceId = sel.value })
    inner.insertBefore(sel, btn)
  }

  // ── Button click handler ─────────────────────────────────────────────────
  btn.addEventListener('click', async () => {
    btn.disabled = true

    // ── Phase: confirm camera choice and start ───────────────────────────
    if (_phase === 'select') {
      btn.textContent = 'Starting…'
      if (status) { status.textContent = '✓ Starting hand tracking…'; status.className = 'ok' }
      try {
        await tracker.startCamera(_chosenDeviceId)
        _dismissGate()
      } catch (err) {
        btn.disabled   = false
        btn.textContent = 'Try Again →'
        if (status) status.textContent = `⚠️ ${err.message || err.name}`
      }
      return
    }

    // ── Phase: request camera permission ────────────────────────────────
    btn.textContent = 'Opening camera…'
    if (status) { status.textContent = ''; status.className = '' }

    try {
      // Step 1: trigger permission dialog (needs user gesture)
      const tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      tempStream.getTracks().forEach(t => t.stop())   // release immediately

      // Step 2: enumerate — labels are available now permission is granted
      const devices = await navigator.mediaDevices.enumerateDevices()
      const cameras = devices.filter(d => d.kind === 'videoinput')

      if (cameras.length >= 2) {
        // Multiple cameras — let user pick before starting tracker
        _buildCameraSelect(cameras)
        _phase = 'select'
        btn.disabled    = false
        btn.textContent = 'Use This Camera →'
        if (status) { status.textContent = '✓ Pick your camera, then tap the button'; status.className = 'ok' }
        // Return here — wait for second click in 'select' phase
      } else {
        // Single camera — start immediately
        if (cameras.length === 1) _chosenDeviceId = cameras[0].deviceId
        if (status) { status.textContent = '✓ Camera ready — starting…'; status.className = 'ok' }
        await tracker.startCamera(_chosenDeviceId)
        _dismissGate()
      }
    } catch (err) {
      _phase          = 'allow'
      btn.disabled    = false
      btn.textContent = 'Try Again →'
      if (status) {
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          status.textContent = '🔒 Blocked — click the 🔒 icon in the address bar → Camera → Allow'
        } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          status.textContent = '📷 No camera found — you can still paint with mouse'
          setTimeout(_dismissGate, 2200)
        } else {
          status.textContent = `⚠️ ${err.message || err.name}`
        }
      }
    }
  })

  // Auto-dismiss when HandTracker already initialised (permission pre-granted)
  const _check = setInterval(() => {
    if (tracker.ready) { clearInterval(_check); _dismissGate() }
  }, 500)
})()

// ── MadMapper relay (off by default — add ?madmapper=1 to URL to activate) ──
const relay = new MadMapperRelay(renderer, scene.scene, scene.camera)

console.info(
  `[Perf] profile=${perfProfile.name}, sim=${perfProfile.simResolution}, pixelRatioCap=${perfProfile.pixelRatioCap}`
);

// ── Painting state ────────────────────────────────────────────────────────────
let activeColor = new THREE.Color(0.85, 0.19, 0.38);  // start Quinacridone Rose

// ── Water cursor (color now driven by kiosk BroadcastChannel) ────────────────
scene.setBucketsVisible(false);

const waterCursor = new WaterCursor();
waterCursor.setColor(activeColor.r, activeColor.g, activeColor.b);

const brushPresets = {
  fresco: {
    label: 'Detail Brush',
    brushType: 0,
    size: 0.024,
    water: 0.36,       // wetter → colours flow and merge
    pigment: 0.28,
    flow: 0.48,
    diffusion: 0.30,   // more diffusion → soft bleeding edges
    colorMix: 0.38,    // more mixing where wet meets wet
    edgeStrength: 0.75,
    granulationStrength: 0.90,
    backrunStrength: 1.00,
    retentionStrength: 0.92,
    smoothing: 0.25,
    splatSpread: 0.55,
  },
  rebelle: {
    label: 'Wet Brush',
    brushType: 0,
    size: 0.026,
    water: 0.44,       // very wet → strong flow
    pigment: 0.25,
    flow: 0.52,
    diffusion: 0.36,   // heavy diffusion → colours merge into each other
    colorMix: 0.48,    // strong wet-on-wet mixing
    edgeStrength: 0.85,
    granulationStrength: 1.10,
    backrunStrength: 1.25,  // strong backrun blooms
    retentionStrength: 0.88,
    smoothing: 0.28,
    splatSpread: 0.70,
  },
  wash: {
    label: 'Soft Wash',
    brushType: 0,
    size: 0.038,
    water: 0.56,       // very wet → big flowing washes
    pigment: 0.18,
    flow: 0.55,
    diffusion: 0.42,   // maximum diffusion → colours pool and merge
    colorMix: 0.55,    // strong colour merging
    edgeStrength: 0.70,
    granulationStrength: 0.75,
    backrunStrength: 1.30,  // blooms where colours meet
    retentionStrength: 0.82,
    smoothing: 0.36,
    splatSpread: 0.90,
  },
  dry: {
    label: 'Dry Texture',
    brushType: 1,
    size: 0.020,
    water: 0.14,
    pigment: 0.35,
    flow: 0.30,
    diffusion: 0.12,
    colorMix: 0.15,
    edgeStrength: 0.90,
    granulationStrength: 1.30,  // heavy grain → textured dry brush marks
    backrunStrength: 0.65,
    retentionStrength: 1.05,
    smoothing: 0.18,
    splatSpread: 0.50,
  },
  splash: {
    label: 'Wet Splatter',
    brushType: 2,
    size: 0.028,
    water: 0.48,       // very wet → splatter flows
    pigment: 0.30,
    flow: 0.54,
    diffusion: 0.34,
    colorMix: 0.50,
    edgeStrength: 0.80,
    granulationStrength: 0.85,
    backrunStrength: 1.35,
    retentionStrength: 0.85,
    smoothing: 0.30,
    splatSpread: 1.40,
  },
};

let activePresetKey = 'fresco';
const brushState = { ...brushPresets[activePresetKey] };

let brushSize   = brushState.size;
let waterAmount = brushState.water;
let lastUV      = null;
let lastSurface = null;
let lastPaintPoint = null;
let lastPaintTs = performance.now();
let wasPainting = false;

// ── Idle hint: "Take a breath" after 5 s of no painting ─────────────────────
let _idleTimer = null
const IDLE_HINT_DELAY = 5000   // ms

function _resetIdleTimer() {
  clearTimeout(_idleTimer)
  _idleTimer = setTimeout(() => {
    flashHint('✦  Take a breath…')
  }, IDLE_HINT_DELAY)
}
function _cancelIdleTimer() {
  clearTimeout(_idleTimer)
}

function to2(v) { return Number(v).toFixed(2); }

function resetStrokeState() {
  lastUV = null;
  lastSurface = null;
  lastPaintPoint = null;
  lastPaintTs = performance.now();
}

function applyPreset(key) {
  if (!brushPresets[key]) return;
  activePresetKey = key;
  Object.assign(brushState, brushPresets[key]);
}

// ── God Mode binding ──────────────────────────────────────────────────────────
const godDefaults = {
  size: 0.018, pigment: 0.30, splat: 0.55,
  wetness: 0.40, diffusion: 0.30, mix: 0.30, gravity: 0.05,
  wetwindow: 1.50, evap: 0.60, edge: 0.10, grain: 1.00, backrun: 1.00,
  borderblur: 0.15,
};

function applyGodMode() {
  const v = {};
  for (const [k, el] of Object.entries(gmSliders)) {
    v[k] = el ? parseFloat(el.value) : godDefaults[k];
  }

  // Brush mode (select, not range slider)
  if (gmBrushType) brushState.brushType = parseInt(gmBrushType.value, 10);

  // Brush geometry
  brushState.size     = v.size;
  brushState.pigment  = v.pigment;
  brushState.splatSpread = v.splat;

  // Flow
  brushState.diffusion = v.diffusion;
  brushState.colorMix  = v.mix;

  // Simulation engine
  gpgpu.backgroundWetness = v.wetness;
  gpgpu.wetDuration        = v.wetwindow;
  gpgpu.evaporationRate    = v.evap;

  // Gravity — negative Y is downward
  gpgpu.velUniforms.u_gravity.value.y = -v.gravity;

  // Shader multipliers
  brushState.edgeStrength        = v.edge;
  brushState.granulationStrength = v.grain;
  brushState.backrunStrength     = v.backrun;

  // Surface uniforms applied directly to all paint meshes
  scene.setPaintUniform('u_borderBlur', v.borderblur);

  // Update display values
  if (gmValues.size)      gmValues.size.textContent      = v.size.toFixed(3);
  if (gmValues.pigment)   gmValues.pigment.textContent   = v.pigment.toFixed(2);
  if (gmValues.splat)     gmValues.splat.textContent     = v.splat.toFixed(2);
  if (gmValues.wetness)   gmValues.wetness.textContent   = v.wetness.toFixed(2);
  if (gmValues.diffusion) gmValues.diffusion.textContent = v.diffusion.toFixed(2);
  if (gmValues.mix)       gmValues.mix.textContent       = v.mix.toFixed(2);
  if (gmValues.gravity)   gmValues.gravity.textContent   = v.gravity.toFixed(2);
  if (gmValues.wetwindow) gmValues.wetwindow.textContent = v.wetwindow.toFixed(2) + 's';
  if (gmValues.evap)      gmValues.evap.textContent      = v.evap.toFixed(2) + 'x';
  if (gmValues.edge)      gmValues.edge.textContent      = v.edge.toFixed(2);
  if (gmValues.grain)     gmValues.grain.textContent     = v.grain.toFixed(2);
  if (gmValues.backrun)    gmValues.backrun.textContent    = v.backrun.toFixed(2);
  if (gmValues.borderblur) gmValues.borderblur.textContent = v.borderblur.toFixed(2);
}

function bindGodMode() {
  if (!godModeToggle || !godModePanel) return;

  godModeToggle.addEventListener('click', () => {
    godModePanel.classList.toggle('is-collapsed');
  });

  // Wire each slider
  for (const el of Object.values(gmSliders)) {
    el?.addEventListener('input', applyGodMode);
  }
  // Brush mode select
  gmBrushType?.addEventListener('change', applyGodMode);

  // Reset button
  document.getElementById('gm-reset')?.addEventListener('click', () => {
    for (const [k, el] of Object.entries(gmSliders)) {
      if (el) el.value = String(godDefaults[k]);
    }
    if (gmBrushType) gmBrushType.value = '0';  // default: Round
    applyGodMode();
    flashHint('God Mode reset ↺');
  });

  // Keyboard shortcut: G key toggles God Mode
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'g') {
      godModePanel.classList.toggle('is-collapsed');
    }
  });

  applyGodMode(); // apply defaults on init
}

bindGodMode();

// ── Auto-drip ─────────────────────────────────────────────────────────────────
let handStillTimer = 0;
const BASE_GRAVITY = -0.05;
const DRIP_GRAVITY = -0.24;

// ── Firework burst emitter ────────────────────────────────────────────────────
let burstActive = false;
let burstTimer  = 0;
let burstUV     = null;
let burstColor  = null;
const BURST_DURATION = 0.50;

function triggerBurst(u, v, color) {
  burstActive = true;
  burstTimer  = BURST_DURATION;
  burstUV     = { u, v };
  burstColor  = color.clone();
  // Immediate large splatter at pickup point
  gpgpu.paint(u, v, {
    color:        burstColor,
    pigmentLoad:  1.0,
    waterAmount:  0.65,
    brushSize:    0.13,
    brushType:    2,
    screenAspect: 1.0,
    wetCanvas:    true,
  });
}

// ── Web Audio "pop" synthesiser ───────────────────────────────────────────────
let _audioCtx = null;
function _getAudio() {
  if (!_audioCtx) {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return _audioCtx;
}

function playColorPop() {
  try {
    const ctx  = _getAudio();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    // Pitch drops from 880 → 300 Hz in 120 ms — soft paint-blob "plop"
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(300, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.26, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.20);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.20);
  } catch (_) {}
}

function playWaveSound() {
  try {
    const ctx  = _getAudio();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    // Descending whoosh: 440 → 180 Hz over 0.55 s
    osc.frequency.setValueAtTime(440, ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(180, ctx.currentTime + 0.55);
    gain.gain.setValueAtTime(0.22, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.60);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.60);
  } catch (_) {}
}

// ── Haptic helper ─────────────────────────────────────────────────────────────
function haptic(pattern = [30]) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

// ── Water cursor helper (replaces old updateFingerCursor) ────────────────────
function moveCursor(normX, normY, active) {
  waterCursor.setPosition(normX, normY);
  waterCursor.setActive(active);
  waterCursor.setSize(brushSize);
  waterCursor.show();
}

// ── Kiosk WebSocket receiver  (auto-reconnecting) ─────────────────────────────
const arWelcome = document.getElementById('ar-welcome');
const arEnd     = document.getElementById('ar-end');

const _wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
let _kioskWs         = null;
let _kioskWsTimer    = null;

// Extracted as a named function so it can be re-attached on every reconnect
function _onArWsMessage({ data: raw }) {
  let data;
  try { data = JSON.parse(raw); } catch { return; }

  switch (data.type) {

    case 'start':
      if (arWelcome) { arWelcome.classList.add('hidden'); setTimeout(() => { arWelcome.style.display = 'none'; }, 650); }
      if (arEnd)     { arEnd.style.display = 'none'; arEnd.classList.add('hidden'); }
      break;

    case 'color': {
      const { r, g, b } = data;
      activeColor = new THREE.Color(r, g, b);
      waterCursor.setColor(r, g, b);
      playColorPop();
      break;
    }

    case 'water':
      brushState.water = THREE.MathUtils.clamp(data.value, 0.08, 0.90);
      break;

    case 'brushSize':
      brushState.size = THREE.MathUtils.clamp(data.value, 0.003, 0.090);
      break;

    case 'brushType':
      brushState.brushType = data.value;
      if (gmBrushType) gmBrushType.value = String(data.value);
      break;

    case 'preset':
      applyPreset(data.key);
      flashHint(`${brushState.label ?? data.key} ✦`);
      break;

    case 'end':
      if (arEnd) { arEnd.style.display = 'flex'; requestAnimationFrame(() => arEnd.classList.remove('hidden')); }
      break;

    // ── Snapshot: capture canvas → save to server → relay artwork URL back ────
    case 'snapshot': {
      const artistName = data.artistName ?? ''
      // toDataURL works because preserveDrawingBuffer: true is set on the renderer
      const imageData = renderer.domElement.toDataURL('image/png')
      fetch('/api/save-artwork', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ imageData, artistName }),
      })
        .then(r => r.json())
        .then(({ id, url }) => {
          const origin    = `${location.protocol}//${location.host}`
          const imageUrl  = `${origin}${url}`
          const viewerUrl = `${origin}/Spatiality/artwork.html?id=${id}`
          // Relay back to the kiosk so it can show the frame + generate QR
          if (_kioskWs && _kioskWs.readyState === WebSocket.OPEN) {
            _kioskWs.send(JSON.stringify({ type: 'artwork', id, imageUrl, viewerUrl, artistName }))
          }
          console.info(`[AR] Artwork saved → ${imageUrl}`)
        })
        .catch(e => console.error('[AR] Snapshot save failed:', e))
      break
    }

    // ── 4-wall sync: apply stroke from the primary (hand-tracked) display ─────
    case 'wallStroke': {
      if (!_isWallView) break
      const { points, opts: o } = data
      const strokeColor = new THREE.Color(o.colorR, o.colorG, o.colorB)
      const strokeOpts = {
        color: strokeColor, waterAmount: o.waterAmount, pigmentLoad: o.pigmentLoad,
        brushSize: o.brushSize, brushType: o.brushType, flowVelocity: o.flowVelocity,
        diffusionRate: o.diffusionRate, colorMix: o.colorMix,
        edgeStrength: o.edgeStrength, granulationStrength: o.granulationStrength,
        backrunStrength: o.backrunStrength, retentionStrength: o.retentionStrength,
        wetCanvas: true,
      }
      gpgpu.notifyStroke()
      for (const { u, v } of points) gpgpu.paint(u, v, strokeOpts)
      break
    }

    // ── 4-wall sync: clear ────────────────────────────────────────────────────
    case 'wallClear':
      if (_isWallView) gpgpu.clear()
      break

    // ── Reset: new visitor — clear canvas + return AR to welcome ──────────────
    case 'reset':
      resetStrokeState()
      gpgpu.clear()
      if (arEnd)     { arEnd.classList.add('hidden'); setTimeout(() => { arEnd.style.display = 'none'; }, 650) }
      if (arWelcome) { arWelcome.style.display = 'flex'; requestAnimationFrame(() => arWelcome.classList.remove('hidden')) }
      if (!_isWallView && _kioskWs && _kioskWs.readyState === WebSocket.OPEN) {
        _kioskWs.send(JSON.stringify({ type: 'wallClear' }))
      }
      break

    // ── Clear: wipe canvas only (Paint Again — no overlay change) ─────────────
    case 'clear':
      resetStrokeState()
      gpgpu.clear()
      if (!_isWallView && _kioskWs && _kioskWs.readyState === WebSocket.OPEN) {
        _kioskWs.send(JSON.stringify({ type: 'wallClear' }))
      }
      break
  }
}

function _connectArWS() {
  clearTimeout(_kioskWsTimer)
  _kioskWs = new WebSocket(`${_wsProto}://${location.host}/kiosk-ws`)
  _kioskWs.addEventListener('open',    () => console.log('[AR] WS connected'))
  _kioskWs.addEventListener('error',   e  => console.warn('[AR] WS error', e))
  _kioskWs.addEventListener('close',   () => {
    console.warn('[AR] WS closed — reconnecting in 2 s…')
    _kioskWsTimer = setTimeout(_connectArWS, 2000)
  })
  _kioskWs.addEventListener('message', _onArWsMessage)
}

_connectArWS();

// ── Core paint dispatch ───────────────────────────────────────────────────────
function doPaint(normX, normY, input = {}) {
  const now = input.time ?? performance.now();
  const pressure = THREE.MathUtils.clamp(input.pressure ?? 0.58, 0.08, 1.0);
  const smoothing = THREE.MathUtils.clamp(input.smoothing ?? brushState.smoothing, 0.0, 0.90);

  let paintX = normX;
  let paintY = normY;
  if (lastPaintPoint) {
    const lerpT = 1.0 - smoothing;
    paintX = THREE.MathUtils.lerp(lastPaintPoint.x, normX, lerpT);
    paintY = THREE.MathUtils.lerp(lastPaintPoint.y, normY, lerpT);
  }

  const prevPoint = lastPaintPoint ?? { x: paintX, y: paintY };
  const dtSec = Math.max(1 / 240, (now - lastPaintTs) / 1000);
  const speed = Math.hypot(paintX - prevPoint.x, paintY - prevPoint.y) / dtSec;

  lastPaintPoint = { x: paintX, y: paintY };
  lastPaintTs = now;

  // Raycast onto paintable walls / floor
  const hit = scene.getHitUV(paintX, paintY);
  if (!hit) {
    resetStrokeState();
    return;
  }

  // Keep screenAspect so brush appears circular on this surface
  gpgpu.uniforms.u_screenAspect.value = hit.surfaceAspect;

  const speedNorm = THREE.MathUtils.clamp(speed / 1.8, 0.0, 1.0);
  const holdNorm = 1.0 - speedNorm;
  const pressureFactor = 0.72 + pressure * 0.58;

  const dynamicSize = THREE.MathUtils.clamp(
    brushState.size * (0.68 + pressure * 0.34) * (1.0 - speedNorm * 0.08),
    0.003,   // allow very fine strokes
    0.090
  );
  const dynamicWater = THREE.MathUtils.clamp(
    brushState.water * (0.64 + pressure * 0.22) + holdNorm * 0.02,
    0.06,
    0.64
  );
  const dynamicPigment = THREE.MathUtils.clamp(
    brushState.pigment * pressureFactor * (0.42 + speedNorm * 0.40),
    0.08,
    0.56
  );
  const dynamicFlow = THREE.MathUtils.clamp(
    brushState.flow * (0.82 + speedNorm * 0.20),
    0.12,
    0.85
  );
  const dynamicDiffusion = THREE.MathUtils.clamp(
    brushState.diffusion * (0.46 + dynamicWater * 0.18),
    0.05,
    0.46
  );
  const dynamicMix = THREE.MathUtils.clamp(
    brushState.colorMix * (0.70 + dynamicWater * 0.55),
    0.0,
    0.85
  );
  const dynamicEdgeStrength = THREE.MathUtils.clamp(
    (brushState.edgeStrength ?? 1.0) * (0.90 + (1.0 - dynamicWater) * 0.28),
    0.55,
    1.45
  );
  const dynamicGranulation = THREE.MathUtils.clamp(
    (brushState.granulationStrength ?? 1.0) * (0.84 + (1.0 - dynamicWater) * 0.32),
    0.50,
    1.55
  );
  const dynamicBackrun = THREE.MathUtils.clamp(
    (brushState.backrunStrength ?? 1.0) * (0.74 + dynamicWater * 0.50),
    0.45,
    1.45
  );
  const dynamicRetention = THREE.MathUtils.clamp(
    (brushState.retentionStrength ?? 1.0) * (0.92 + dynamicWater * 0.16),
    0.70,
    1.30
  );

  brushSize = dynamicSize;
  waterAmount = dynamicWater;

  gpgpu.uniforms.u_waterLoad.value = dynamicWater;
  gpgpu.uniforms.u_flowVelocity.value = dynamicFlow;
  gpgpu.uniforms.u_diffusionRate.value = dynamicDiffusion;
  gpgpu.uniforms.u_colorMix.value = dynamicMix;
  gpgpu.uniforms.u_edgeStrength.value = dynamicEdgeStrength;
  gpgpu.uniforms.u_granulationStrength.value = dynamicGranulation;
  gpgpu.uniforms.u_backrunStrength.value = dynamicBackrun;
  gpgpu.uniforms.u_retentionStrength.value = dynamicRetention;
  gpgpu.uniforms.u_splatSpread.value = brushState.splatSpread ?? 0.55;

  const opts = {
    color: activeColor,
    waterAmount: dynamicWater,
    pigmentLoad: dynamicPigment,
    brushSize: dynamicSize,
    brushType: brushState.brushType,
    flowVelocity: dynamicFlow,
    diffusionRate: dynamicDiffusion,
    colorMix: dynamicMix,
    edgeStrength: dynamicEdgeStrength,
    granulationStrength: dynamicGranulation,
    backrunStrength: dynamicBackrun,
    retentionStrength: dynamicRetention,
    wetCanvas: true,
  };

  // Notify drying engine: this frame has a live stroke — resets global clock
  gpgpu.notifyStroke();

  // ── Collect interpolated UV points for this stroke segment ─────────────────
  const strokePoints = []   // [{ u, v }] — sent to other wall instances

  if (lastUV && lastSurface === hit.surfaceId) {
    const dist = Math.hypot(hit.u - lastUV.u, hit.v - lastUV.v);
    const stepsNeeded = dist < 0.001 ? 1 : Math.ceil(dist / (dynamicSize * 0.40));
    const steps = THREE.MathUtils.clamp(stepsNeeded, 1, 20);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const u = lastUV.u + (hit.u - lastUV.u) * t
      const v = lastUV.v + (hit.v - lastUV.v) * t
      gpgpu.paint(u, v, opts);
      strokePoints.push({ u, v })
    }
  } else {
    gpgpu.paint(hit.u, hit.v, opts);
    strokePoints.push({ u: hit.u, v: hit.v })
  }

  // ── Broadcast stroke to all other wall displays via WebSocket ───────────────
  // Secondary wall instances receive this and apply the same paint to their
  // local GPGPU so all 4 walls stay perfectly in sync.
  if (!_isWallView && _kioskWs && _kioskWs.readyState === WebSocket.OPEN) {
    _kioskWs.send(JSON.stringify({
      type:       'wallStroke',
      surfaceId:  hit.surfaceId,
      points:     strokePoints,
      opts: {
        waterAmount:         opts.waterAmount,
        pigmentLoad:         opts.pigmentLoad,
        brushSize:           opts.brushSize,
        brushType:           opts.brushType,
        flowVelocity:        opts.flowVelocity,
        diffusionRate:       opts.diffusionRate,
        colorMix:            opts.colorMix,
        edgeStrength:        opts.edgeStrength,
        granulationStrength: opts.granulationStrength,
        backrunStrength:     opts.backrunStrength,
        retentionStrength:   opts.retentionStrength,
        wetCanvas:           true,
        // color as plain RGB so it survives JSON
        colorR: activeColor.r,
        colorG: activeColor.g,
        colorB: activeColor.b,
      },
    }))
  }

  lastUV = { u: hit.u, v: hit.v };
  lastSurface = hit.surfaceId;
}

// ── Hint flash ────────────────────────────────────────────────────────────────
const HINT_DEFAULT = '☝️  Point to paint  ·  👍  Hold 3 s to clear ✦'

function flashHint(msg, { force = false } = {}) {
  if (!hintChip) return
  // Never interrupt the user with notifications while they're actively painting.
  // force:true is reserved for clear/reset events that the user intentionally triggered.
  if (wasPainting && !force) return
  hintChip.textContent = msg
  clearTimeout(flashHint._t)
  flashHint._t = setTimeout(() => { hintChip.textContent = HINT_DEFAULT }, 2200)
}

// ── Mouse / touch fallback ────────────────────────────────────────────────────
let mouseDown = false;
let activePointerId = null;

function getPointerPressure(e) {
  if (e.pointerType === 'pen') {
    return THREE.MathUtils.clamp(e.pressure || 0.55, 0.08, 1.0);
  }
  if (e.pointerType === 'touch') {
    return THREE.MathUtils.clamp(e.pressure || 0.65, 0.12, 1.0);
  }
  return e.buttons ? 0.55 : 0.0;
}

canvas.addEventListener('pointerdown', e => {
  if (activePointerId !== null && activePointerId !== e.pointerId) return;
  activePointerId = e.pointerId;
  mouseDown = true;
  resetStrokeState();
  _cancelIdleTimer()   // mouse/touch paint started — cancel idle hint
  try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  doPaint(
    e.clientX / window.innerWidth,
    e.clientY / window.innerHeight,
    { pressure: getPointerPressure(e), time: performance.now() }
  );
});
canvas.addEventListener('pointermove', e => {
  if (activePointerId !== null && e.pointerId !== activePointerId) return;
  if (!mouseDown) return;
  const nx = e.clientX / window.innerWidth;
  const ny = e.clientY / window.innerHeight;
  moveCursor(nx, ny, true);
  doPaint(nx, ny, { pressure: getPointerPressure(e), time: performance.now() });
});
canvas.addEventListener('pointerup', e => {
  if (activePointerId !== null && e.pointerId !== activePointerId) return;
  mouseDown = false;
  activePointerId = null;
  resetStrokeState();
  _resetIdleTimer()    // mouse/touch lifted — start 5 s idle countdown
  waterCursor.hide();
});
canvas.addEventListener('pointercancel', e => {
  if (activePointerId !== null && e.pointerId !== activePointerId) return;
  mouseDown = false;
  activePointerId = null;
  resetStrokeState();
  _resetIdleTimer()
  waterCursor.hide();
});
canvas.addEventListener('pointerleave', e => {
  if (activePointerId !== null && e.pointerId !== activePointerId) return;
  mouseDown = false;
  activePointerId = null;
  resetStrokeState();
  _resetIdleTimer()
  waterCursor.hide();
});

// ── Scroll zoom ───────────────────────────────────────────────────────────────
let camZ = 10.0;
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  camZ = THREE.MathUtils.clamp(camZ + e.deltaY * 0.015, 3.0, 18.0);
}, { passive: false });

// ── IMU gravity — phone tilt drives paint drip ────────────────────────────────
const imuGravity = gpgpu.velUniforms.u_gravity.value;
function handleOrientation(e) {
  const roll  = ((e.gamma || 0) * Math.PI) / 180;
  const pitch = ((e.beta  || 0) * Math.PI) / 180;
  imuGravity.x =  Math.sin(roll)  * 0.45;
  imuGravity.y = -Math.sin(pitch) * 0.45;
}
if (window.DeviceOrientationEvent) {
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    document.addEventListener('pointerup', () => {
      DeviceOrientationEvent.requestPermission()
        .then(s => { if (s === 'granted') window.addEventListener('deviceorientation', handleOrientation); })
        .catch(() => {});
    }, { once: true });
  } else {
    window.addEventListener('deviceorientation', handleOrientation, { passive: true });
  }
}

// ── Tracker callbacks ─────────────────────────────────────────────────────────
tracker.onClear = () => {
  resetStrokeState();
  _cancelIdleTimer()   // clearing counts as interaction — reset idle hint
  // Stage 1: ripple wave animation from UV center
  gpgpu.triggerRipple(0.5, 0.5);
  playWaveSound();
  haptic([60, 40, 60]);
  flashHint('👍 Clearing…', { force: true });
  // Stage 2: clear all buffers after ripple finishes (~650 ms)
  setTimeout(() => {
    gpgpu.clear();
    flashHint('Canvas cleared! ✨', { force: true });
    // Tell all wall projectors to clear too
    if (_kioskWs && _kioskWs.readyState === WebSocket.OPEN) {
      _kioskWs.send(JSON.stringify({ type: 'wallClear' }))
    }
  }, 660);
};

// ── Animation loop ────────────────────────────────────────────────────────────
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);

  const dt      = clock.getDelta();
  const elapsed = clock.getElapsedTime();

  scene.camera.position.z += (camZ - scene.camera.position.z) * 0.08;
  scene.updateBuckets(elapsed);

  tracker.update(dt);

  if (tracker.ready) {
    const { isPainting, isMoving, indexTip, brushDepth } = tracker;

    // Hand depth still influences brush response, layered on top of preset values.
    brushSize = THREE.MathUtils.clamp(
      brushState.size * (0.70 + brushDepth * 0.95),
      0.003,
      0.11
    );
    waterAmount = THREE.MathUtils.clamp(
      brushState.water * (0.75 + (1.0 - brushDepth) * 0.55),
      0.08,
      0.92
    );
    gpgpu.uniforms.u_waterLoad.value = waterAmount;

    if (isPainting) {
      moveCursor(indexTip.x, indexTip.y, true);
      if (!wasPainting) {
        resetStrokeState();
        _cancelIdleTimer()   // user started painting — cancel idle hint
      }
      doPaint(indexTip.x, indexTip.y, {
        pressure: THREE.MathUtils.clamp(0.48 + brushDepth * 0.52, 0.08, 1.0),
        smoothing: Math.min(0.90, brushState.smoothing + 0.08),
        time: performance.now(),
      });

      // Auto-drip: ramp gravity when hand is stationary on wet paint
      if (!isMoving) {
        handStillTimer += dt;
        if (handStillTimer > 0.9) {
          gpgpu.velUniforms.u_gravity.value.y = DRIP_GRAVITY;
        }
      } else {
        handStillTimer = 0;
        gpgpu.velUniforms.u_gravity.value.y = BASE_GRAVITY;
      }
    } else {
      if (wasPainting) {
        resetStrokeState();
        _resetIdleTimer()    // user stopped painting — start 5 s idle countdown
      }
      handStillTimer = 0;
      gpgpu.velUniforms.u_gravity.value.y = BASE_GRAVITY;
      if (!mouseDown) waterCursor.hide();
    }
    wasPainting = isPainting;
  } else {
    if (!mouseDown) waterCursor.hide();
  }

  // ── Burst animation (firework spiral) ──────────────────────────────────────
  if (burstActive && burstTimer > 0) {
    burstTimer -= dt;
    const t      = 1 - (burstTimer / BURST_DURATION);
    const angle  = t * Math.PI * 9;
    const radius = t * 0.08;
    gpgpu.notifyStroke();  // burst counts as active painting — keep wet
    gpgpu.paint(
      burstUV.u + Math.cos(angle) * radius,
      burstUV.v + Math.sin(angle) * radius,
      {
        color:        burstColor,
        pigmentLoad:  0.90 * (1 - t * 0.65),
        waterAmount:  0.45,
        brushSize:    0.028 + t * 0.022,
        brushType:    2,
        screenAspect: 1.0,
      }
    );
    if (burstTimer <= 0) burstActive = false;
  }

  gpgpu.update(dt, elapsed);
  scene.updatePaintTexture(dt);
  scene.render();
  relay.onAfterRender?.()  // MadMapper: capture frame right after composer flush
}

animate();

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
});
