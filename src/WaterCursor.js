/**
 * WaterCursor — Shimmering refractive water-droplet cursor.
 *
 * An SVG teardrop tracks the index_finger_tip. Visual properties:
 *   • Semi-transparent radial-gradient fill tinted to the current colour
 *   • Orbiting white shimmer ellipse (refractive highlight)
 *   • Secondary pulsing sparkle
 *   • Coloured drop-shadow glow matching the active paint colour
 *   • Subtle perpetual wobble (droplet surface tension)
 *   • Squish animation when dipping into an ink well
 *   • Smooth colour lerp transition when switching colours
 *
 * The tip of the teardrop is anchored at the tracked finger position.
 *
 * Usage:
 *   const wc = new WaterCursor();
 *   wc.setColor(0.85, 0.19, 0.38);   // match initial active colour
 *   // each frame:
 *   wc.setPosition(normX, normY);
 *   wc.setActive(isPainting);
 *   wc.setSize(brushRadius);         // optional — syncs visual size
 *   wc.show() / wc.hide();
 *   // on dip:
 *   wc.triggerDip();
 */
export class WaterCursor {
  constructor() {
    /* Display colour (lerps toward target each frame) */
    this._r  = 0.85;  this._g  = 0.19;  this._b  = 0.38;
    /* Target colour */
    this._tr = 0.85;  this._tg = 0.19;  this._tb = 0.38;

    this._x       = -300;   // screen X px
    this._y       = -300;   // screen Y px
    this._size    = 28;     // base diameter px
    this._active  = false;
    this._squish  = 0.0;    // 0 = round, 1 = fully squished
    this._visible = false;
    this._raf     = null;

    this._buildDOM();
    this._startLoop();
  }

  // ── DOM construction ─────────────────────────────────────────────────────────
  _buildDOM() {
    /* Invisible SVG in <body> that owns the reusable clipPath.
       clipPathUnits="objectBoundingBox" makes the path scale with the host. */
    const defsSVG = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    defsSVG.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;';
    defsSVG.setAttribute('aria-hidden', 'true');
    defsSVG.innerHTML = `
      <defs>
        <clipPath id="wc-clip" clipPathUnits="objectBoundingBox">
          <path d="M0.50,0.05
                   C0.78,0.26 0.95,0.56 0.50,0.95
                   C0.05,0.56 0.22,0.26 0.50,0.05 Z"/>
        </clipPath>
      </defs>`;
    document.body.appendChild(defsSVG);

    /* Outer container — positioned at finger tip */
    this.el = document.createElement('div');
    this.el.id = 'water-cursor';
    this.el.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 9999;
      display: none;
      will-change: transform, left, top, filter;
    `;

    /* Frosted-glass backdrop — refractive water-on-paper distortion.
       brightness(1.08) mimics how a real water drop magnifies/brightens
       the paper beneath it; saturate(1.06) enriches the wet-paper colour. */
    this._glass = document.createElement('div');
    this._glass.style.cssText = `
      position: absolute;
      inset: 0;
      clip-path: url(#wc-clip);
      -webkit-clip-path: url(#wc-clip);
      backdrop-filter: blur(5px) brightness(1.08) saturate(1.06);
      -webkit-backdrop-filter: blur(5px) brightness(1.08) saturate(1.06);
    `;

    /* SVG overlay: coloured fill + shimmer + outline */
    this._svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this._svg.setAttribute('viewBox', '0 0 50 64');
    this._svg.setAttribute('aria-hidden', 'true');
    this._svg.style.cssText = `
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      overflow: visible;
    `;
    /* On the warm-white paper surface water appears nearly clear — slightly
       tinted by the pigment it carries, with a dark thin rim so it reads
       against the bright background. The highlight stays bright white. */
    this._svg.innerHTML = `
      <defs>
        <!-- Water fill: nearly clear centre → soft tint → semi-opaque edge -->
        <!-- Lower opacity than before so the paper shows through cleanly   -->
        <radialGradient id="wc-fill" cx="42%" cy="30%" r="70%">
          <stop id="wc-s1" offset="0%"   stop-color="white"   stop-opacity="0.05"/>
          <stop id="wc-s2" offset="38%"  stop-color="#d93060" stop-opacity="0.18"/>
          <stop id="wc-s3" offset="100%" stop-color="#d93060" stop-opacity="0.55"/>
        </radialGradient>

        <!-- Primary shimmer highlight (orbiting) -->
        <radialGradient id="wc-hi-grad" cx="50%" cy="50%" r="50%">
          <stop offset="0%"   stop-color="white" stop-opacity="0.95"/>
          <stop offset="100%" stop-color="white" stop-opacity="0"/>
        </radialGradient>
      </defs>

      <!-- Main body fill — clear water tinted by active pigment -->
      <path id="wc-body"
            d="M25,3 C40,20 47,39 25,61 C3,39 10,20 25,3 Z"
            fill="url(#wc-fill)"/>

      <!-- Rim — thin dark line so the drop reads on warm white paper -->
      <path id="wc-rim"
            d="M25,3 C40,20 47,39 25,61 C3,39 10,20 25,3 Z"
            fill="none"
            stroke="rgba(0,0,0,0.12)"
            stroke-width="1.2"/>

      <!-- Orbiting shimmer ellipse — the water-lens specular -->
      <ellipse id="wc-hi"
               cx="18" cy="16" rx="11" ry="7"
               fill="url(#wc-hi-grad)"
               opacity="0.88"/>

      <!-- Secondary pulsing sparkle -->
      <circle id="wc-spark"
              cx="32" cy="38" r="3"
              fill="rgba(255,255,255,0.85)"
              opacity="0.60"/>
    `;

    this.el.appendChild(this._glass);
    this.el.appendChild(this._svg);
    (document.getElementById('app') ?? document.body).appendChild(this.el);

    /* Cache live element refs */
    this._s2    = this._svg.getElementById('wc-s2');
    this._s3    = this._svg.getElementById('wc-s3');
    this._hiEl  = this._svg.getElementById('wc-hi');
    this._spkEl = this._svg.getElementById('wc-spark');
    this._body  = this._svg.getElementById('wc-body');
    this._rim   = this._svg.getElementById('wc-rim');
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /** Move tip to normalised screen position. */
  setPosition(normX, normY) {
    this._x = normX * window.innerWidth;
    this._y = normY * window.innerHeight;
  }

  /** Begin lerping toward a new colour (RGB 0–1). */
  setColor(r, g, b) {
    this._tr = r;
    this._tg = g;
    this._tb = b;
  }

  /** Painting state — droplet enlarges slightly. */
  setActive(active) { this._active = active; }

  /** Sync visual size with brush radius (normalised 0–1). */
  setSize(normRadius) {
    this._size = 20 + normRadius * 44;
  }

  show() { this._visible = true;  this.el.style.display = 'block'; }
  hide() { this._visible = false; this.el.style.display = 'none';  }

  /** Squish-dip animation — call when finger enters ink well. */
  triggerDip() { this._squish = 1.0; }

  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this.el?.remove();
    document.querySelector('svg[aria-hidden="true"]')?.remove();
  }

  // ── Animation loop ───────────────────────────────────────────────────────────
  _startLoop() {
    const tick = () => {
      this._raf = requestAnimationFrame(tick);
      this._render(performance.now() * 0.001);
    };
    tick();
  }

  _render(t) {
    /* ── 1. Colour lerp ─────────────────────────────────────────────────── */
    const sp = 0.075;
    this._r += (this._tr - this._r) * sp;
    this._g += (this._tg - this._g) * sp;
    this._b += (this._tb - this._b) * sp;

    const R = Math.round(this._r * 255);
    const G = Math.round(this._g * 255);
    const B = Math.round(this._b * 255);
    const col = `rgb(${R},${G},${B})`;

    /* ── 2. Size + layout ───────────────────────────────────────────────── */
    this._squish *= 0.84;   // exponential decay
    const sz = this._size * (this._active ? 1.16 : 1.0);
    const w  = sz;
    const h  = sz * 1.28;  // droplet is taller than wide

    /* Tip of drop sits at finger — offset so top ~8% of SVG is above finger */
    this.el.style.width  = w + 'px';
    this.el.style.height = h + 'px';
    this.el.style.left   = (this._x - w * 0.50) + 'px';
    this.el.style.top    = (this._y - h * 0.08) + 'px';

    /* ── 3. Squish + sway transform ─────────────────────────────────────── */
    const sx   = 1.0 + this._squish * 0.30;
    const sy   = 1.0 - this._squish * 0.22;
    const sway = Math.sin(t * 2.0) * 1.4;  // gentle perpetual sway
    this.el.style.transform       = `scaleX(${sx.toFixed(3)}) scaleY(${sy.toFixed(3)}) rotate(${sway.toFixed(2)}deg)`;
    this.el.style.transformOrigin = '50% 6%'; // pivot at tip

    /* ── 4. Colour → SVG stops ──────────────────────────────────────────── */
    this._s2?.setAttribute('stop-color', col);
    this._s3?.setAttribute('stop-color', col);

    /* ── 5. Drop-shadow — subtle on bright paper ───────────────────────── */
    /* Lighter shadow values so the droplet sits gently on the white surface */
    const glowA = this._active ? 0.45 : 0.28;
    this.el.style.filter = [
      `drop-shadow(0 4px 10px rgba(${R},${G},${B},${glowA}))`,
      `drop-shadow(0 2px  5px rgba(0,0,0,0.08))`,
    ].join(' ');

    /* ── 6. Orbiting shimmer highlight ──────────────────────────────────── */
    const hx = 25 + Math.cos(t * 0.90) * 8;
    const hy = 16 + Math.sin(t * 0.68) * 6;
    const ha = t * 36;   // degrees per second
    this._hiEl?.setAttribute('cx', hx.toFixed(1));
    this._hiEl?.setAttribute('cy', hy.toFixed(1));
    this._hiEl?.setAttribute('transform', `rotate(${ha.toFixed(0)},${hx.toFixed(1)},${hy.toFixed(1)})`);
    this._hiEl?.setAttribute('opacity',   (0.60 + Math.sin(t * 1.55) * 0.24).toFixed(2));

    /* ── 7. Secondary sparkle pulse ─────────────────────────────────────── */
    this._spkEl?.setAttribute('cx',      (32 + Math.sin(t * 1.85) * 3).toFixed(1));
    this._spkEl?.setAttribute('cy',      (37 + Math.cos(t * 2.20) * 5).toFixed(1));
    this._spkEl?.setAttribute('r',       (2.4 + Math.sin(t * 3.10) * 1.1).toFixed(1));
    this._spkEl?.setAttribute('opacity', (0.30 + Math.sin(t * 2.75) * 0.32).toFixed(2));

    /* ── 8. Droplet body wobble (surface-tension breathing) ─────────────── */
    const wb = Math.sin(t * 1.75) * 1.6;
    const path = `M25,3 C${(40+wb).toFixed(1)},${(20-wb*0.4).toFixed(1)} 47,39 25,61 C3,39 ${(10-wb).toFixed(1)},${(20-wb*0.4).toFixed(1)} 25,3 Z`;
    this._body?.setAttribute('d', path);
    this._rim?.setAttribute('d',  path);
  }
}
