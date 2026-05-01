/**
 * madmapper_relay.js  —  Three.js  →  ar_sender.py  →  MadMapper
 * ─────────────────────────────────────────────────────────────────────────────
 * Captures the WebGL canvas every frame (synced to requestAnimationFrame so it
 * always reads the freshest render) and streams raw RGBA bytes to the Python
 * ar_sender.py over a plain WebSocket.
 *
 * USAGE — add to the bottom of main.js (after renderer + scene + camera exist):
 *
 *   import { MadMapperRelay } from './madmapper_relay.js'
 *   const relay = new MadMapperRelay(renderer, scene.scene, scene.camera)
 *   // Then call relay.onAfterRender() at the end of your animate() loop.
 *
 * URL PARAMETERS (all optional):
 *   ?madmapper=1          enable relay
 *   ?madmapper=alpha      enable relay + transparent background
 *   ?mm_port=9876         Python server port (default 9876)
 *   ?mm_fps=30            capture rate  (default 30 fps — enough for mapping)
 *   ?mm_quality=raw       'raw'=fastest binary, 'png'=lossless (slower)
 *
 * Requirements on the Python side:
 *   python ar_sender.py   (in project root)
 */

export class MadMapperRelay {

  /**
   * @param {import('three').WebGLRenderer} renderer
   * @param {import('three').Scene}  scene
   * @param {import('three').Camera} camera
   * @param {object} [opts]
   * @param {number}  [opts.fps=30]
   * @param {string}  [opts.host='localhost']
   * @param {number}  [opts.port=9876]
   * @param {boolean} [opts.alpha=false]  transparent background
   * @param {'raw'|'png'} [opts.quality='raw']
   */
  constructor (renderer, scene, camera, opts = {}) {
    const params    = new URLSearchParams(window.location.search)
    const mmParam   = params.get('madmapper')

    // Relay is OFF unless ?madmapper= is in the URL ──────────────────────────
    if (!mmParam) {
      console.log(
        '[MadMapper] Relay disabled. Append  ?madmapper=1  to the URL to activate.'
      )
      return
    }

    this._renderer = renderer
    this._scene    = scene
    this._camera   = camera
    this._alpha    = opts.alpha   ?? mmParam === 'alpha'
    this._fps      = opts.fps     ?? parseInt(params.get('mm_fps')     ?? '30')
    this._port     = opts.port    ?? parseInt(params.get('mm_port')    ?? '9876')
    this._host     = opts.host    ?? 'localhost'
    this._quality  = opts.quality ?? (params.get('mm_quality') ?? 'raw')
    this._active   = false
    this._ws       = null
    this._lastSend = 0

    // Grab GL dimensions AFTER the renderer has been sized ───────────────────
    const gl   = renderer.getContext()
    this._W    = gl.drawingBufferWidth
    this._H    = gl.drawingBufferHeight
    // Pre-allocate single pixel buffer — reused every frame (no GC pressure)
    this._rgba = new Uint8Array(this._W * this._H * 4)

    if (this._alpha) this._enableAlpha()
    this._connect()

    console.info(
      `[MadMapper] Relay active\n`
      + `  Resolution : ${this._W} × ${this._H}\n`
      + `  Capture    : ${this._fps} fps  (${this._quality})\n`
      + `  Alpha      : ${this._alpha}\n`
      + `  Target     : ws://${this._host}:${this._port}`
    )
  }

  // ── Optional transparent-background mode ────────────────────────────────────
  _enableAlpha () {
    // Remove solid background so watercolor strokes are on a transparent canvas
    this._scene.background = null
    this._renderer.setClearColor(0x000000, 0)
    this._renderer.setClearAlpha(0)
    console.info('[MadMapper] Alpha mode: scene background cleared')
  }

  // ── WebSocket — auto-reconnect ───────────────────────────────────────────────
  _connect () {
    const url    = `ws://${this._host}:${this._port}`
    const ws     = new WebSocket(url)
    ws.binaryType = 'arraybuffer'

    ws.addEventListener('open', () => {
      console.info(`[MadMapper] ✓ Connected → ${url}`)
      this._ws     = ws
      this._active = true
    })

    ws.addEventListener('close', () => {
      console.warn('[MadMapper] Disconnected — retry in 3 s…')
      this._active = false
      this._ws     = null
      setTimeout(() => this._connect(), 3_000)
    })

    ws.addEventListener('error', () => {
      // 'close' fires immediately after, handles retry
    })
  }

  // ── Call this ONCE at the end of your animate() render loop ─────────────────
  /**
   * Capture the current frame and send it to ar_sender.py.
   * Call this at the end of your animate() function, after renderer.render()
   * (or after composer.render() if using post-processing).
   */
  onAfterRender () {
    if (!this._active || !this._ws) return

    // Rate-limit to --fps ────────────────────────────────────────────────────
    const now = performance.now()
    if (now - this._lastSend < 1_000 / this._fps) return
    this._lastSend = now

    if (this._quality === 'raw') {
      this._sendRaw()
    } else {
      this._sendPng()
    }
  }

  // ── Protocol A: raw RGBA binary (fastest) ───────────────────────────────────
  _sendRaw () {
    const gl = this._renderer.getContext()
    // readPixels reads the *current* back-buffer — must be called before the
    // browser swaps buffers, so this should be the last call inside animate().
    gl.readPixels(0, 0, this._W, this._H, gl.RGBA, gl.UNSIGNED_BYTE, this._rgba)
    // Transfer ownership so WebSocket can DMA without a copy
    const copy = this._rgba.slice(0)  // new Uint8Array that WS can own
    this._ws.send(copy.buffer)
  }

  // ── Protocol B: PNG data-URL (lossless alpha, ~3× slower) ───────────────────
  _sendPng () {
    const canvas = this._renderer.domElement
    canvas.toBlob(blob => {
      if (!blob || !this._ws || !this._active) return
      blob.arrayBuffer().then(buf => {
        if (this._ws && this._active) this._ws.send(buf)
      })
    }, 'image/png')
  }

  // ── Clean shutdown ───────────────────────────────────────────────────────────
  destroy () {
    this._active = false
    if (this._ws) {
      this._ws.close()
      this._ws = null
    }
  }
}
