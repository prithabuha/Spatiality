/**
 * kiosk.js — Spatiality Kiosk Controller  ·  1920 × 1080
 * Segmented colour wheel · Pill water slider · 3 stroke finish cards
 */
import QRCode from 'qrcode'

// ── Scale #kiosk-root to fill any display at the 1920×1080 reference ─────
// transform-origin: top left  →  scales from (0,0), body overflow hidden
function scaleKiosk() {
  const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080)
  const root = document.getElementById('kiosk-root')
  root.style.setProperty('--ks', s)
  // Centre the scaled canvas when letterboxing occurs
  root.style.left = Math.round((window.innerWidth  - 1920 * s) / 2) + 'px'
  root.style.top  = Math.round((window.innerHeight - 1080 * s) / 2) + 'px'
}
scaleKiosk()
window.addEventListener('resize', scaleKiosk)

// ── WebSocket → AR relay  (auto-reconnecting) ─────────────────────────────
const _wsProto = location.protocol === 'https:' ? 'wss' : 'ws'

// Stored viewer URL for QR regeneration on colour change
let _currentViewerUrl  = ''
let _currentArtworkUrl = ''

let _ws              = null
let _wsReconnectTimer = null

function _connectKioskWS() {
  clearTimeout(_wsReconnectTimer)
  _ws = new WebSocket(`${_wsProto}://${location.host}/kiosk-ws`)
  _ws.addEventListener('open', () => console.log('[kiosk] WS connected'))
  _ws.addEventListener('error', e => console.warn('[kiosk] WS error', e))
  _ws.addEventListener('close', () => {
    console.warn('[kiosk] WS closed — reconnecting in 2 s…')
    _wsReconnectTimer = setTimeout(_connectKioskWS, 2000)
  })
  // AR sends artwork info back through the relay
  _ws.addEventListener('message', ({ data: raw }) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    if (msg.type === 'artwork') _showArtwork(msg)
  })
}
_connectKioskWS()

function send(msg) {
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify(msg))
  } else if (_ws) {
    // Queue for when the connection opens (user interactions are infrequent — safe to buffer)
    _ws.addEventListener('open', () => _ws.send(JSON.stringify(msg)), { once: true })
  }
}

// ── Screen helpers ─────────────────────────────────────────────────────────
const screens = {
  welcome:  document.getElementById('screen-welcome'),
  controls: document.getElementById('screen-controls'),
  end:      document.getElementById('screen-end'),
}
function showScreen(name) {
  for (const [k, el] of Object.entries(screens)) {
    el.classList.toggle('active', k === name)
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  WELCOME
// ══════════════════════════════════════════════════════════════════════════
document.getElementById('btn-start').addEventListener('click', () => {
  showScreen('controls')
  send({ type: 'start' })
  // ── Sync kiosk state to AR immediately so they're never out of step ──────
  const seg = SEGMENTS[activeSegIdx]
  send({ type: 'color', hex: seg.hex, r: seg.r, g: seg.g, b: seg.b })
  send({ type: 'water', value: waterNorm * 0.82 + 0.08 })
  const activeTypeCard = document.querySelector('.type-card.active')
  if (activeTypeCard) {
    send({ type: 'brushType', value: parseInt(activeTypeCard.dataset.type, 10) })
    send({ type: 'preset',    key:   activeTypeCard.dataset.preset })
  }
  const activeSizeCard = document.querySelector('.size-card.active')
  if (activeSizeCard) send({ type: 'brushSize', value: parseFloat(activeSizeCard.dataset.size) })
})

// ══════════════════════════════════════════════════════════════════════════
//  SEGMENTED COLOUR WHEEL
// ══════════════════════════════════════════════════════════════════════════

// 12 watercolour-inspired hues going clockwise from top
const SEGMENTS = [
  { label:'Violet',      hex:'#7C3AED', r:0.486, g:0.227, b:0.929 },
  { label:'Indigo',      hex:'#4338CA', r:0.263, g:0.220, b:0.792 },
  { label:'Blue',        hex:'#2563EB', r:0.145, g:0.388, b:0.922 },
  { label:'Sky',         hex:'#0284C7', r:0.008, g:0.518, b:0.780 },
  { label:'Teal',        hex:'#0D9488', r:0.051, g:0.580, b:0.533 },
  { label:'Green',       hex:'#16A34A', r:0.086, g:0.639, b:0.290 },
  { label:'Lime',        hex:'#65A30D', r:0.396, g:0.639, b:0.051 },
  { label:'Yellow',      hex:'#CA8A04', r:0.792, g:0.541, b:0.016 },
  { label:'Amber',       hex:'#D97706', r:0.851, g:0.467, b:0.024 },
  { label:'Orange',      hex:'#EA580C', r:0.918, g:0.345, b:0.047 },
  { label:'Rose',        hex:'#E11D48', r:0.882, g:0.114, b:0.282 },
  { label:'Pink',        hex:'#DB2777', r:0.859, g:0.153, b:0.467 },
]

const wheelCanvas = document.getElementById('color-wheel')
const wCtx        = wheelCanvas.getContext('2d')
const colorCenter = document.getElementById('color-center')

let activeSegIdx = 10  // start on Rose

function drawWheel() {
  const W   = wheelCanvas.width
  const H   = wheelCanvas.height
  const cx  = W / 2
  const cy  = H / 2
  const R   = W / 2 - 2          // outer radius
  const r   = R * 0.34            // inner hole radius
  const gap = 0.028               // gap between segments (radians)
  const n   = SEGMENTS.length
  const arc = (Math.PI * 2) / n  // angle per segment

  wCtx.clearRect(0, 0, W, H)

  SEGMENTS.forEach((seg, i) => {
    const startAngle = i * arc - Math.PI / 2 + gap / 2
    const endAngle   = startAngle + arc - gap

    wCtx.beginPath()
    wCtx.moveTo(cx + Math.cos(startAngle) * r, cy + Math.sin(startAngle) * r)
    wCtx.arc(cx, cy, R, startAngle, endAngle)
    wCtx.arc(cx, cy, r, endAngle, startAngle, true)
    wCtx.closePath()

    // active segment: slightly lighter + scaled outward via shadow
    if (i === activeSegIdx) {
      wCtx.shadowColor   = seg.hex
      wCtx.shadowBlur    = 18
      wCtx.fillStyle     = seg.hex
    } else {
      wCtx.shadowBlur    = 0
      // slightly desaturate inactive segments so active pops
      wCtx.fillStyle     = seg.hex
      wCtx.globalAlpha   = 0.82
    }
    wCtx.fill()
    wCtx.globalAlpha = 1
    wCtx.shadowBlur  = 0
  })

  // white center disc
  wCtx.beginPath()
  wCtx.arc(cx, cy, r - 1, 0, Math.PI * 2)
  wCtx.fillStyle = 'rgba(232,230,225,0.95)'
  wCtx.fill()
}

function pickSegment(e) {
  const rect = wheelCanvas.getBoundingClientRect()
  const px   = (e.clientX - rect.left) / rect.width  * wheelCanvas.width
  const py   = (e.clientY - rect.top)  / rect.height * wheelCanvas.height
  const cx   = wheelCanvas.width  / 2
  const cy   = wheelCanvas.height / 2
  const dx   = px - cx
  const dy   = py - cy
  const dist = Math.hypot(dx, dy)
  const R    = wheelCanvas.width / 2 - 2
  const r    = R * 0.34

  if (dist < r || dist > R) return  // hit center hole or outside — ignore

  const angle  = Math.atan2(dy, dx) + Math.PI / 2  // rotate so top = 0
  const norm   = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
  const idx    = Math.floor(norm / (Math.PI * 2) * SEGMENTS.length)
  const seg    = SEGMENTS[idx]
  if (!seg) return

  activeSegIdx = idx
  drawWheel()
  colorCenter.style.background = seg.hex
  document.documentElement.style.setProperty('--active-color', seg.hex)
  document.getElementById('color-name').textContent = seg.label

  // pulse animation on center
  colorCenter.style.transform = 'scale(1.18)'
  setTimeout(() => { colorCenter.style.transform = 'scale(1)' }, 160)
  colorCenter.style.transition = 'background 0.18s, transform 0.16s'

  send({ type: 'color', hex: seg.hex, r: seg.r, g: seg.g, b: seg.b })

  // If an artwork QR is showing, refresh it with the new paint colour
  if (_currentViewerUrl) _generateQR(_currentViewerUrl)
}

wheelCanvas.addEventListener('pointerdown', pickSegment)

// initial draw + center color
drawWheel()
colorCenter.style.background = SEGMENTS[activeSegIdx].hex
document.documentElement.style.setProperty('--active-color', SEGMENTS[activeSegIdx].hex)
document.getElementById('color-name').textContent = SEGMENTS[activeSegIdx].label

// ══════════════════════════════════════════════════════════════════════════
//  WATER CAPSULE
// ══════════════════════════════════════════════════════════════════════════
const capsule   = document.getElementById('water-capsule')
const waterFill = document.getElementById('water-fill')
const waterDrop = document.getElementById('water-drop')

let waterNorm   = 0.42
let dragging    = false

function applyWater(norm, broadcast = true) {
  waterNorm = Math.max(0.02, Math.min(0.98, norm))
  const pct = waterNorm * 100
  waterFill.style.height = pct + '%'
  // Use offsetHeight (CSS layout px) — getBoundingClientRect gives screen px
  // after the kiosk CSS transform, which would misposition the drop.
  const trackH = capsule.offsetHeight || 260
  const dropY  = trackH * (1 - waterNorm) - 24   // 24 = half drop height
  waterDrop.style.top  = Math.max(0, dropY) + 'px'
  waterDrop.style.left = '50%'
  waterDrop.style.transform = 'translateX(-50%)'
  waterDrop.style.position  = 'absolute'
  if (broadcast) send({ type: 'water', value: waterNorm * 0.82 + 0.08 })
}

function capsuleNorm(e) {
  const rect = capsule.getBoundingClientRect()
  return 1 - Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
}

capsule.addEventListener('pointerdown', e => {
  dragging = true
  capsule.setPointerCapture(e.pointerId)
  applyWater(capsuleNorm(e))
})
capsule.addEventListener('pointermove', e => { if (dragging) applyWater(capsuleNorm(e)) })
capsule.addEventListener('pointerup',    () => { dragging = false })
capsule.addEventListener('pointercancel',() => { dragging = false })

// Wait for layout then set initial position
requestAnimationFrame(() => applyWater(waterNorm, false))
window.addEventListener('resize',        () => applyWater(waterNorm, false))

// ══════════════════════════════════════════════════════════════════════════
//  BRUSH TYPE CARDS
// ══════════════════════════════════════════════════════════════════════════
document.querySelectorAll('.type-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.type-card').forEach(c => c.classList.remove('active'))
    card.classList.add('active')
    send({ type: 'brushType', value: parseInt(card.dataset.type, 10) })
    send({ type: 'preset',    key:   card.dataset.preset })
  })
})

// ══════════════════════════════════════════════════════════════════════════
//  BRUSH SIZE CARDS
// ══════════════════════════════════════════════════════════════════════════
document.querySelectorAll('.size-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.size-card').forEach(c => c.classList.remove('active'))
    card.classList.add('active')
    send({ type: 'brushSize', value: parseFloat(card.dataset.size) })
  })
})

// ══════════════════════════════════════════════════════════════════════════
//  DONE BUTTON
// ══════════════════════════════════════════════════════════════════════════
document.getElementById('btn-done').addEventListener('click', () => {
  showScreen('end')
  spawnConfetti()
  _resetEndScreen()
  _startAutoReset()          // begin 60 s exhibition countdown
  // Request snapshot from AR page (includes current artist name if already typed)
  const name = document.getElementById('artist-name').value.trim()
  send({ type: 'snapshot', artistName: name })
  send({ type: 'end' })
})

// ══════════════════════════════════════════════════════════════════════════
//  END SCREEN  — artwork + QR
// ══════════════════════════════════════════════════════════════════════════

/** Put end screen back to loading state before a new snapshot arrives */
function _resetEndScreen() {
  const loading = document.getElementById('artwork-loading')
  const img     = document.getElementById('artwork-preview')
  const byline  = document.getElementById('artwork-byline')
  if (loading) { loading.classList.remove('hidden') }
  if (img)     { img.classList.remove('loaded'); img.src = '' }
  if (byline)  { byline.textContent = 'your masterpiece' }
  document.getElementById('qr-loading-state').style.display = 'flex'
  document.getElementById('qr-ready-state').style.display   = 'none'
  _currentViewerUrl  = ''
  _currentArtworkUrl = ''
}

/** Called when AR sends back { type:'artwork', imageUrl, viewerUrl, artistName } */
async function _showArtwork({ imageUrl, viewerUrl, artistName }) {
  _currentViewerUrl  = viewerUrl
  _currentArtworkUrl = imageUrl

  // ── Show framed image ──────────────────────────────────────────────────
  const img     = document.getElementById('artwork-preview')
  const loading = document.getElementById('artwork-loading')
  const byline  = document.getElementById('artwork-byline')

  img.onload = () => {
    loading.classList.add('hidden')
    img.classList.add('loaded')
  }
  img.onerror = () => {
    if (loading) loading.classList.add('hidden')
    if (byline)  byline.textContent = '⚠️ Could not load artwork'
  }
  img.src = imageUrl

  // Update byline with artist name
  const name = document.getElementById('artist-name').value.trim() || artistName || ''
  if (name) byline.textContent = `by ${name}`

  // ── Generate QR code ───────────────────────────────────────────────────
  try {
    await _generateQR(viewerUrl)
  } catch (err) {
    console.error('[kiosk] QR generation failed:', err)
    // Show URL as fallback so the viewer can still be found
    const qrWait = document.getElementById('qr-loading-state')
    if (qrWait) {
      qrWait.innerHTML = `<span class="qr-wait-text" style="font-size:12px;word-break:break-all">${viewerUrl}</span>`
    }
  }
}

/** Generate (or re-generate) the QR code — uses active paint colour as dot colour */
async function _generateQR(url) {
  if (!url) return
  const canvas      = document.getElementById('qr-canvas')
  const activeHex   = SEGMENTS[activeSegIdx].hex   // live paint colour

  await QRCode.toCanvas(canvas, url, {
    width:                 220,
    margin:                1,
    errorCorrectionLevel: 'M',
    color: {
      dark:  activeHex,    // QR dots = current paint colour (cohesive!)
      light: '#F5F0EB',    // warm cream background = kiosk palette
    },
  })

  document.getElementById('qr-loading-state').style.display = 'none'
  document.getElementById('qr-ready-state').style.display   = 'flex'
}

// Update byline in real time as user types their name
document.getElementById('artist-name').addEventListener('input', () => {
  const name   = document.getElementById('artist-name').value.trim()
  const byline = document.getElementById('artwork-byline')
  if (byline) byline.textContent = name ? `by ${name}` : 'your masterpiece'
})

document.getElementById('btn-paint-again').addEventListener('click', () => {
  clearTimeout(_autoResetTimer)          // cancel the auto-reset countdown
  document.getElementById('artist-name').value = ''
  _resetEndScreen()
  showScreen('controls')
  send({ type: 'clear' })   // wipe AR canvas for the new session
  send({ type: 'start' })   // hide AR overlays, ready to paint
})

document.getElementById('btn-bye').addEventListener('click', () => {
  _goToWelcome()
})

// ── Auto-return to welcome after 60 s on end screen (exhibition mode) ─────────
let _autoResetTimer = null

function _startAutoReset() {
  clearTimeout(_autoResetTimer)
  _autoResetTimer = setTimeout(() => {
    // Only auto-reset if still on the end screen
    if (screens.end.classList.contains('active')) _goToWelcome()
  }, 60_000)
}

function _goToWelcome() {
  clearTimeout(_autoResetTimer)
  document.getElementById('artist-name').value = ''
  _resetEndScreen()
  showScreen('welcome')
  send({ type: 'reset' })   // AR: clear canvas + return to idle state
}

// ── Confetti ───────────────────────────────────────────────────────────────
const COLORS = ['#E02A3A','#1848C8','#E09A00','#12966A','#EA580C','#7C3AED']

function spawnConfetti() {
  const el = document.getElementById('end-confetti')
  el.innerHTML = ''
  for (let i = 0; i < 55; i++) {
    const p = document.createElement('div')
    p.className = 'confetti-piece'
    p.style.cssText = `
      left:${Math.random()*100}vw;
      top:-12px;
      width:${7+Math.random()*7}px;
      height:${7+Math.random()*7}px;
      background:${COLORS[Math.floor(Math.random()*COLORS.length)]};
      border-radius:${Math.random()>.5?'50%':'2px'};
      animation-delay:${(Math.random()*1.2).toFixed(2)}s;
      animation-duration:${(2.2+Math.random()*1.8).toFixed(2)}s;
    `
    el.appendChild(p)
    p.addEventListener('animationend', () => p.remove())
  }
}
