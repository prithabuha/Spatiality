/**
 * HandTracker — Kid-friendly MediaPipe Hand Landmarker
 *
 * ── Interaction model ─────────────────────────────────────────────────────────
 *   INDEX EXTENDED   → isPainting = true  (no pinch required)
 *   OPEN (hold 1.2s) → single-hand clear
 *   TWO-HAND WAVE    → onClear() triggered (both hands move fast for 0.4 s)
 *
 * ── Published state ───────────────────────────────────────────────────────────
 *   tracker.indexTip     { x, y }  — normalised screen position (0..1)
 *   tracker.isPainting   boolean   — index finger extended
 *   tracker.isMoving     boolean   — hand velocity above threshold
 *   tracker.brushDepth   number    — 0 (far) → 1 (close to camera)  → brush size
 *   tracker.ready        boolean
 *
 * ── Callbacks ─────────────────────────────────────────────────────────────────
 *   tracker.onClear = () => {}
 */

export class HandTracker {
  constructor(videoEl, overlayCanvasEl, opts = {}) {
    this.video   = videoEl;
    this.overlay = overlayCanvasEl;
    this.ctx     = overlayCanvasEl.getContext('2d');

    this.moveThreshold  = opts.moveThreshold ?? 0.006;
    this._clearDuration = 1.2;

    // Published state
    this.indexTip      = { x: 0.5, y: 0.5 };
    this.thumbTip      = { x: 0.5, y: 0.5 };
    this.isPainting    = false;
    this.isMoving      = false;
    this.brushDepth    = 0.5;   // 0=far, 1=close
    this.ready         = false;
    this.numHands      = 0;     // how many hands currently detected

    // Callback
    this.onClear = null;

    // Internal
    this._landmarker     = null;
    this._lastVideoTime  = -1;
    this._posHistory     = [];
    this._historySize    = 6;

    // Single-hand OPEN clear
    this._openTimer = 0;

    // Two-hand wave detection
    this._prevWristX  = [null, null];
    this._waveTimer   = 0;
    this._waveCooldown = 0;
    this._waveFlash   = 0;    // >0 → draw wave indicator

    this._overlayWidth  = 0;
    this._overlayHeight = 0;
    this._syncOverlaySize = this._syncOverlaySize.bind(this);
    window.addEventListener('resize', this._syncOverlaySize, { passive: true });
    this._syncOverlaySize();

    this._init();
  }

  _syncOverlaySize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w === this._overlayWidth && h === this._overlayHeight) return;
    this.overlay.width  = w;
    this.overlay.height = h;
    this._overlayWidth  = w;
    this._overlayHeight = h;
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  async _init() {
    try {
      const { HandLandmarker, FilesetResolver } =
        await import('@mediapipe/tasks-vision');
      const vision = await FilesetResolver.forVisionTasks('/wasm');
      this._landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: '/models/hand_landmarker.task',
          delegate: 'GPU',
        },
        numHands:    2,         // track two hands for wave-clear
        runningMode: 'VIDEO',
      });
      await this._startCamera();
      this.ready = true;
      // Hide camera prompt if visible
      const prompt = document.getElementById('camera-prompt');
      if (prompt) prompt.style.display = 'none';
      const chip = document.getElementById('hint-chip');
      if (chip) chip.textContent = 'Point finger to paint · Wave both hands to clear ✦';
    } catch (err) {
      console.error('HandTracker init error:', err);
      this._showCameraError(err);
    }
  }

  _showCameraError(err) {
    const isPermission = err && (
      err.name === 'NotAllowedError' ||
      err.name === 'PermissionDeniedError' ||
      (err.message && err.message.includes('Permission'))
    );
    const isNoCamera = err && (
      err.name === 'NotFoundError' ||
      err.name === 'DevicesNotFoundError'
    );

    const chip = document.getElementById('hint-chip');
    if (chip) chip.textContent = '🎥 Camera blocked — follow the steps below';

    if (isNoCamera) {
      if (chip) chip.textContent = '📷 No camera found — use mouse to paint';
      this._showCameraPrompt('nocamera');
    } else {
      // Permission denied (or unknown) — show Chrome fix steps
      this._showCameraPrompt('blocked');
    }
  }

  _showCameraPrompt(type) {
    let prompt = document.getElementById('camera-prompt');
    if (!prompt) {
      prompt = document.createElement('div');
      prompt.id = 'camera-prompt';
      prompt.style.cssText = `
        position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
        background:#fffbf2; border:2px solid rgba(200,140,40,0.4);
        border-radius:20px; padding:28px 32px; z-index:100;
        text-align:center; font-family:'Segoe UI',system-ui,sans-serif;
        box-shadow:0 20px 60px rgba(0,0,0,0.18); width:360px;
      `;
      document.body.appendChild(prompt);
    }

    const blockedHTML = `
      <div style="font-size:42px;margin-bottom:8px">🔒</div>
      <h2 style="color:#a05010;margin:0 0 6px;font-size:17px;font-weight:700">
        Camera is Blocked in Chrome
      </h2>
      <p style="color:#999;font-size:12px;margin:0 0 18px;line-height:1.5">
        Chrome blocked the camera. Fix it in 3 steps:
      </p>

      <div style="text-align:left;background:#fff8ee;border-radius:12px;padding:14px 16px;margin-bottom:18px;font-size:13px;line-height:2">
        <div><b style="color:#ff8c00">Step 1</b> — Look at the address bar above</div>
        <div><b style="color:#ff8c00">Step 2</b> — Click the 🔒 or 📷 icon on the left of the URL</div>
        <div><b style="color:#ff8c00">Step 3</b> — Set <b>Camera</b> to <b style="color:green">Allow</b></div>
      </div>

      <button id="cam-retry-btn" style="
        background:#22c55e;color:#fff;border:none;border-radius:12px;
        padding:12px 0;font-size:14px;font-weight:700;cursor:pointer;
        width:100%;margin-bottom:10px;
        box-shadow:0 4px 14px rgba(34,197,94,0.35);
      ">✅ I allowed it — start camera</button>

      <button id="cam-skip-btn" style="
        background:transparent;color:#bbb;border:1px solid #e0e0e0;
        border-radius:12px;padding:9px 0;font-size:13px;cursor:pointer;width:100%;
      ">Use mouse to paint instead</button>
    `;

    const noCameraHTML = `
      <div style="font-size:42px;margin-bottom:8px">📷</div>
      <h2 style="color:#a05010;margin:0 0 10px;font-size:17px">No Camera Found</h2>
      <p style="color:#999;font-size:13px;margin:0 0 18px;line-height:1.5">
        No webcam detected.<br>You can still paint using mouse click-drag.
      </p>
      <button id="cam-retry-btn" style="
        background:#ff8c00;color:#fff;border:none;border-radius:12px;
        padding:12px 0;font-size:14px;font-weight:700;cursor:pointer;width:100%;margin-bottom:10px;
      ">🔄 Try Again</button>
      <button id="cam-skip-btn" style="
        background:transparent;color:#bbb;border:1px solid #e0e0e0;
        border-radius:12px;padding:9px 0;font-size:13px;cursor:pointer;width:100%;
      ">Continue with mouse</button>
    `;

    prompt.innerHTML = type === 'nocamera' ? noCameraHTML : blockedHTML;
    prompt.style.display = 'block';

    // Retry: only re-request camera — MediaPipe is already loaded
    document.getElementById('cam-retry-btn')?.addEventListener('click', async () => {
      prompt.style.display = 'none';
      const chip = document.getElementById('hint-chip');
      if (chip) chip.textContent = 'Starting camera…';
      try {
        await this._startCamera();
        this.ready = true;
        if (chip) chip.textContent = 'Point finger to paint · Wave both hands to clear ✦';
      } catch (err) {
        console.error('Camera retry failed:', err);
        this._showCameraError(err);
      }
    });

    // Skip: dismiss and use mouse
    document.getElementById('cam-skip-btn')?.addEventListener('click', () => {
      prompt.style.display = 'none';
      const chip = document.getElementById('hint-chip');
      if (chip) chip.textContent = 'Mouse mode — click and drag to paint ✦';
    });
  }

  async _startCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720, facingMode: 'user' },
    });
    this.video.srcObject = stream;
    return new Promise(r => { this.video.onloadeddata = r; });
  }

  // ── Public update ─────────────────────────────────────────────────────────
  update(dt = 0.016) {
    if (!this.ready || !this._landmarker) return;
    if (this.video.readyState < 2)                return;
    if (this.video.currentTime === this._lastVideoTime) return;
    this._lastVideoTime = this.video.currentTime;

    const results = this._landmarker.detectForVideo(this.video, performance.now());

    this._syncOverlaySize();
    this.ctx.clearRect(0, 0, this._overlayWidth, this._overlayHeight);

    this.numHands = results.landmarks?.length ?? 0;

    if (this.numHands >= 2) {
      // Two hands — process primary hand for painting, check for wave
      this._process(results.landmarks[0], dt);
      this._checkWave(results.landmarks[0], results.landmarks[1], dt);
      this._drawSkeleton(results.landmarks[0]);
      this._drawSkeleton(results.landmarks[1]);
      this._drawHUD(results.landmarks[0]);
      this._drawWaveIndicator(dt);
    } else if (this.numHands === 1) {
      this._waveTimer    = 0;
      this._prevWristX   = [null, null];
      this._process(results.landmarks[0], dt);
      this._drawSkeleton(results.landmarks[0]);
      this._drawHUD(results.landmarks[0]);
    } else {
      this._reset();
    }

    // Cooldown tick
    if (this._waveCooldown > 0) this._waveCooldown -= dt;
    if (this._waveFlash   > 0) this._waveFlash   -= dt;
  }

  // ── Core single-hand processing ───────────────────────────────────────────
  _process(lm, dt) {
    this.indexTip = { x: 1 - lm[8].x, y: lm[8].y };
    this.thumbTip = { x: 1 - lm[4].x, y: lm[4].y };

    // Brush depth from Z: negative = closer to camera
    // Typical range: -0.15 (very close) to +0.05 (far away)
    const rawZ = lm[8].z;
    this.brushDepth = Math.max(0, Math.min(1, (-rawZ - 0.02) / 0.12));

    // Movement velocity
    this._posHistory.push({ x: this.indexTip.x, y: this.indexTip.y });
    if (this._posHistory.length > this._historySize) this._posHistory.shift();
    if (this._posHistory.length >= 2) {
      const a = this._posHistory[0];
      const b = this._posHistory[this._posHistory.length - 1];
      this.isMoving = Math.sqrt((b.x-a.x)**2 + (b.y-a.y)**2) > this.moveThreshold;
    }

    // ── Painting = index finger extended (no pinch required) ───────────────
    const ext = this._extended(lm);
    this.isPainting = ext.index;

    // ── OPEN hand: single-hand clear (hold 1.2 s) ──────────────────────────
    const n = [ext.index, ext.middle, ext.ring, ext.pinky].filter(Boolean).length;
    if (n >= 4) {
      this._openTimer += dt;
      if (this._openTimer >= this._clearDuration) {
        this._openTimer = 0;
        if (this.onClear) this.onClear();
      }
    } else {
      this._openTimer = 0;
    }
  }

  // ── Two-hand wave detection ───────────────────────────────────────────────
  // Both wrists must be moving quickly (horizontal velocity > 1.0 normalised/s)
  // for at least 0.4 seconds → onClear()
  _checkWave(lm1, lm2, dt) {
    if (this._waveCooldown > 0) return;

    const w1x = 1 - lm1[0].x;
    const w2x = 1 - lm2[0].x;

    if (this._prevWristX[0] !== null) {
      const v1 = Math.abs((w1x - this._prevWristX[0]) / dt);
      const v2 = Math.abs((w2x - this._prevWristX[1]) / dt);

      if (v1 > 1.0 && v2 > 1.0) {
        this._waveTimer += dt;
        if (this._waveTimer >= 0.4) {
          this._waveTimer    = 0;
          this._waveCooldown = 2.0;   // 2 s before next wave can trigger
          this._waveFlash    = 0.8;
          if (this.onClear) this.onClear();
        }
      } else if (v1 < 0.4 && v2 < 0.4) {
        this._waveTimer = Math.max(0, this._waveTimer - dt * 2);
      }
    }
    this._prevWristX[0] = w1x;
    this._prevWristX[1] = w2x;
  }

  // ── Helper: which fingers are extended ────────────────────────────────────
  _extended(lm) {
    return {
      thumb:  Math.abs(lm[4].x - lm[2].x) > 0.04,
      index:  lm[8].y  < lm[6].y,
      middle: lm[12].y < lm[10].y,
      ring:   lm[16].y < lm[14].y,
      pinky:  lm[20].y < lm[18].y,
    };
  }

  _reset() {
    this.isPainting   = false;
    this.isMoving     = false;
    this.brushDepth   = 0.5;
    this._posHistory  = [];
    this._openTimer   = 0;
    this._prevWristX  = [null, null];
    this._waveTimer   = 0;
  }

  // ── HUD drawing ───────────────────────────────────────────────────────────
  _drawHUD(lm) {
    const ctx = this.ctx;
    const W = this.overlay.width, H = this.overlay.height;
    const px = i => (1 - lm[i].x) * W;
    const py = i => lm[i].y * H;

    // OPEN: clear progress ring
    if (this._openTimer > 0) {
      const prog = this._openTimer / this._clearDuration;
      const cx = W/2, cy = H/2;
      ctx.save();
      ctx.strokeStyle = `rgba(239,100,60,${0.4 + prog * 0.6})`;
      ctx.lineWidth   = 7;
      ctx.lineCap     = 'round';
      ctx.beginPath();
      ctx.arc(cx, cy, 50, -Math.PI/2, -Math.PI/2 + prog * Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = `rgba(239,100,60,${0.6 + prog * 0.4})`;
      ctx.font = 'bold 15px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('CLEAR', cx, cy);
      ctx.restore();
    }

    // Painting cursor — large coloured circle at index tip
    if (this.isPainting) {
      const ix = px(8), iy = py(8);
      const r  = 12 + this.brushDepth * 22;
      ctx.save();
      ctx.beginPath();
      ctx.arc(ix, iy, r, 0, Math.PI * 2);
      ctx.strokeStyle = this.isMoving
        ? 'rgba(255,220,50,0.95)'
        : 'rgba(255,255,255,0.60)';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
    }
  }

  // ── Wave indicator (shown when two-hand wave is in progress) ─────────────
  _drawWaveIndicator(dt) {
    if (this._waveFlash <= 0 && this._waveTimer <= 0) return;
    const ctx = this.ctx;
    const W = this.overlay.width, H = this.overlay.height;

    // Flash on successful wave
    if (this._waveFlash > 0) {
      const alpha = this._waveFlash / 0.8;
      ctx.save();
      ctx.fillStyle = `rgba(255,200,50,${alpha * 0.18})`;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = `rgba(255,200,50,${alpha})`;
      ctx.font = 'bold 48px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🌊 Cleared!', W/2, H/2);
      ctx.restore();
      return;
    }

    // Progress bar for wave
    const prog = this._waveTimer / 0.4;
    ctx.save();
    ctx.fillStyle = `rgba(100,180,255,${0.5 + prog * 0.5})`;
    ctx.font = 'bold 22px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(`🌊 Keep waving…`, W/2, 60);
    ctx.fillStyle = 'rgba(100,180,255,0.25)';
    ctx.fillRect(W/2 - 100, 72, 200, 8);
    ctx.fillStyle = `rgba(100,180,255,${0.6 + prog * 0.4})`;
    ctx.fillRect(W/2 - 100, 72, 200 * prog, 8);
    ctx.restore();
  }

  // ── Skeleton ─────────────────────────────────────────────────────────────
  _drawSkeleton(lm) {
    const ctx = this.ctx;
    const W = this.overlay.width, H = this.overlay.height;
    const px = i => (1 - lm[i].x) * W;
    const py = i => lm[i].y * H;

    const boneCol = this.isPainting && this.isMoving
      ? 'rgba(255,220,50,0.70)'
      : this.isPainting
        ? 'rgba(255,255,255,0.50)'
        : 'rgba(180,200,255,0.35)';

    [[0,1],[1,2],[2,3],[3,4],
     [0,5],[5,6],[6,7],[7,8],
     [0,9],[9,10],[10,11],[11,12],
     [0,13],[13,14],[14,15],[15,16],
     [0,17],[17,18],[18,19],[19,20],
     [5,9],[9,13],[13,17]
    ].forEach(([a, b]) => {
      ctx.strokeStyle = boneCol; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(px(a), py(a)); ctx.lineTo(px(b), py(b)); ctx.stroke();
    });

    ctx.fillStyle = boneCol;
    for (let i = 0; i < 21; i++) {
      if (i === 8) continue;
      ctx.beginPath(); ctx.arc(px(i), py(i), 3, 0, Math.PI * 2); ctx.fill();
    }

    // Index tip — bright beacon
    const tipCol = this.isPainting
      ? (this.isMoving ? '#ffe032' : 'rgba(255,255,255,0.85)')
      : 'rgba(200,220,255,0.6)';
    ctx.fillStyle = tipCol;
    ctx.beginPath();
    ctx.arc(px(8), py(8), this.isPainting ? 11 : 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth   = 2;
    ctx.stroke();
  }
}
