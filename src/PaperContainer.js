/**
 * PaperContainer — Minimalist Paper / Neumorphic surface setup.
 *
 * Provides:
 *   1. Paper grain overlay (#paper-grain div) — 128px SVG feTurbulence tile
 *      at ~3% opacity creates physical paper fibre feel.
 *   2. pressEffect()  — instant neumorphic press animation on any element.
 *   3. raisedShadow() / insetShadow() — JS-side shadow helpers so other
 *      modules can read the design tokens without parsing CSS variables.
 *
 * Usage:
 *   import { PaperContainer } from './PaperContainer.js';
 *   const paper = new PaperContainer();
 *   // later, for button presses:
 *   PaperContainer.pressEffect(myButtonEl);
 */
export class PaperContainer {
  /**
   * Initialises the grain overlay once.
   * Safe to call multiple times — checks for existing element.
   */
  constructor() {
    this._grain = null;
    this._applyBackground();
    this._mountGrain();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _applyBackground() {
    /* Ensure body matches theme even before CSS loads */
    document.body.style.background  = '#FDFBF8';
    document.documentElement.style.background = '#FDFBF8';
  }

  _mountGrain() {
    if (document.getElementById('paper-grain')) {
      this._grain = document.getElementById('paper-grain');
      return;
    }

    const grain = document.createElement('div');
    grain.id = 'paper-grain';

    /* 128×128 SVG feTurbulence noise tile — tiled as CSS background.
       fractalNoise + stitchTiles='stitch' gives seamless cold-press texture.
       Placed above canvas (z-index 2) but below all panels (z-index 20+). */
    grain.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 2;
      pointer-events: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='128' height='128'%3E%3Cfilter id='n' x='0' y='0'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.80' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='128' height='128' filter='url(%23n)'/%3E%3C/svg%3E");
      background-size: 128px 128px;
      background-repeat: repeat;
      opacity: 0.030;
      mix-blend-mode: multiply;
    `;

    document.body.appendChild(grain);
    this._grain = grain;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Instantly press a neumorphic element down (inset shadow) then release.
   * @param {HTMLElement} el          Element to animate.
   * @param {number}      durationMs  Hold time before release (default 140ms).
   */
  static pressEffect(el, durationMs = 140) {
    if (!el) return;
    const orig = el.style.boxShadow;
    const origTrans = el.style.transition;

    el.style.transition = 'box-shadow 0.07s ease';
    el.style.boxShadow  = [
      'inset -3px -3px 7px  rgba(255, 255, 255, 0.85)',
      'inset  3px  3px 7px  rgba(70, 50, 20, 0.12)',
    ].join(', ');

    setTimeout(() => {
      el.style.transition = 'box-shadow 0.14s ease';
      el.style.boxShadow  = orig;
      setTimeout(() => { el.style.transition = origTrans; }, 160);
    }, durationMs);
  }

  /**
   * Returns the CSS box-shadow string for a raised (extruded) element.
   * @param {'lg'|'sm'|'xs'} size  Shadow magnitude.
   */
  static raisedShadow(size = 'lg') {
    const shadows = {
      lg: '-8px -8px 16px rgba(255,255,255,1.0), 8px 8px 16px rgba(70,50,20,0.08)',
      sm: '-5px -5px 12px rgba(255,255,255,1.0), 5px 5px 12px rgba(70,50,20,0.08)',
      xs: '-3px -3px 8px  rgba(255,255,255,1.0), 3px 3px 8px  rgba(70,50,20,0.10)',
    };
    return shadows[size] ?? shadows.lg;
  }

  /**
   * Returns the CSS box-shadow string for an inset (concave) element.
   * @param {'well'|'track'|'pressed'} type  Inset type.
   */
  static insetShadow(type = 'track') {
    const shadows = {
      well:    'inset -8px -8px 16px rgba(255,255,255,1.0), inset 8px 8px 16px rgba(70,50,20,0.08)',
      track:   'inset -4px -4px 10px rgba(255,255,255,0.90), inset 4px 4px 10px rgba(70,50,20,0.10)',
      pressed: 'inset -3px -3px 7px  rgba(255,255,255,0.85), inset 3px 3px 7px  rgba(70,50,20,0.12)',
    };
    return shadows[type] ?? shadows.track;
  }

  /** Remove the grain overlay (e.g. for screenshot mode). */
  destroy() {
    this._grain?.remove();
    this._grain = null;
  }
}
