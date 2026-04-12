/**
 * Calibration — 4-point homography for projector alignment.
 *
 * Allows drag-with-pinch of four corner dots to compute a
 * CSS perspective-transform matrix that warps the Three.js canvas.
 *
 * The homography is recomputed whenever a corner moves and applied
 * as a CSS `transform` on the canvas element.
 */

export class Calibration {
  constructor(canvasEl, overlayEl) {
    this.canvas  = canvasEl;
    this.overlay = overlayEl;
    this.active  = false;

    this.dots = {
      tl: document.getElementById('dot-tl'),
      tr: document.getElementById('dot-tr'),
      bl: document.getElementById('dot-bl'),
      br: document.getElementById('dot-br'),
    };

    // Normalized positions [0-1]
    this.corners = {
      tl: { x: 0.0, y: 0.0 },
      tr: { x: 1.0, y: 0.0 },
      bl: { x: 0.0, y: 1.0 },
      br: { x: 1.0, y: 1.0 },
    };

    this._dragging = null;
    this._setupDrag();
  }

  toggle() {
    this.active = !this.active;
    this.overlay.classList.toggle('visible', this.active);
    if (!this.active) {
      // Reset transform
      this.canvas.style.transform = '';
    }
    return this.active;
  }

  _setupDrag() {
    for (const [key, dot] of Object.entries(this.dots)) {
      dot.addEventListener('mousedown', e => {
        this._dragging = key;
        e.preventDefault();
      });
    }

    window.addEventListener('mousemove', e => {
      if (!this._dragging) return;
      const pct = this._toPct(e.clientX, e.clientY);
      this.corners[this._dragging] = pct;
      this._updateDot(this._dragging);
      this._applyHomography();
    });

    window.addEventListener('mouseup', () => { this._dragging = null; });

    // Touch support
    for (const [key, dot] of Object.entries(this.dots)) {
      dot.addEventListener('touchstart', e => {
        this._dragging = key; e.preventDefault();
      }, { passive: false });
    }
    window.addEventListener('touchmove', e => {
      if (!this._dragging) return;
      const t = e.touches[0];
      const pct = this._toPct(t.clientX, t.clientY);
      this.corners[this._dragging] = pct;
      this._updateDot(this._dragging);
      this._applyHomography();
    });
    window.addEventListener('touchend', () => { this._dragging = null; });
  }

  /**
   * Move a dot via pinch gesture (called from main loop).
   * normX, normY are in [0, 1] screen space.
   */
  pinchDrag(normX, normY) {
    if (!this.active) return;
    // Find closest corner within 8% of screen
    let closest = null, minDist = 0.08;
    for (const [key, c] of Object.entries(this.corners)) {
      const d = Math.hypot(c.x - normX, c.y - normY);
      if (d < minDist) { minDist = d; closest = key; }
    }
    if (!closest && !this._dragging) return;
    if (closest) this._dragging = closest;
    if (!this._dragging) return;

    this.corners[this._dragging] = { x: normX, y: normY };
    this._updateDot(this._dragging);
    this._applyHomography();
  }

  stopDrag() { this._dragging = null; }

  _toPct(px, py) {
    return { x: px / window.innerWidth, y: py / window.innerHeight };
  }

  _updateDot(key) {
    const c = this.corners[key];
    const dot = this.dots[key];
    dot.style.left = (c.x * 100).toFixed(2) + '%';
    dot.style.top  = (c.y * 100).toFixed(2) + '%';
  }

  /**
   * Computes a CSS perspective() transform approximating a homography
   * from the unit square to the four corner positions.
   *
   * We use the standard 8-parameter homography solved via the direct
   * linear transform, then convert to a CSS 4x4 matrix3d.
   */
  _applyHomography() {
    const W = window.innerWidth;
    const H = window.innerHeight;

    const { tl, tr, bl, br } = this.corners;
    // Destination points in pixels
    const dst = [
      [tl.x * W, tl.y * H],
      [tr.x * W, tr.y * H],
      [bl.x * W, bl.y * H],
      [br.x * W, br.y * H],
    ];
    // Source points (unit square scaled to screen)
    const src = [[0, 0], [W, 0], [0, H], [W, H]];

    const h = this._computeHomography(src, dst);
    if (!h) return;

    // Convert 3x3 homography to CSS matrix3d (column-major 4x4)
    const m = [
      h[0], h[3], 0, h[6],
      h[1], h[4], 0, h[7],
      0,    0,    1, 0,
      h[2], h[5], 0, h[8],
    ];
    this.canvas.style.transform = `matrix3d(${m.join(',')})`;
    this.canvas.style.transformOrigin = '0 0';
  }

  /**
   * Direct Linear Transform for 2D homography (4-point correspondence).
   * Returns a flat 9-element array [h00..h22].
   */
  _computeHomography(src, dst) {
    // Build 8x9 matrix A for Ah = 0
    const A = [];
    for (let i = 0; i < 4; i++) {
      const [sx, sy] = src[i];
      const [dx, dy] = dst[i];
      A.push([-sx, -sy, -1,   0,   0,  0, dx * sx, dx * sy, dx]);
      A.push([  0,   0,  0, -sx, -sy, -1, dy * sx, dy * sy, dy]);
    }

    // SVD via power iteration is complex; instead use Gaussian elimination
    // on the 8x8 system (fixing h[8]=1)
    const rows = A.length; // 8
    const cols = 9;
    const mat  = A.map(r => [...r]);

    // Reduce last column (h8=1): subtract col 8 from RHS
    const b = mat.map(r => -r[8]);
    const M = mat.map(r => r.slice(0, 8));

    // Gaussian elimination
    for (let col = 0; col < 8; col++) {
      let pivot = -1, maxVal = 0;
      for (let row = col; row < 8; row++) {
        if (Math.abs(M[row][col]) > maxVal) {
          maxVal = Math.abs(M[row][col]);
          pivot = row;
        }
      }
      if (pivot < 0) return null;
      [M[col], M[pivot]] = [M[pivot], M[col]];
      [b[col], b[pivot]] = [b[pivot], b[col]];

      const scale = M[col][col];
      for (let c = col; c < 8; c++) M[col][c] /= scale;
      b[col] /= scale;

      for (let row = 0; row < 8; row++) {
        if (row === col) continue;
        const f = M[row][col];
        for (let c = col; c < 8; c++) M[row][c] -= f * M[col][c];
        b[row] -= f * b[col];
      }
    }

    return [...b, 1]; // h = [h00..h22] with h22=1
  }
}
