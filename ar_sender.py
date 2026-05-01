#!/usr/bin/env python3
"""
Spatiality AR  →  MadMapper bridge
────────────────────────────────────────────────────────────────────────────────
Architecture
  Three.js browser  ──WebSocket──►  ar_sender.py  ──►  Spout2 / Syphon  ──►  MadMapper

Install (run ONCE — pick your OS)
  Windows:
    pip install SpoutGL PyOpenGL PyOpenGL_accelerate glfw websockets numpy Pillow

  macOS:
    pip install syphon-python pyobjc-framework-Metal pyobjc-framework-Cocoa
                websockets numpy Pillow

Usage
  python ar_sender.py                        # defaults: 1920×1080, port 9876, 60 fps
  python ar_sender.py --width 1280 --height 720 --fps 30
  python ar_sender.py --alpha                # transparent-background mode

MadMapper
  Media ▸ Sources ▸ Syphon / Spout  →  "Spatiality AR"
"""

import argparse
import asyncio
import io
import platform
import sys
import time
import logging
import numpy as np

logging.basicConfig(level=logging.INFO, format='%(asctime)s  [ar_sender]  %(message)s',
                    datefmt='%H:%M:%S')
log = logging.getLogger()

# ── CLI ───────────────────────────────────────────────────────────────────────
ap = argparse.ArgumentParser(description='Spatiality AR → Spout/Syphon relay')
ap.add_argument('--port',   type=int,   default=9876,  help='WebSocket listen port')
ap.add_argument('--width',  type=int,   default=1920)
ap.add_argument('--height', type=int,   default=1080)
ap.add_argument('--fps',    type=int,   default=60,    help='Spout/Syphon send rate cap')
ap.add_argument('--alpha',  action='store_true',       help='RGBA transparent-background mode')
ap.add_argument('--name',   default='Spatiality AR',   help='Sender/server display name')
args = ap.parse_args()

W, H          = args.width, args.height
SENDER_NAME   = args.name
EXPECTED_BYTES = W * H * 4   # RGBA uint8

IS_WIN = platform.system() == 'Windows'
IS_MAC = platform.system() == 'Darwin'


# ══════════════════════════════════════════════════════════════════════════════
#  WINDOWS — Spout2
# ══════════════════════════════════════════════════════════════════════════════
class _SpoutSenderWindows:
    """SpoutGL + GLFW hidden-window OpenGL context."""

    def __init__(self, name: str, w: int, h: int):
        try:
            import glfw
            from OpenGL import GL
            from SpoutGL import SpoutSender
        except ImportError as exc:
            sys.exit(
                f'\n[ERROR] Missing package: {exc}\n'
                'Run:  pip install SpoutGL PyOpenGL PyOpenGL_accelerate glfw\n'
            )

        self._gl   = GL
        self._glfw = glfw
        self._w    = w
        self._h    = h

        # Hidden GLFW window (needed for an OpenGL context) ───────────────────
        if not glfw.init():
            sys.exit('[ERROR] GLFW init failed')
        glfw.window_hint(glfw.VISIBLE,   glfw.FALSE)
        glfw.window_hint(glfw.DECORATED, glfw.FALSE)
        self._win = glfw.create_window(1, 1, 'ar_sender_ctx', None, None)
        if not self._win:
            sys.exit('[ERROR] Could not create GLFW window')
        glfw.make_context_current(self._win)
        log.info('OpenGL context created (hidden GLFW window)')

        # Spout sender ────────────────────────────────────────────────────────
        self._sender = SpoutSender()
        if not self._sender.CreateSender(name, w, h, 0):
            sys.exit(f'[ERROR] Spout CreateSender failed for "{name}"')
        log.info(f'Spout sender "{name}" ready  ({w}×{h} RGBA)')

    def send(self, frame: np.ndarray):
        """frame: np.ndarray (H, W, 4) uint8"""
        self._glfw.make_context_current(self._win)
        # WebGL readPixels is bottom-to-top — flip before sending
        flipped = np.ascontiguousarray(frame[::-1])
        self._sender.SendImage(flipped.tobytes(), self._w, self._h,
                               self._gl.GL_RGBA, False)
        self._sender.HoldFps(args.fps)

    def release(self):
        self._sender.ReleaseSender()
        self._glfw.terminate()
        log.info('Spout sender released')


# ══════════════════════════════════════════════════════════════════════════════
#  macOS — Syphon Metal
# ══════════════════════════════════════════════════════════════════════════════
class _SyphonSenderMacOS:
    """syphon-python Metal server."""

    def __init__(self, name: str, w: int, h: int):
        try:
            import Metal
            import syphon
        except ImportError as exc:
            sys.exit(
                f'\n[ERROR] Missing package: {exc}\n'
                'Run:  pip install syphon-python pyobjc-framework-Metal '
                'pyobjc-framework-Cocoa\n'
            )

        self._Metal = Metal
        self._w     = w
        self._h     = h

        self._device = Metal.MTLCreateSystemDefaultDevice()
        if not self._device:
            sys.exit('[ERROR] No Metal GPU device found')

        self._server = syphon.SyphonMetalServer(name, self._device)
        self._cmdq   = self._device.newCommandQueue()

        # Pre-allocate persistent Metal texture (RGBA8) ───────────────────────
        desc = Metal.MTLTextureDescriptor.texture2DDescriptorWithPixelFormat_width_height_mipmapped_(
            Metal.MTLPixelFormatRGBA8Unorm, w, h, False
        )
        desc.setUsage_(
            Metal.MTLTextureUsageShaderRead | Metal.MTLTextureUsageRenderTarget
        )
        self._tex = self._device.newTextureWithDescriptor_(desc)
        log.info(f'Syphon server "{name}" ready  ({w}×{h} RGBA)')

    def send(self, frame: np.ndarray):
        Metal = self._Metal
        # Flip Y
        flipped = np.ascontiguousarray(frame[::-1])
        region  = Metal.MTLRegionMake2D(0, 0, self._w, self._h)
        self._tex.replaceRegion_mipmapLevel_withBytes_bytesPerRow_(
            region, 0, flipped.tobytes(), self._w * 4
        )
        self._server.publishFrameTexture_onCommandQueue_imageRegion_textureDimensions_flipped_(
            self._tex,
            self._cmdq,
            Metal.MTLRegionMake2D(0, 0, self._w, self._h),
            Metal.MTLSizeMake(self._w, self._h, 1),
            False,
        )

    def release(self):
        self._server.stop()
        log.info('Syphon server stopped')


# ── Instantiate platform sender ───────────────────────────────────────────────
if IS_WIN:
    _sender = _SpoutSenderWindows(SENDER_NAME, W, H)
elif IS_MAC:
    _sender = _SyphonSenderMacOS(SENDER_NAME, W, H)
else:
    sys.exit('[ERROR] Spout/Syphon is only supported on Windows and macOS.')


# ── FPS counter ───────────────────────────────────────────────────────────────
_fc, _t0 = 0, time.perf_counter()

def _tick():
    global _fc, _t0
    _fc += 1
    now = time.perf_counter()
    if now - _t0 >= 3.0:
        log.info(f'Throughput: {_fc / (now - _t0):.1f} fps  ({W}×{H} RGBA)')
        _fc, _t0 = 0, now


# ── WebSocket server ──────────────────────────────────────────────────────────
try:
    import websockets
except ImportError:
    sys.exit('[ERROR] pip install websockets')


async def _on_client(ws):
    addr = ws.remote_address
    log.info(f'Browser connected:  {addr}')

    async for msg in ws:

        # ── Protocol A: raw RGBA binary (fastest, preferred) ──────────────────
        if isinstance(msg, bytes):
            if len(msg) != EXPECTED_BYTES:
                log.warning(f'Frame size mismatch: got {len(msg)}, expected {EXPECTED_BYTES}')
                continue
            frame = np.frombuffer(msg, dtype=np.uint8).reshape(H, W, 4).copy()
            _sender.send(frame)
            _tick()

        # ── Protocol B: PNG data-URL (fallback, lower framerate) ──────────────
        elif isinstance(msg, str) and msg.startswith('data:image/'):
            try:
                from PIL import Image
                import base64
                _, b64 = msg.split(',', 1)
                img   = Image.open(io.BytesIO(base64.b64decode(b64))).convert('RGBA')
                frame = np.array(img.resize((W, H), Image.LANCZOS), dtype=np.uint8)
                _sender.send(frame)
                _tick()
            except Exception as e:
                log.error(f'PNG decode error: {e}')

    log.info(f'Browser disconnected: {addr}')


async def _serve():
    log.info('─' * 60)
    log.info(f'  Spatiality AR  →  {"Spout2" if IS_WIN else "Syphon Metal"}')
    log.info(f'  Resolution : {W} × {H}')
    log.info(f'  Alpha mode : {args.alpha}')
    log.info(f'  WebSocket  : ws://0.0.0.0:{args.port}')
    log.info(f'  MadMapper  : Media › Sources › Syphon/Spout → "{SENDER_NAME}"')
    log.info('─' * 60)

    async with websockets.serve(
        _on_client,
        host='0.0.0.0',
        port=args.port,
        max_size=EXPECTED_BYTES + 8192,  # headroom for framing
        ping_interval=None,              # disable auto-ping; latency matters more
    ):
        await asyncio.Future()           # run forever


if __name__ == '__main__':
    try:
        asyncio.run(_serve())
    except KeyboardInterrupt:
        _sender.release()
        log.info('ar_sender stopped.')
