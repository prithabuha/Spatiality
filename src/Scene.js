/**
 * Scene — Cream gallery studio.
 *
 * Kid-friendly mode:
 *   • Warm HemisphereLight (no harsh directional shadows)
 *   • Cream background #FFF5E1
 *   • 3 floating colour-bucket spheres (Red / Blue / Yellow) on floor
 *     — touching one with the index finger switches active paint colour
 *   • All walls + floor remain paintable via UV-space GPGPU lookup
 */

import * as THREE from 'three';
import { EffectComposer }        from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass }            from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass }            from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { GammaCorrectionShader } from 'three/examples/jsm/shaders/GammaCorrectionShader.js';
import surfaceVert      from './shaders/surface.vert.glsl?raw';
import surfaceFrag      from './shaders/surface.frag.glsl?raw';
import toonOutlineFrag  from './shaders/toon_outline.frag.glsl?raw';
import { buildPaperTexture }     from './PaperTexture.js';

export class Scene {
  constructor(renderer, gpgpu) {
    this.gpgpu    = gpgpu;
    this.renderer = renderer;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type    = THREE.PCFSoftShadowMap;

    // ── Camera ──────────────────────────────────────────────────────────────
    this.camera = new THREE.PerspectiveCamera(
      52, window.innerWidth / window.innerHeight, 0.1, 200
    );
    this.camera.position.set(0, 3.0, 10.0);
    this.camera.lookAt(0, 3.0, 0);

    // ── Paper texture (generated once, shared across all surfaces) ──────────
    // Build at 1024px — high enough for 4K projection, low enough to not stall.
    console.time('[Paper] texture generate');
    this._paperTex = buildPaperTexture(1024);
    console.timeEnd('[Paper] texture generate');

    // ── Scene ────────────────────────────────────────────────────────────────
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xfbfffa);  // soft mint white
    this.scene.fog = new THREE.FogExp2(0xfbfffa, 0.004);  // matching fog

    // ── Room lighting — bright gallery day ──────────────────────────────────
    // Sky: warm daylight white.  Ground: soft warm bounce from warm floors.
    this.scene.add(new THREE.HemisphereLight(0xfff8f0, 0xd8c8a0, 4.2));

    const key = new THREE.DirectionalLight(0xfffaf0, 2.0);
    key.position.set(0, 14, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near  = 0.1;
    key.shadow.camera.far   = 60;
    key.shadow.camera.left  = key.shadow.camera.bottom = -18;
    key.shadow.camera.right = key.shadow.camera.top    =  18;
    key.shadow.bias = -0.001;
    this.scene.add(key);

    // ── Build ────────────────────────────────────────────────────────────────
    this._paintMeshes = [];
    this._lightDirVec = new THREE.Vector3(0, 14, 4).normalize();
    this._screenSize  = new THREE.Vector2(window.innerWidth, window.innerHeight);
    this._paintAtlasRects = this._createPaintAtlasRects();

    this._colorBuckets = [];

    this._buildRoom();
    this._addColorBuckets();
    this._setupComposer();

    this.raycaster = new THREE.Raycaster();
    this._rayNDC = new THREE.Vector2();
    this._bucketHits = [];
    this._surfaceHits = [];
    window.addEventListener('resize', this._onResize.bind(this));
  }

  // ── Paintable material ───────────────────────────────────────────────────────
  _makePaintMat(baseColor, paintRect, paperTexScale) {
    return new THREE.ShaderMaterial({
      vertexShader:   surfaceVert,
      fragmentShader: surfaceFrag,
      uniforms: {
        tPaint:       { value: this.gpgpu.outputTexture },
        tVelocity:    { value: this.gpgpu.velOutputTexture },
        tSubstrate:   { value: this.gpgpu.substrateRT.texture },
        u_paperTex:   { value: this._paperTex },
        u_lightDir:   { value: this._lightDirVec },
        u_baseColor:  { value: new THREE.Color(baseColor) },
        u_time:       { value: 0.0 },
        u_screenSize: { value: this._screenSize },
        u_paintUvOffset:      { value: paintRect.offset.clone() },
        u_paintUvScale:       { value: paintRect.scale.clone() },
        u_substrateTexelSize: { value: this.gpgpu.substrateTexelSize },
        u_paintTexelSize:     { value: this.gpgpu.paintTexelSize },
        u_paperTexScale:      { value: paperTexScale.clone() },
        u_borderBlur:         { value: 0.15 },
      },
    });
  }

  _createPaintAtlasRects() {
    const cols = 3;
    const rows = 2;
    const gap  = 0.04;
    const cellW = (1.0 - gap * (cols + 1)) / cols;
    const cellH = (1.0 - gap * (rows + 1)) / rows;

    const rectAt = (col, row) => ({
      offset: new THREE.Vector2(gap + col * (cellW + gap), gap + row * (cellH + gap)),
      scale:  new THREE.Vector2(cellW, cellH),
    });

    return {
      front:   rectAt(0, 0),
      back:    rectAt(1, 0),
      left:    rectAt(2, 0),
      right:   rectAt(0, 1),
      floor:   rectAt(1, 1),
      ceiling: rectAt(2, 1),   // ← was empty slot; now paintable canvas
    };
  }

  // ── Room — all 6 surfaces paintable (walls × 4, floor, ceiling) ─────────────
  _buildRoom() {
    const W = 28, H = 12, D = 30;

    // paperTexScale: how many times the 1024px texture repeats on each surface
    // Larger surface → more repeats so fibres stay a physical size (~2cm on paper)
    const panels = [
      { key:'front',   p:[0, H/2, -D/2], r:[0,           0, 0], w:W, h:H, c:'#f8f8f8', pts: new THREE.Vector2(W * 0.45, H * 0.45) },
      { key:'back',    p:[0, H/2,  D/2], r:[0,    Math.PI, 0], w:W, h:H, c:'#f7f7f7', pts: new THREE.Vector2(W * 0.45, H * 0.45) },
      { key:'left',    p:[-W/2,H/2, 0],  r:[0,  Math.PI/2, 0], w:D, h:H, c:'#f7f7f7', pts: new THREE.Vector2(D * 0.45, H * 0.45) },
      { key:'right',   p:[ W/2,H/2, 0],  r:[0, -Math.PI/2, 0], w:D, h:H, c:'#f7f7f7', pts: new THREE.Vector2(D * 0.45, H * 0.45) },
      { key:'floor',   p:[0, 0,   0],    r:[-Math.PI/2, 0, 0], w:W, h:D, c:'#f5f5f5', pts: new THREE.Vector2(W * 0.45, D * 0.45) },
      // Ceiling — same atlas slot (2,1), normal faces DOWN so it is visible
      // from inside the room and paintable via hand gestures pointing upward.
      { key:'ceiling', p:[0, H,   0],    r:[ Math.PI/2, 0, 0], w:W, h:D, c:'#f8f8f8', pts: new THREE.Vector2(W * 0.45, D * 0.45) },
    ];

    panels.forEach(({ key, p, r, w, h, c, pts }) => {
      const paintRect = this._paintAtlasRects[key];
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h, 60, 60),
        this._makePaintMat(c, paintRect, pts)
      );
      mesh.position.set(...p);
      mesh.rotation.set(...r);
      mesh.receiveShadow = true;
      mesh.userData.surfaceAspect = h / w;
      mesh.userData.surfaceId = key;
      mesh.userData.paintRect = paintRect;
      this.scene.add(mesh);
      this._paintMeshes.push(mesh);
    });

    // Ceiling is now the paintable panel added above — no separate mesh needed.
    this._addCeilingGrid(W, D, H);
    this._addWindowPanels(W, H, D);
    this._addCeilingLights(W, H, D);
    this._addTrim(W, H, D);
  }

  _addCeilingGrid(W, D, H) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xe8dfd0, roughness: 1, metalness: 0 });
    for (let x = -W/2; x <= W/2; x += 2.5) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.02, D), mat);
      b.position.set(x, H - 0.01, 0);
      this.scene.add(b);
    }
    for (let z = -D/2; z <= D/2; z += 2.5) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(W, 0.02, 0.04), mat);
      b.position.set(0, H - 0.01, z);
      this.scene.add(b);
    }
  }

  _addWindowPanels(W, H, D) {
    // ── 3-D window with frame reveal + sill ─────────────────────────────────
    // Each window is a THREE.Group containing:
    //   • Glass pane  — transparent emissive (bright daylight)
    //   • Mullions    — 1 horizontal + 2 vertical crossbars (6-pane grid)
    //   • Frame top + two sides — BoxGeometry panels that protrude FRAME_D into
    //     the room (local +Z in group space), simulating wall thickness / reveal.
    //   • Sill        — wider, deeper bottom ledge for realism.
    //
    // Group rotation convention:
    //   ry = +π/2  → left  wall: local +Z maps to world +X (into room) ✓
    //   ry = -π/2  → right wall: local +Z maps to world −X (into room) ✓
    // So all geometry offsets in local +Z work for both walls unchanged.

    const WIN_W  = 3.8;    // glass width
    const WIN_H  = 5.0;    // glass height
    const FRAME_W = 0.14;  // frame border width
    const FRAME_D = 0.52;  // reveal depth  ← wall thickness visual
    const SILL_H  = 0.15;  // sill height
    const SILL_D  = 0.75;  // sill depth (sticks further into room than frame)
    const MULL    = 0.06;  // mullion thickness

    const glassMat = new THREE.MeshStandardMaterial({
      color:             new THREE.Color(0xffffff),   // white / clear
      emissive:          new THREE.Color(0xffffff),   // pure white daylight
      emissiveIntensity: 1.8,
      transparent: true,
      opacity:     0.55,
      roughness:   0.02,
      metalness:   0.05,
      side: THREE.FrontSide,
    });
    const frameMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0xffffff), roughness: 0.70, metalness: 0.0,
    });
    const mullMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0xffffff), roughness: 0.70, metalness: 0.0,
    });

    const configs = [
      { cx: -W/2, cz: -4, ry:  Math.PI / 2 },
      { cx: -W/2, cz:  4, ry:  Math.PI / 2 },
      { cx:  W/2, cz: -4, ry: -Math.PI / 2 },
      { cx:  W/2, cz:  4, ry: -Math.PI / 2 },
    ];

    configs.forEach(({ cx, cz, ry }) => {
      const cy = H / 2 + 0.8;
      const grp = new THREE.Group();
      grp.position.set(cx, cy, cz);
      grp.rotation.y = ry;
      this.scene.add(grp);

      const add = (geo, mat, px = 0, py = 0, pz = 0) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(px, py, pz);
        grp.add(m);
        return m;
      };

      // Glass (sits on wall surface, faces into room via group rotation)
      add(new THREE.PlaneGeometry(WIN_W, WIN_H), glassMat, 0, 0, 0.02);

      // Mullions — 1 horizontal + 2 vertical (creates 6 panes: 3×2)
      add(new THREE.BoxGeometry(WIN_W,  MULL, MULL), mullMat,  0,        0, 0.04);
      add(new THREE.BoxGeometry(MULL, WIN_H,  MULL), mullMat, -WIN_W/3,  0, 0.04);
      add(new THREE.BoxGeometry(MULL, WIN_H,  MULL), mullMat,  WIN_W/3,  0, 0.04);

      // Frame reveal — top
      add(new THREE.BoxGeometry(WIN_W + 2*FRAME_W, FRAME_W, FRAME_D),
          frameMat, 0,  WIN_H/2 + FRAME_W/2, FRAME_D/2);
      // Frame reveal — left side
      add(new THREE.BoxGeometry(FRAME_W, WIN_H + FRAME_W, FRAME_D),
          frameMat, -WIN_W/2 - FRAME_W/2, 0, FRAME_D/2);
      // Frame reveal — right side
      add(new THREE.BoxGeometry(FRAME_W, WIN_H + FRAME_W, FRAME_D),
          frameMat,  WIN_W/2 + FRAME_W/2, 0, FRAME_D/2);
      // Sill — bottom ledge, wider + deeper than the frame sides
      add(new THREE.BoxGeometry(WIN_W + 2*FRAME_W + 0.28, SILL_H, SILL_D),
          frameMat, 0, -WIN_H/2 - SILL_H/2, SILL_D/2);

      // ── Window sunlight (outside the room, in local −Z = exterior) ────────
      const extOff = new THREE.Vector3(0, 1.0, -2.5).applyEuler(grp.rotation);
      const wLight = new THREE.PointLight(0xfffae8, 4.0, 35);
      wLight.position.set(cx + extOff.x, cy + extOff.y, cz + extOff.z);
      this.scene.add(wLight);

      // ── Interior bloom — warm light spilling into the room ────────────────
      const intOff = new THREE.Vector3(0, 0, 2.5).applyEuler(grp.rotation);
      const iLight = new THREE.PointLight(0xffe4a0, 1.6, 18);
      iLight.position.set(cx + intOff.x, cy + intOff.y, cz + intOff.z);
      this.scene.add(iLight);
    });
  }

  // ── Ceiling downlights — gallery-style track fixtures ────────────────────
  _addCeilingLights(W, H, D) {
    const intensity = 2.8;
    const range     = 14;
    const color     = 0xfff8f0;  // warm white
    const positions = [
      [-W * 0.28, H - 0.5,  -D * 0.22],
      [ W * 0.28, H - 0.5,  -D * 0.22],
      [ 0,        H - 0.5,   0       ],
      [-W * 0.28, H - 0.5,   D * 0.22],
      [ W * 0.28, H - 0.5,   D * 0.22],
    ];
    positions.forEach(([x, y, z]) => {
      const cl = new THREE.PointLight(color, intensity, range);
      cl.position.set(x, y, z);
      this.scene.add(cl);
    });
  }

  // ── Baseboard + crown trim — adds architectural scale/realism ─────────────
  _addTrim(W, H, D) {
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0xece7e0), roughness: 0.75, metalness: 0,
    });
    const bd = 0.04;  // protrusion depth from wall
    const bh = 0.22;  // baseboard height
    const ch = 0.14;  // crown height

    // Baseboard — runs along base of all four walls
    const baseboards = [
      { s:[W,    bh, bd    ], p:[0,        bh/2,     -D/2 + bd/2] },  // front
      { s:[W,    bh, bd    ], p:[0,        bh/2,      D/2 - bd/2] },  // back
      { s:[bd,   bh, D     ], p:[-W/2+bd/2,bh/2,     0          ] },  // left
      { s:[bd,   bh, D     ], p:[ W/2-bd/2,bh/2,     0          ] },  // right
    ];
    // Crown moulding — runs along top of all four walls
    const crowns = [
      { s:[W,    ch, bd    ], p:[0,        H - ch/2, -D/2 + bd/2] },
      { s:[W,    ch, bd    ], p:[0,        H - ch/2,  D/2 - bd/2] },
      { s:[bd,   ch, D     ], p:[-W/2+bd/2,H - ch/2,  0         ] },
      { s:[bd,   ch, D     ], p:[ W/2-bd/2,H - ch/2,  0         ] },
    ];

    [...baseboards, ...crowns].forEach(({ s, p }) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(...s), mat);
      m.position.set(...p);
      this.scene.add(m);
    });
  }

  // ── Colour bucket spheres ────────────────────────────────────────────────────
  // Three large floating spheres on the floor. Touching one with the finger
  // switches the active paint colour and triggers a firework burst.
  _addColorBuckets() {
    const buckets = [
      // Quinacridone Rose — warm pinkish-red, classic watercolour primary
      { x: -5.5, color: 0xd93060, rgb: new THREE.Color(0.85, 0.19, 0.38), name: 'Rose'   },
      // French Ultramarine — deep granulating blue, most popular WC blue
      { x:  0.0, color: 0x1a3bbf, rgb: new THREE.Color(0.10, 0.23, 0.75), name: 'Blue'   },
      // Hansa Yellow Medium — transparent, clean mixing yellow
      { x:  5.5, color: 0xf5c800, rgb: new THREE.Color(0.96, 0.78, 0.02), name: 'Yellow' },
    ];

    buckets.forEach(b => {
      // Glowing sphere
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(1.1, 48, 48),
        new THREE.MeshStandardMaterial({
          color:     b.color,
          roughness: 0.25,
          metalness: 0.05,
          emissive:  new THREE.Color(b.color).multiplyScalar(0.3),
        })
      );
      sphere.position.set(b.x, 1.2, 5.5);
      sphere.castShadow  = true;
      sphere.receiveShadow = true;
      sphere.userData.paintColor = b.rgb;
      sphere.userData.name       = b.name;
      this.scene.add(sphere);
      this._colorBuckets.push(sphere);

      // Point light inside each sphere for inner glow
      const glow = new THREE.PointLight(b.color, 1.8, 6.0);
      glow.position.copy(sphere.position);
      this.scene.add(glow);
      sphere.userData.glowLight = glow;
    });
  }

  // Animate bucket spheres — bob up/down + rotate slowly
  updateBuckets(time) {
    this._colorBuckets.forEach((sphere, i) => {
      sphere.position.y = 1.2 + Math.sin(time * 1.4 + i * 2.1) * 0.30;
      sphere.rotation.y = time * 0.55 + i * 1.2;
      // Sync inner glow light
      if (sphere.userData.glowLight) {
        sphere.userData.glowLight.position.copy(sphere.position);
      }
    });
  }

  // Hide or show the floating 3D colour-bucket spheres + their glow lights.
  // Call setBucketsVisible(false) when DiegeticUI takes over colour selection.
  setBucketsVisible(visible) {
    this._colorBuckets.forEach(sphere => {
      sphere.visible = visible;
      if (sphere.userData.glowLight) {
        sphere.userData.glowLight.visible = visible;
      }
    });
  }

  // Returns { color, sphere } of the bucket hit by screen-pos ray, or null.
  getColorBucketHit(normX, normY) {
    this._rayNDC.set(normX * 2.0 - 1.0, -normY * 2.0 + 1.0);
    this.raycaster.setFromCamera(this._rayNDC, this.camera);
    const hits = this.raycaster.intersectObjects(this._colorBuckets, false, this._bucketHits);
    if (hits.length === 0) {
      this._bucketHits.length = 0;
      return null;
    }
    const sphere = hits[0].object;
    const color  = sphere.userData.paintColor;
    this._bucketHits.length = 0;
    return { color, sphere };
  }

  // Trigger expanding CSS ripple rings centred on the sphere's screen position.
  // Creates 4 staggered rings that fade and scale outward — kid-friendly "pop".
  triggerOrbRipple(sphere) {
    // Project 3D sphere position → 2D screen coords
    const worldPos = sphere.position.clone();
    worldPos.project(this.camera);
    const sx = (worldPos.x *  0.5 + 0.5) * window.innerWidth;
    const sy = (-worldPos.y * 0.5 + 0.5) * window.innerHeight;
    const hex = '#' + sphere.userData.paintColor.getHexString();

    const RING_COUNT = 4;
    for (let i = 0; i < RING_COUNT; i++) {
      const ring = document.createElement('div');
      ring.className = 'orb-ripple';
      ring.style.left  = sx + 'px';
      ring.style.top   = sy + 'px';
      ring.style.color = hex;    // border-color inherits from CSS color
      ring.style.animationDelay = (i * 0.13) + 's';
      document.body.appendChild(ring);
      // Remove after animation completes
      setTimeout(() => ring.remove(), 900 + i * 130);
    }
  }

  // ── Raycast screen position → surface UV + aspect ratio ────────────────────
  getHitUV(normX, normY) {
    this._rayNDC.set(normX * 2.0 - 1.0, -normY * 2.0 + 1.0);
    this.raycaster.setFromCamera(this._rayNDC, this.camera);
    const hits = this.raycaster.intersectObjects(this._paintMeshes, false, this._surfaceHits);
    if (hits.length === 0 || !hits[0].uv) {
      this._surfaceHits.length = 0;
      return null;
    }
    const uv       = hits[0].uv;
    const hitObj   = hits[0].object;
    const rect     = hitObj.userData.paintRect;
    const atlasU   = rect.offset.x + uv.x * rect.scale.x;
    const atlasV   = rect.offset.y + uv.y * rect.scale.y;
    const aspect   = hitObj.userData.surfaceAspect ?? 1.0;
    const surfaceId = hitObj.userData.surfaceId ?? 'unknown';
    this._surfaceHits.length = 0;
    return { u: atlasU, v: atlasV, surfaceAspect: aspect, surfaceId };
  }

  // ── Per-frame ────────────────────────────────────────────────────────────────
  updatePaintTexture(dt) {
    for (const mesh of this._paintMeshes) {
      mesh.material.uniforms.tPaint.value    = this.gpgpu.outputTexture;
      mesh.material.uniforms.tVelocity.value = this.gpgpu.velOutputTexture;
      mesh.material.uniforms.u_time.value   += dt;
    }
  }

  // Set a uniform on every paint surface — used by God Mode sliders
  setPaintUniform(name, value) {
    for (const mesh of this._paintMeshes) {
      if (mesh.material.uniforms[name] !== undefined) {
        mesh.material.uniforms[name].value = value;
      }
    }
  }

  render() { this.composer.render(); }

  _setupComposer() {
    const w = window.innerWidth, h = window.innerHeight;
    this.composer = new EffectComposer(this.renderer);

    // ── Attach a depth texture to the first render target so RenderPass
    //    writes real per-pixel depth we can read in the ToonOutline shader.
    //    Paint strokes lie on flat geometry → zero depth gradient → no edge.
    //    Room corners / window frames have sharp depth steps → outline. ────────
    this.composer.renderTarget1.depthTexture = new THREE.DepthTexture(w, h);
    this.composer.renderTarget1.depthTexture.type = THREE.UnsignedShortType;

    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new ShaderPass(GammaCorrectionShader));

    // ── Toon outline — depth-based 1 px Sobel ────────────────────────────────
    const ToonShader = {
      uniforms: {
        tDiffuse:     { value: null },
        tDepth:       { value: this.composer.renderTarget1.depthTexture },
        u_resolution: { value: new THREE.Vector2(w, h) },
        u_near:       { value: this.camera.near },
        u_far:        { value: this.camera.far },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: toonOutlineFrag,
    };
    this._toonPass = new ShaderPass(ToonShader);
    this.composer.addPass(this._toonPass);
  }

  // ── 4-wall immersive projection ───────────────────────────────────────────────
  // Positions the camera at the room centre looking at the requested wall.
  // Call once after construction:  scene.setWallCamera('front')
  //
  // wall  : 'front' | 'back' | 'left' | 'right'
  // fov   : vertical field-of-view in degrees (default 80 — adjust to match your
  //         projector's throw ratio; wider = more of the wall is visible)
  //
  // Room constants (must match _buildRoom): W=28, H=12, D=30
  setWallCamera (wall, fov = 80) {
    const W = 28, H = 12, D = 30

    // Eye sits at room centre, slightly below mid-height (feels natural)
    const EYE_Y  = H * 0.44   // ≈ 5.3 units

    const VIEWS = {
      front: { target: new THREE.Vector3(  0,     EYE_Y, -D / 2) },
      back:  { target: new THREE.Vector3(  0,     EYE_Y,  D / 2) },
      left:  { target: new THREE.Vector3(-W / 2,  EYE_Y,  0    ) },
      right: { target: new THREE.Vector3( W / 2,  EYE_Y,  0    ) },
    }

    const view = VIEWS[wall]
    if (!view) {
      console.warn(`[Scene] Unknown wall "${wall}". Use front/back/left/right.`)
      return
    }

    this.camera.position.set(0, EYE_Y, 0)
    this.camera.lookAt(view.target)
    this.camera.fov = fov
    this.camera.updateProjectionMatrix()

    // Remove fog — makes distant walls in other views look faded
    this.scene.fog = null

    console.info(`[Scene] Wall camera: ${wall}  fov=${fov}°  eye=(0, ${EYE_Y.toFixed(1)}, 0)`)
  }

  _onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this._screenSize.set(w, h);
    if (this._toonPass) this._toonPass.uniforms.u_resolution.value.set(w, h);
  }
}
