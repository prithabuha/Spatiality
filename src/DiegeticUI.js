/**
 * DiegeticUI — Grounded wooden paint palette with recessed ink wells.
 *
 * Replaces the floating Three.js colour orbs with a physical-feeling
 * wooden palette fixed at the bottom of the projected surface. Three
 * recessed ink wells (Rose, Blue, Yellow) accept a "dip" when the
 * tracked finger enters the well circle.
 *
 * Colours mirror the Three.js scene buckets exactly so no paint logic
 * needs to change — only the colour-selection UI is replaced.
 *
 * Usage:
 *   const ui = new DiegeticUI({ onColorSelect: ({r,g,b,key}) => ... });
 *   // each frame instead of scene.getColorBucketHit():
 *   const hit = ui.checkDip(normX, normY);
 *   if (hit) ui.triggerDipRipple(hit.key);
 */
export class DiegeticUI {
  constructor({ onColorSelect = null } = {}) {
    this._onColorSelect = onColorSelect;
    this._activeKey     = 'red';

    /* Pigment colours — must match Scene._addColorBuckets() rgb values */
    this._wells = [
      {
        key: 'red',    name: 'Rose',
        hex: '#9C1830',   glowHex: '#d93060',
        r: 0.85, g: 0.19, b: 0.38,
      },
      {
        key: 'blue',   name: 'Blue',
        hex: '#112B8A',   glowHex: '#1a3bbf',
        r: 0.10, g: 0.23, b: 0.75,
      },
      {
        key: 'yellow', name: 'Yellow',
        hex: '#A87800',   glowHex: '#f5c800',
        r: 0.96, g: 0.78, b: 0.02,
      },
    ];

    this._wellEls = {};   // key → { wellEl, cup }
    this._injectCSS();
    this._buildDOM();
  }

  // ── CSS ──────────────────────────────────────────────────────────────────────
  _injectCSS() {
    if (document.getElementById('diegetic-ui-css')) return;
    const s = document.createElement('style');
    s.id = 'diegetic-ui-css';
    s.textContent = /* css */`
      /* ── Global font override → Quicksand (tactile paper theme) ─────── */
      body, button, select, input, label,
      #hint-chip, .lab-head, .lab-row, .god-label, .god-head, .god-section-label {
        font-family: 'Quicksand', 'Varela Round', 'Segoe UI Rounded', sans-serif !important;
      }

      /* ── Palette board — neumorphic raised bar ───────────────────────── */
      /* Same warm-white surface as everything else; depth from shadows.    */
      #diegetic-palette {
        position: fixed;
        bottom: 28px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 40;

        display: flex;
        align-items: center;
        gap: 36px;
        padding: 20px 44px 18px;
        border-radius: 28px;

        background: #FDFBF8;

        /* Floating card — clean directional drop shadow */
        box-shadow:
          0  8px 32px rgba(0, 0, 0, 0.10),
          0  2px  8px rgba(0, 0, 0, 0.06);

        border: none;
        user-select: none;
        -webkit-tap-highlight-color: transparent;
      }

      /* ── Well wrapper ────────────────────────────────────────────────── */
      .dw-well {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        cursor: pointer;
      }

      /* ── Concave cup — neumorphic inset circle ───────────────────────── */
      /* Spec: "inset shadows for depth — top-left white / bottom-right     */
      /* rgba(70,50,20,0.08)" per the Minimalist Paper spec.               */
      .dw-cup {
        width: 72px;
        height: 72px;
        border-radius: 50%;
        position: relative;
        overflow: visible;
        background: #FDFBF8;
        transition: transform 0.16s ease;

        /* Concave bowl illusion — exact spec values */
        box-shadow:
          inset -8px -8px 16px rgba(255, 255, 255, 1.0),
          inset  8px  8px 16px rgba(70, 50, 20, 0.08);
      }

      /* Pigment ink: coloured fill inside the bowl + wet specular sheen */
      .dw-cup::before {
        content: '';
        position: absolute;
        /* Recessed inner disc — slightly smaller than the bowl rim */
        inset: 10px;
        border-radius: 50%;
        background-color: var(--well-pigment);
        background-image:
          radial-gradient(
            ellipse 55% 42% at 34% 28%,
            rgba(255, 255, 255, 0.42) 0%,
            rgba(255, 255, 255, 0.10) 48%,
            transparent 100%
          ),
          radial-gradient(
            ellipse 38% 28% at 72% 74%,
            rgba(255, 255, 255, 0.12) 0%,
            transparent 70%
          );
        /* Soft drop on the pigment disc for depth */
        box-shadow: 0 2px 8px rgba(70, 50, 20, 0.22);
      }

      /* Active ring — coloured outline that lifts when selected */
      .dw-cup::after {
        content: '';
        position: absolute;
        inset: -5px;
        border-radius: 50%;
        border: 2px solid var(--well-pigment);
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.22s ease, inset 0.22s ease;
        box-shadow:
          0 0 8px  var(--well-pigment),
          0 0 16px rgba(0, 0, 0, 0.06);
      }

      .dw-well.is-active .dw-cup::after {
        opacity: 0.85;
        inset: -6px;
      }
      .dw-well.is-active .dw-cup {
        transform: translateY(-3px);
      }

      /* Press-dip animation */
      .dw-well.is-dipping .dw-cup {
        transform: translateY(2px) scale(0.93) !important;
        transition: transform 0.07s ease !important;
        box-shadow:
          inset -5px -5px 12px rgba(255, 255, 255, 1.0),
          inset  5px  5px 12px rgba(70, 50, 20, 0.12) !important;
      }

      /* ── Well label ──────────────────────────────────────────────────── */
      .dw-label {
        font-family: 'Quicksand', sans-serif;
        font-size: 11.5px;
        font-weight: 600;
        color: #8F8F8F;
        letter-spacing: 0.4px;
        pointer-events: none;
      }

      /* ── Dip ripple rings ────────────────────────────────────────────── */
      @keyframes dwRipple {
        0%   { transform: translate(-50%, -50%) scale(0.88);
               opacity: 0.70; border-width: 2.5px; }
        60%  { opacity: 0.30; }
        100% { transform: translate(-50%, -50%) scale(3.6);
               opacity: 0;   border-width: 1px; }
      }

      .dw-ripple {
        position: absolute;
        top: 50%; left: 50%;
        width: 100%; height: 100%;
        border-radius: 50%;
        border: 2.5px solid var(--well-pigment);
        pointer-events: none;
        animation: dwRipple 0.65s cubic-bezier(0.05, 0.48, 0.35, 1.0) forwards;
        box-shadow: 0 0 6px var(--well-pigment);
      }
    `;
    document.head.appendChild(s);
  }

  // ── DOM ──────────────────────────────────────────────────────────────────────
  _buildDOM() {
    this.el = document.createElement('div');
    this.el.id = 'diegetic-palette';

    this._wells.forEach(w => {
      const wellEl = document.createElement('div');
      wellEl.className = 'dw-well' + (w.key === this._activeKey ? ' is-active' : '');
      wellEl.dataset.key = w.key;
      wellEl.style.cssText = `--well-pigment:${w.hex}; --well-glow:${w.glowHex};`;

      const cup = document.createElement('div');
      cup.className = 'dw-cup';

      const label = document.createElement('span');
      label.className = 'dw-label';
      label.textContent = w.name;

      wellEl.appendChild(cup);
      wellEl.appendChild(label);
      this.el.appendChild(wellEl);
      this._wellEls[w.key] = { wellEl, cup };

      // Click / tap fallback (mouse or touch)
      wellEl.addEventListener('click', () => this.triggerDipRipple(w.key));
    });

    (document.getElementById('app') ?? document.body).appendChild(this.el);
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Check if finger at (normX, normY) overlaps any ink well.
   * Returns { r, g, b, key, name } or null.
   * Replace scene.getColorBucketHit() with this every frame.
   */
  checkDip(normX, normY) {
    const fx = normX * window.innerWidth;
    const fy = normY * window.innerHeight;

    for (const w of this._wells) {
      const cup = this._wellEls[w.key]?.cup;
      if (!cup) continue;
      const rect = cup.getBoundingClientRect();
      const cx   = rect.left + rect.width  * 0.5;
      const cy   = rect.top  + rect.height * 0.5;
      // Hit radius slightly larger than visual for usability
      if (Math.hypot(fx - cx, fy - cy) < rect.width * 0.60) {
        return { r: w.r, g: w.g, b: w.b, key: w.key, name: w.name };
      }
    }
    return null;
  }

  /**
   * Visual dip feedback: press + ripple rings + colour select.
   */
  triggerDipRipple(key) {
    const { wellEl, cup } = this._wellEls[key] ?? {};
    if (!cup) return;
    const w = this._wells.find(x => x.key === key);

    // Press-down then release
    wellEl.classList.add('is-dipping');
    setTimeout(() => wellEl.classList.remove('is-dipping'), 160);

    // Three staggered ripple rings
    for (let i = 0; i < 3; i++) {
      const ring = document.createElement('div');
      ring.className = 'dw-ripple';
      ring.style.animationDelay = (i * 0.15) + 's';
      if (w) ring.style.setProperty('--well-glow', w.glowHex);
      cup.appendChild(ring);
      setTimeout(() => ring.remove(), 850 + i * 150);
    }

    // Update active ring highlight
    if (this._wellEls[this._activeKey]) {
      this._wellEls[this._activeKey].wellEl.classList.remove('is-active');
    }
    this._activeKey = key;
    wellEl.classList.add('is-active');

    // Fire callback
    if (w && this._onColorSelect) {
      this._onColorSelect({ r: w.r, g: w.g, b: w.b, key });
    }
  }

  /** Silently set active well highlight without firing callback. */
  setActiveKey(key) {
    if (this._wellEls[this._activeKey]) {
      this._wellEls[this._activeKey].wellEl.classList.remove('is-active');
    }
    this._activeKey = key;
    if (this._wellEls[key]) {
      this._wellEls[key].wellEl.classList.add('is-active');
    }
  }

  destroy() {
    this.el?.remove();
    document.getElementById('diegetic-ui-css')?.remove();
  }
}
