/**
 * HandTracker — MediaPipe Hand Landmarker  +  optional Face Detector
 *
 * ── Interaction model ─────────────────────────────────────────────────────────
 *   INDEX HELD 2 s        → isPainting = true
 *                            (countdown ring shown at finger tip + centered prompt)
 *   BOTH HANDS 3× WAVE    → onClear()  (same person, 3 swipes within 5 s)
 *
 * ── Face detection (non-blocking) ─────────────────────────────────────────────
 *   FaceDetector runs alongside HandLandmarker.
 *   Primary face = largest bounding box (closest/most prominent person).
 *   When multiple faces are visible only hands near the primary face are
 *   accepted for painting — bystanders cannot accidentally paint.
 *   The active artist gets a subtle "✦ Artist" label on the overlay.
 *
 * ── Published state ───────────────────────────────────────────────────────────
 *   tracker.indexTip           { x, y }  — normalised screen position (0..1)
 *   tracker.isPainting         boolean   — index held ≥ 2 s
 *   tracker.paintHoldProgress  0 → 1    — ring fill during 2-second hold
 *   tracker.isMoving           boolean   — hand velocity above threshold
 *   tracker.brushDepth         number    — 0 (far) → 1 (close)  → brush size
 *   tracker.ready              boolean
 *
 * ── Callbacks ─────────────────────────────────────────────────────────────────
 *   tracker.onClear = () => {}
 */

export class HandTracker {
  constructor(videoEl, overlayCanvasEl, opts = {}) {
    this.video   = videoEl;
    this.overlay = overlayCanvasEl;
    this.ctx     = overlayCanvasEl.getContext('2d');

    this.moveThreshold = opts.moveThreshold ?? 0.006;

    // ── Published state ───────────────────────────────────────────────────────
    this.indexTip          = { x: 0.5, y: 0.5 };
    this.thumbTip          = { x: 0.5, y: 0.5 };
    this.isPainting        = false;
    this.paintHoldProgress = 0;   // 0 → 1 over the 2-second hold
    this.isMoving          = false;
    this.brushDepth        = 0.5;
    this.ready             = false;
    this.numHands          = 0;

    // ── Callback ─────────────────────────────────────────────────────────────
    this.onClear = null;

    // ── Internal ──────────────────────────────────────────────────────────────
    this._landmarker    = null;
    this._lastVideoTime = -1;
    this._posHistory    = [];
    this._historySize   = 6;

    // 2-second hold-to-paint
    this._paintHoldTimer    = 0;
    this._paintHoldDuration = 2.0;
    this._paintJustStarted  = false;   // one-frame flag for "start" flash

    // 3-swipe wave-to-clear
    this._prevWristX      = [null, null];
    this._waveSwipeCount  = 0;    // 0 / 1 / 2 → at 3: clear
    this._waveSwipeTimer  = 0;    // elapsed while both wrists moving fast
    this._waveSwipePause  = 0;    // mandatory gap between registered swipes
    this._waveWindowTimer = 0;    // overall 5-second window
    this._waveCooldown    = 0;    // post-clear cooldown
    this._waveFlash       = 0;    // success flash alpha

    // Face detection
    this._faceDetector  = null;
    this._activeFaceBox = null;   // { x, y, w, h } normalised, primary face
    this._lastFaceTime  = -1;     // avoid re-running every frame

    this._overlayWidth  = 0;
    this._overlayHeight = 0;
    this._syncOverlaySize = this._syncOverlaySize.bind(this);
    window.addEventListener('resize', this._syncOverlaySize, { passive: true });
    this._syncOverlaySize();

    this._init();
  }

  _syncOverlaySize() {
    const w = window.innerWidth, h = window.innerHeight;
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
      const base   = import.meta.env.BASE_URL;
      const vision = await FilesetResolver.forVisionTasks(base + 'wasm');

      // Try GPU first, fall back to CPU silently
      let delegate = 'GPU';
      try {
        this._landmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: base + 'models/hand_landmarker.task', delegate },
          numHands: 2, runningMode: 'VIDEO',
        });
      } catch (_gpuErr) {
        delegate = 'CPU';
        this._landmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: base + 'models/hand_landmarker.task', delegate },
          numHands: 2, runningMode: 'VIDEO',
        });
      }

      await this._startCamera();
      this.ready = true;
      const prompt = document.getElementById('camera-prompt');
      if (prompt) prompt.style.display = 'none';
      const chip = document.getElementById('hint-chip');
      if (chip) chip.textContent =
        'Hold index finger 2 s to start · Wave both hands 3× to clear ✦';

      // Face detector loads in background — non-blocking, non-critical
      this._initFaceDetector().catch(e =>
        console.warn('[FaceDetector] not available:', e.message)
      );
    } catch (err) {
      console.error('HandTracker init error:', err);
      this._showCameraError(err);
    }
  }

  // ── Face detector (background load, optional) ────────────────────────────
  async _initFaceDetector() {
    const { FaceDetector, FilesetResolver } = await import('@mediapipe/tasks-vision');
    const base   = import.meta.env.BASE_URL;
    const vision = await FilesetResolver.forVisionTasks(base + 'wasm');
    this._faceDetector = await FaceDetector.createFromOptions(vision, {
      baseOptions: {
        // Official MediaPipe short-range face detection model
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/face_detector/' +
          'blaze_face_short_range/float16/1/blaze_face_short_range.task',
        delegate: 'GPU',
      },
      runningMode:              'VIDEO',
      minDetectionConfidence:   0.50,
      minSuppressionThreshold:  0.30,
    });
    console.log('[FaceDetector] ready');
  }

  // ── Camera ────────────────────────────────────────────────────────────────
  _showCameraError(err) {
    const isPermission = err && (
      err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError' ||
      (err.message && err.message.includes('Permission'))
    );
    const isNoCamera = err && (
      err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError'
    );
    const chip = document.getElementById('hint-chip');
    if (chip) chip.textContent = '🎥 Camera blocked — follow the steps below';
    if (isNoCamera) {
      if (chip) chip.textContent = '📷 No camera found — use mouse to paint';
      this._showCameraPrompt('nocamera');
    } else {
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

    document.getElementById('cam-retry-btn')?.addEventListener('click', async () => {
      prompt.style.display = 'none';
      const chip = document.getElementById('hint-chip');
      if (chip) chip.textContent = 'Starting camera…';
      try {
        await this._startCamera();
        this.ready = true;
        if (chip) chip.textContent =
          'Hold index finger 2 s to start · Wave both hands 3× to clear ✦';
      } catch (err) {
        console.error('Camera retry failed:', err);
        this._showCameraError(err);
      }
    });

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

    const now     = performance.now();
    const results = this._landmarker.detectForVideo(this.video, now);

    this._syncOverlaySize();
    this.ctx.clearRect(0, 0, this._overlayWidth, this._overlayHeight);

    this.numHands = results.landmarks?.length ?? 0;

    // ── Optional face detection (every ~3rd frame to save GPU budget) ─────
    if (this._faceDetector && now - this._lastFaceTime > 50) {
      this._lastFaceTime = now;
      try {
        const fr = this._faceDetector.detectForVideo(this.video, now);
        this._updateActiveFace(fr.detections ?? []);
      } catch (_) { /* ignore */ }
    }

    // Draw detected faces on overlay
    if (this._activeFaceBox) this._drawFaceOverlay();

    if (this.numHands >= 2) {
      this._process(results.landmarks[0], dt);
      this._checkWave(results.landmarks[0], results.landmarks[1], dt);
      this._drawSkeleton(results.landmarks[0]);
      this._drawSkeleton(results.landmarks[1]);
      this._drawHUD(results.landmarks[0]);
      this._drawWaveIndicator(dt);
    } else if (this.numHands === 1) {
      this._waveSwipeTimer = 0;
      this._prevWristX     = [null, null];
      this._process(results.landmarks[0], dt);
      this._drawSkeleton(results.landmarks[0]);
      this._drawHUD(results.landmarks[0]);
    } else {
      this._reset();
    }

    if (this._waveCooldown > 0) this._waveCooldown -= dt;
    if (this._waveFlash   > 0) this._waveFlash   -= dt;
  }

  // ── Update active face from detector results ──────────────────────────────
  _updateActiveFace(detections) {
    if (!detections.length) { this._activeFaceBox = null; return; }

    // Primary face = largest bounding-box area (proxy for "closest to camera")
    let best = null, bestArea = 0;
    for (const d of detections) {
      const bb = d.boundingBox;
      const area = bb.width * bb.height;
      if (area > bestArea) { bestArea = area; best = bb; }
    }
    if (!best) { this._activeFaceBox = null; return; }

    // Normalise to [0,1] — MediaPipe gives pixel coords when runningMode=VIDEO
    const vw = this.video.videoWidth  || 1280;
    const vh = this.video.videoHeight || 720;
    // Mirror X to match the mirrored hand landmarks (1 - x)
    this._activeFaceBox = {
      x: 1 - (best.originX + best.width)  / vw,
      y:     best.originY                  / vh,
      w:     best.width                    / vw,
      h:     best.height                   / vh,
    };
  }

  // ── Core single-hand processing ───────────────────────────────────────────
  _process(lm, dt) {
    this.indexTip = { x: 1 - lm[8].x, y: lm[8].y };
    this.thumbTip = { x: 1 - lm[4].x, y: lm[4].y };

    // Brush depth from Z
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

    // ── Face-based active-user gate ────────────────────────────────────────
    // If face detection is running and found multiple people, only accept the
    // hand whose wrist is in the same horizontal zone as the primary face.
    const wristX = 1 - lm[0].x;
    if (this._activeFaceBox) {
      const fc = this._activeFaceBox.x + this._activeFaceBox.w / 2;
      const fw = this._activeFaceBox.w;
      if (Math.abs(wristX - fc) > fw * 3.0) {
        // This hand is too far from the primary face — ignore it
        this._paintHoldTimer = 0;
        this.isPainting        = false;
        this.paintHoldProgress = 0;
        return;
      }
    }

    // ── 2-second hold to start painting ───────────────────────────────────
    const ext = this._extended(lm);
    if (ext.index) {
      const prev = this._paintHoldTimer;
      this._paintHoldTimer = Math.min(this._paintHoldDuration,
                                      this._paintHoldTimer + dt);
      const wasReady = prev >= this._paintHoldDuration;
      const  isReady = this._paintHoldTimer >= this._paintHoldDuration;
      this._paintJustStarted = isReady && !wasReady;
      this.isPainting        = isReady;
    } else {
      this._paintHoldTimer   = 0;
      this.isPainting        = false;
      this._paintJustStarted = false;
    }
    this.paintHoldProgress = this._paintHoldTimer / this._paintHoldDuration;
  }

  // ── 3-swipe wave-to-clear ─────────────────────────────────────────────────
  // Each "swipe" = both wrists moving fast for 0.2 s, then a 0.3 s pause.
  // 3 swipes within 5 seconds → onClear().
  _checkWave(lm1, lm2, dt) {
    if (this._waveCooldown > 0) return;

    const w1x = 1 - lm1[0].x;
    const w2x = 1 - lm2[0].x;

    if (this._prevWristX[0] !== null) {
      const v1 = Math.abs((w1x - this._prevWristX[0]) / dt);
      const v2 = Math.abs((w2x - this._prevWristX[1]) / dt);
      const bothFast = v1 > 0.9 && v2 > 0.9;

      // Mandatory inter-swipe pause
      if (this._waveSwipePause > 0) {
        this._waveSwipePause -= dt;
      } else if (bothFast) {
        this._waveSwipeTimer += dt;
        if (this._waveSwipeTimer >= 0.20) {
          // Registered one swipe
          this._waveSwipeTimer = 0;
          this._waveSwipePause = 0.30;
          if (this._waveSwipeCount === 0) this._waveWindowTimer = 0;
          this._waveSwipeCount++;

          if (this._waveSwipeCount >= 3) {
            this._waveSwipeCount  = 0;
            this._waveWindowTimer = 0;
            this._waveCooldown    = 2.0;
            this._waveFlash       = 0.8;
            if (this.onClear) this.onClear();
          }
        }
      } else {
        // Not moving fast — decay swipe accumulator
        this._waveSwipeTimer = Math.max(0, this._waveSwipeTimer - dt * 3);
      }

      // Window: 3 swipes must happen within 5 seconds
      if (this._waveSwipeCount > 0) {
        this._waveWindowTimer += dt;
        if (this._waveWindowTimer > 5.0) {
          this._waveSwipeCount  = 0;
          this._waveWindowTimer = 0;
        }
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
    this.isPainting        = false;
    this.paintHoldProgress = 0;
    this.isMoving          = false;
    this.brushDepth        = 0.5;
    this._posHistory       = [];
    this._paintHoldTimer   = 0;
    this._paintJustStarted = false;
    this._prevWristX       = [null, null];
    this._waveSwipeTimer   = 0;
    this._waveSwipeCount   = 0;
    this._waveSwipePause   = 0;
    this._waveWindowTimer  = 0;
  }

  // ── HUD drawing ───────────────────────────────────────────────────────────
  _drawHUD(lm) {
    const ctx = this.ctx;
    const W = this.overlay.width, H = this.overlay.height;
    const px = i => (1 - lm[i].x) * W;
    const py = i => lm[i].y * H;

    const ix = px(8), iy = py(8);

    // ── 2-second hold countdown ────────────────────────────────────────────
    if (!this.isPainting && this.paintHoldProgress > 0) {
      const prog = this.paintHoldProgress;
      const rem  = ((1 - prog) * this._paintHoldDuration).toFixed(1);

      // -- Ring around index finger tip --
      ctx.save();
      ctx.strokeStyle = `rgba(60,180,120,${0.35 + prog * 0.65})`;
      ctx.lineWidth   = 4;
      ctx.lineCap     = 'round';
      ctx.beginPath();
      ctx.arc(ix, iy, 28, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // -- Centered on screen: instruction card --
      const cx = W / 2, cy = H / 2;

      ctx.save();
      // Pill background
      const pw = 320, ph = 110, pr = 22;
      const bx = cx - pw / 2, by = cy - ph / 2;
      ctx.beginPath();
      ctx.moveTo(bx + pr, by);
      ctx.lineTo(bx + pw - pr, by);
      ctx.quadraticCurveTo(bx + pw, by, bx + pw, by + pr);
      ctx.lineTo(bx + pw, by + ph - pr);
      ctx.quadraticCurveTo(bx + pw, by + ph, bx + pw - pr, by + ph);
      ctx.lineTo(bx + pr, by + ph);
      ctx.quadraticCurveTo(bx, by + ph, bx, by + ph - pr);
      ctx.lineTo(bx, by + pr);
      ctx.quadraticCurveTo(bx, by, bx + pr, by);
      ctx.closePath();
      ctx.fillStyle   = 'rgba(240,255,248,0.82)';
      ctx.shadowColor = 'rgba(0,120,60,0.25)';
      ctx.shadowBlur  = 18;
      ctx.fill();
      ctx.shadowBlur  = 0;

      // Progress bar inside pill
      ctx.fillStyle = 'rgba(60,180,120,0.18)';
      ctx.fillRect(bx + 16, by + ph - 14, pw - 32, 6);
      ctx.fillStyle = `rgba(60,180,120,${0.5 + prog * 0.5})`;
      ctx.fillRect(bx + 16, by + ph - 14, (pw - 32) * prog, 6);

      // Text
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = 'rgba(30,100,60,0.92)';
      ctx.font         = 'bold 22px system-ui, sans-serif';
      ctx.fillText('✦  Take a breath…', cx, cy - 18);
      ctx.fillStyle = 'rgba(30,100,60,0.70)';
      ctx.font      = '15px system-ui, sans-serif';
      ctx.fillText('Keep your index finger pointed', cx, cy + 10);
      ctx.fillStyle = 'rgba(30,100,60,0.55)';
      ctx.font      = '13px system-ui, sans-serif';
      ctx.fillText(`Starting in  ${rem} s`, cx, cy + 30);
      ctx.restore();
    }

    // ── Painting cursor ────────────────────────────────────────────────────
    if (this.isPainting) {
      const r = 12 + this.brushDepth * 22;
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

  // ── Wave indicator ────────────────────────────────────────────────────────
  _drawWaveIndicator(dt) {
    const ctx = this.ctx;
    const W = this.overlay.width, H = this.overlay.height;

    // Success flash
    if (this._waveFlash > 0) {
      const alpha = this._waveFlash / 0.8;
      ctx.save();
      ctx.fillStyle = `rgba(255,200,50,${alpha * 0.18})`;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = `rgba(255,200,50,${alpha})`;
      ctx.font = 'bold 48px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🌊 Cleared!', W / 2, H / 2);
      ctx.restore();
      return;
    }

    // In-progress: show swipe dots + current swipe progress bar
    const swipeInProgress = this._waveSwipeTimer > 0 || this._waveSwipeCount > 0;
    if (!swipeInProgress) return;

    const cx = W / 2;
    ctx.save();
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    // Label
    ctx.fillStyle = 'rgba(100,180,255,0.90)';
    ctx.font      = 'bold 20px system-ui';
    ctx.fillText('🌊  Wave to clear  —  keep going!', cx, 46);

    // Dots  ● ● ●  filled as swipes are registered
    const dotR = 10, dotGap = 32, dotsY = 76;
    for (let i = 0; i < 3; i++) {
      const dx = cx + (i - 1) * dotGap;
      ctx.beginPath();
      ctx.arc(dx, dotsY, dotR, 0, Math.PI * 2);
      if (i < this._waveSwipeCount) {
        ctx.fillStyle = 'rgba(100,200,255,0.95)';
        ctx.fill();
      } else {
        ctx.strokeStyle = 'rgba(100,200,255,0.50)';
        ctx.lineWidth   = 2;
        ctx.stroke();
      }
    }

    // Current swipe progress arc (inside the next dot to fill)
    const nextDot = this._waveSwipeCount;
    if (nextDot < 3 && this._waveSwipeTimer > 0) {
      const prog = this._waveSwipeTimer / 0.20;
      const dx   = cx + (nextDot - 1) * dotGap;
      ctx.strokeStyle = 'rgba(100,200,255,0.80)';
      ctx.lineWidth   = 3;
      ctx.lineCap     = 'round';
      ctx.beginPath();
      ctx.arc(dx, dotsY, dotR + 4, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── Face overlay ──────────────────────────────────────────────────────────
  _drawFaceOverlay() {
    if (!this._activeFaceBox) return;
    const ctx = this.ctx;
    const W = this.overlay.width, H = this.overlay.height;
    const { x, y, w, h } = this._activeFaceBox;

    const fx = x * W, fy = y * H, fw = w * W, fh = h * H;

    ctx.save();
    // Soft green border around the active artist's face
    ctx.strokeStyle = 'rgba(60,200,120,0.65)';
    ctx.lineWidth   = 2.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(fx, fy, fw, fh);
    ctx.setLineDash([]);

    // "✦ Artist" label at top-right of face box
    ctx.fillStyle    = 'rgba(40,160,90,0.80)';
    ctx.font         = 'bold 13px system-ui, sans-serif';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('✦ Artist', fx + fw + 4, fy + 16);
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
      : (this.paintHoldProgress > 0 ? 'rgba(60,220,130,0.90)' : 'rgba(200,220,255,0.6)');
    ctx.fillStyle = tipCol;
    ctx.beginPath();
    ctx.arc(px(8), py(8), this.isPainting ? 11 : 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth   = 2;
    ctx.stroke();
  }
}
