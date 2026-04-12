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
import surfaceVert   from './shaders/surface.vert.glsl?raw';
import surfaceFrag   from './shaders/surface.frag.glsl?raw';

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

    // ── Scene ────────────────────────────────────────────────────────────────
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xfff5e1);  // warm cream
    this.scene.fog = new THREE.FogExp2(0xfff5e1, 0.010);

    // ── Kid-friendly lighting: warm hemisphere + soft key ───────────────────
    this.scene.add(new THREE.HemisphereLight(0xfff5e1, 0xf0d8a0, 2.5));

    const key = new THREE.DirectionalLight(0xffffff, 1.2);
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
  _makePaintMat(baseColor, paintRect) {
    return new THREE.ShaderMaterial({
      vertexShader:   surfaceVert,
      fragmentShader: surfaceFrag,
      uniforms: {
        tPaint:       { value: this.gpgpu.outputTexture },
        tVelocity:    { value: this.gpgpu.velOutputTexture },
        tSubstrate:   { value: this.gpgpu.substrateRT.texture },
        u_lightDir:   { value: this._lightDirVec },
        u_baseColor:  { value: new THREE.Color(baseColor) },
        u_time:       { value: 0.0 },
        u_screenSize: { value: this._screenSize },
        u_paintUvOffset: { value: paintRect.offset.clone() },
        u_paintUvScale:  { value: paintRect.scale.clone() },
        u_substrateTexelSize: { value: this.gpgpu.substrateTexelSize },
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
      front: rectAt(0, 0),
      back:  rectAt(1, 0),
      left:  rectAt(2, 0),
      right: rectAt(0, 1),
      floor: rectAt(1, 1),
    };
  }

  // ── Room — all 5 surfaces paintable ─────────────────────────────────────────
  _buildRoom() {
    const W = 28, H = 12, D = 30;

    const panels = [
      { key:'front', p:[0, H/2, -D/2], r:[0,  0,          0], w:W, h:H, c:'#fdf8f0' }, // front wall
      { key:'back',  p:[0, H/2,  D/2], r:[0,  Math.PI,    0], w:W, h:H, c:'#faf5ec' }, // back wall
      { key:'left',  p:[-W/2,H/2, 0],  r:[0,  Math.PI/2,  0], w:D, h:H, c:'#f8f3ea' }, // left wall
      { key:'right', p:[ W/2,H/2, 0],  r:[0, -Math.PI/2,  0], w:D, h:H, c:'#f8f3ea' }, // right wall
      { key:'floor', p:[0, 0, 0],      r:[-Math.PI/2, 0,  0], w:W, h:D, c:'#f2ede4' }, // floor
    ];

    panels.forEach(({ key, p, r, w, h, c }) => {
      const paintRect = this._paintAtlasRects[key];
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h, 40, 40),
        this._makePaintMat(c, paintRect)
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

    // Ceiling — visual only, warm cream
    const ceil = new THREE.Mesh(
      new THREE.PlaneGeometry(W, D),
      new THREE.MeshStandardMaterial({ color: 0xfff8f0, roughness: 1, metalness: 0 })
    );
    ceil.position.y = H;
    ceil.rotation.x = Math.PI / 2;
    this.scene.add(ceil);

    this._addCeilingGrid(W, D, H);
    this._addWindowPanels(W, H, D);
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
    const windowMat = new THREE.MeshStandardMaterial({
      color: 0xffeedd,
      emissive: new THREE.Color(0xffd8a0),
      emissiveIntensity: 0.5,
      roughness: 0.2, metalness: 0,
    });
    [
      { x: -W/2 + 0.01, z: -4, ry:  Math.PI/2 },
      { x: -W/2 + 0.01, z:  4, ry:  Math.PI/2 },
      { x:  W/2 - 0.01, z: -4, ry: -Math.PI/2 },
      { x:  W/2 - 0.01, z:  4, ry: -Math.PI/2 },
    ].forEach(({ x, z, ry }) => {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(3.5, 4.5), windowMat);
      win.position.set(x, H/2 + 0.5, z);
      win.rotation.y = ry;
      this.scene.add(win);
      const wLight = new THREE.PointLight(0xffe8c0, 0.8, 18);
      wLight.position.set(x * 0.85, H/2 + 0.5, z);
      this.scene.add(wLight);
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

  render() { this.composer.render(); }

  _setupComposer() {
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new ShaderPass(GammaCorrectionShader));
    // No outline pass — colours merge naturally via K-M absorption (Tint style).
  }

  _onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this._screenSize.set(w, h);
  }
}
