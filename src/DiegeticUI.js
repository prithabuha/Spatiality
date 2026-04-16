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
      /* ── Global font override → Varela Round ─────────────────────────── */
      body, button, select, input, label,
      #hint-chip, .lab-head, .lab-row, .god-label, .god-head, .god-section-label {
        font-family: 'Varela Round', 'Segoe UI Rounded', sans-serif !important;
      }

      /* Hint chip: positioned above palette — matches dark studio theme */
      #hint-chip {
        bottom: 175px !important;
      }

      /* ── Palette board ───────────────────────────────────────────────── */
      #diegetic-palette {
        position: fixed;
        bottom: 28px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 40;

        display: flex;
        align-items: center;
        gap: 34px;
        padding: 20px 40px 17px;
        border-radius: 22px;

        /* Cold-press wood: layered grain streaks + warm tones */
        background:
          repeating-linear-gradient(
            94deg,
            transparent 0px, transparent 52px,
            rgba(0,0,0,0.024) 52px, rgba(0,0,0,0.024) 53px
          ),
          linear-gradient(
            172deg,
            #CFA06A 0%,
            #A87545 18%,
            #8C5E2A 40%,
            #AA7A48 58%,
            #C09260 74%,
            #8A5A2A 100%
          );

        /* Raised-board illusion: stacked bottom edges + drop shadow */
        box-shadow:
          inset 0 1px 0 rgba(255, 215, 155, 0.52),
          inset 1px 0 0 rgba(255, 200, 130, 0.20),
          0 2px 0 #7C5025,
          0 4px 0 #6B421A,
          0 6px 0 #5C3614,
          0 8px 0 #4E2C0C,
          0 16px 36px rgba(0, 0, 0, 0.52),
          0 30px 60px rgba(0, 0, 0, 0.18);

        border: 1px solid rgba(55, 28, 0, 0.35);
        border-bottom-color: rgba(0, 0, 0, 0.60);

        /* Prevent selection */
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

      /* ── Recessed cup ────────────────────────────────────────────────── */
      .dw-cup {
        width: 74px;
        height: 74px;
        border-radius: 50%;
        position: relative;
        overflow: visible;
        transition: transform 0.16s ease;

        /* Deep cavity: stacked inset shadows create dimensional recess */
        box-shadow:
          0 2px 7px rgba(0, 0, 0, 0.58),
          inset 0 1px 3px rgba(255, 255, 255, 0.10),
          inset 0 7px 20px rgba(0, 0, 0, 0.80),
          inset 0 14px 30px rgba(0, 0, 0, 0.60),
          inset 0 -3px 10px rgba(0, 0, 0, 0.38);
      }

      /* Pigment fill: wet-surface gloss via compound gradient */
      .dw-cup::before {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: 50%;
        background-color: var(--well-pigment);
        background-image:
          /* Wet sheen: top-left specular */
          radial-gradient(
            ellipse 52% 40% at 36% 26%,
            rgba(255, 255, 255, 0.32) 0%,
            rgba(255, 255, 255, 0.07) 50%,
            transparent 100%
          ),
          /* Secondary bottom-right bounce */
          radial-gradient(
            ellipse 40% 30% at 72% 75%,
            rgba(255, 255, 255, 0.08) 0%,
            transparent 70%
          );
      }

      /* Active ring — glows in the well's colour */
      .dw-cup::after {
        content: '';
        position: absolute;
        inset: -6px;
        border-radius: 50%;
        border: 2.5px solid var(--well-glow);
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.24s ease, inset 0.24s ease;
        box-shadow:
          0 0 10px var(--well-glow),
          0 0 22px rgba(255, 255, 255, 0.08),
          inset 0 0 6px rgba(255, 255, 255, 0.10);
      }

      .dw-well.is-active .dw-cup::after {
        opacity: 1;
        inset: -7px;
      }

      .dw-well.is-active .dw-cup {
        transform: translateY(-3px);
      }

      /* Press-dip animation */
      .dw-well.is-dipping .dw-cup {
        transform: translateY(3px) scale(0.92) !important;
        transition: transform 0.07s ease !important;
      }

      /* ── Well label ──────────────────────────────────────────────────── */
      .dw-label {
        font-family: 'Varela Round', sans-serif;
        font-size: 12.5px;
        color: rgba(255, 235, 195, 0.88);
        /* Offset ink shadow */
        text-shadow: 2px 3px 0 rgba(20, 8, 0, 0.50);
        letter-spacing: 0.5px;
        pointer-events: none;
      }

      /* ── Dip ripple rings ────────────────────────────────────────────── */
      @keyframes dwRipple {
        0%   { transform: translate(-50%, -50%) scale(0.85);
               opacity: 0.88; border-width: 3px; }
        65%  { opacity: 0.40; }
        100% { transform: translate(-50%, -50%) scale(3.8);
               opacity: 0;   border-width: 1px; }
      }

      .dw-ripple {
        position: absolute;
        top: 50%; left: 50%;
        width: 100%; height: 100%;
        border-radius: 50%;
        border: 3px solid var(--well-glow);
        pointer-events: none;
        animation: dwRipple 0.68s cubic-bezier(0.05, 0.48, 0.35, 1.0) forwards;
        box-shadow: 0 0 10px var(--well-glow);
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
