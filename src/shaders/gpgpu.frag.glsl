/**
 * Watercolor GPGPU — ping-pong simulation with gravity drips + bloom.
 *
 * State (RGBA float):
 *   rgb = pigment colour × density  (premultiplied)
 *   a   = pigment density            (0 = blank, 1 = saturated)
 *
 * Key effects:
 *   • Gaussian spread during wet phase
 *   • Gravity drip: paint flows downward when wet
 *   • Edge accumulation: pigment pools at wet/dry boundary
 *   • Wet-on-wet bloom (toggle)
 *   • Permanent when dry — never fades
 */

precision highp float;

uniform sampler2D tPrev;
uniform vec2  u_resolution;
uniform vec2  u_brushUV;
uniform vec3  u_color;
uniform float u_waterAmount;
uniform float u_pigmentLoad;
uniform float u_flowVelocity;
uniform float u_diffusionRate;
uniform float u_wetCanvas;
uniform float u_time;
uniform float u_painting;
uniform float u_brushType;
uniform float u_brushSize;
uniform float u_screenAspect;
uniform float u_wetTimer;
uniform float u_gravity;   // drip gravity strength

// ── Noise ────────────────────────────────────────────────────────────────────
vec2 hash2(vec2 p) {
  p = vec2(dot(p,vec2(127.1,311.7)), dot(p,vec2(269.5,183.3)));
  return -1.0 + 2.0*fract(sin(p)*43758.5453123);
}
float gnoise(vec2 p) {
  vec2 i=floor(p), f=fract(p), u=f*f*(3.0-2.0*f);
  return mix(mix(dot(hash2(i),f),           dot(hash2(i+vec2(1,0)),f-vec2(1,0)),u.x),
             mix(dot(hash2(i+vec2(0,1)),f-vec2(0,1)),dot(hash2(i+vec2(1,1)),f-vec2(1,1)),u.x),u.y);
}

// ── Gaussian blur (5-tap cross) ───────────────────────────────────────────────
vec4 gaussianBlur(vec2 uv, vec2 tx) {
  vec4 c = texture2D(tPrev, uv)               * 0.36;
  vec4 n = texture2D(tPrev, uv+vec2(0,tx.y))  * 0.16;
  vec4 s = texture2D(tPrev, uv-vec2(0,tx.y))  * 0.16;
  vec4 e = texture2D(tPrev, uv+vec2(tx.x,0))  * 0.16;
  vec4 w = texture2D(tPrev, uv-vec2(tx.x,0))  * 0.16;
  return c + n + s + e + w;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec2 tx = 1.0 / u_resolution;
  vec4 prev = texture2D(tPrev, uv);

  // ── Frozen — paint is dry and permanent ─────────────────────────────────
  if (u_wetTimer <= 0.0 && u_painting < 0.5) {
    gl_FragColor = prev;
    return;
  }

  // ── Wet phase: Gaussian spread ───────────────────────────────────────────
  float spreadStr = u_diffusionRate * 0.065 * u_wetTimer;
  vec4 blurred = gaussianBlur(uv, tx * 2.2);

  float wetness = prev.a;
  float blend   = spreadStr * wetness * wetness;
  vec4 state    = mix(prev, blurred, blend);

  float newA   = clamp(state.a,   0.0, 1.0);
  vec3  newRGB = clamp(state.rgb, vec3(0.0), vec3(1.0));

  // ── Gravity drip — paint flows downward ──────────────────────────────────
  // In UV space, downward = decreasing v (uv.y).
  // We look ABOVE (uv + vec2(0, dy)) to see if heavy paint will flow down.
  float gravity = u_gravity * 0.8;
  if (gravity > 0.01 && u_wetTimer > 0.05 && newA > 0.05) {
    // Heavier paint drips faster; slight horizontal wander from noise
    float dripSpeed = newA * newA * gravity;
    float dripDist  = tx.y * (4.0 + newA * 10.0);
    float wander    = gnoise(uv * 8.0 + u_time * 0.15) * tx.x * 2.5;
    vec2  dripSrc   = uv + vec2(wander, dripDist);
    vec4  above     = texture2D(tPrev, dripSrc);

    // Only drip if there's excess paint above
    float excess = above.a - newA - 0.08;
    if (excess > 0.0) {
      float flowAmt = excess * dripSpeed * u_wetTimer * 0.5;
      flowAmt = clamp(flowAmt, 0.0, 0.15);
      vec3 aboveHue = above.rgb / max(above.a, 0.001);
      vec3 curHue   = newRGB   / max(newA,   0.001);
      newA   = clamp(newA + flowAmt * above.a, 0.0, 1.0);
      vec3 blendHue = mix(curHue, aboveHue, flowAmt);
      newRGB = clamp(blendHue * newA, vec3(0.0), vec3(1.0));
    }

    // Thin downward trails (capillary action simulation)
    float trail = above.a * gravity * 0.12 * u_wetTimer;
    if (trail > 0.005) {
      vec3 aHue = above.rgb / max(above.a, 0.001);
      newA   = clamp(newA + trail * (1.0 - newA * 0.7), 0.0, 1.0);
      newRGB = clamp(mix(newRGB / max(newA,0.001), aHue, trail * 0.4) * newA, vec3(0.0), vec3(1.0));
    }
  }

  // ── Edge accumulation: pigment pools at wet/dry boundary ─────────────────
  float da_x = texture2D(tPrev, uv+vec2(tx.x,0)).a - texture2D(tPrev,uv-vec2(tx.x,0)).a;
  float da_y = texture2D(tPrev, uv+vec2(0,tx.y)).a - texture2D(tPrev,uv-vec2(0,tx.y)).a;
  float edge = clamp(length(vec2(da_x, da_y)) * 3.0, 0.0, 1.0);
  newA = clamp(newA + edge * u_waterAmount * 0.04 * u_wetTimer, 0.0, 1.0);

  // ── Wet-on-wet bloom (toggle) ─────────────────────────────────────────────
  if (u_wetCanvas > 0.5 && u_wetTimer > 0.2) {
    float bloomZone = smoothstep(0.1, 0.4, prev.a) * (1.0 - smoothstep(0.55, 0.80, prev.a));
    if (bloomZone > 0.01) {
      float angle = gnoise(uv * 22.0 + u_time * 0.45) * 6.2832;
      vec2  bv    = vec2(cos(angle), sin(angle)) * tx * 2.2 * bloomZone;
      vec4  bs    = texture2D(tPrev, uv - bv);
      newRGB = mix(newRGB, bs.rgb, bloomZone * 0.12);
      newA   = mix(newA,   bs.a,   bloomZone * 0.10);
    }
  }

  // ── Brush stamp ───────────────────────────────────────────────────────────
  if (u_painting > 0.5) {
    vec2  d = uv - u_brushUV;
    d.x    *= u_screenAspect;
    float R = u_brushSize + u_waterAmount * 0.035;

    float stamp = 0.0;
    float halo  = 0.0;

    if (u_brushType < 0.5) {
      // Round: Gaussian core + organic edge
      float r     = length(d);
      float gauss = exp(-r * r / (R * R * 0.5));
      float en    = gnoise(uv * 40.0 + vec2(u_time * 2.0)) * 0.30;
      float outerR= R * (1.0 + abs(en) * 0.40);
      float edgeS = smoothstep(outerR, R * 0.42, r);
      stamp = max(gauss * 0.90, edgeS);
      halo  = smoothstep(R * 1.6, R * 1.05, r) * u_waterAmount * 0.55;

    } else if (u_brushType < 1.5) {
      // Flat calligraphy
      float fx = abs(d.x) / (R * 2.5);
      float fy = abs(d.y) / (R * 0.35);
      float en = gnoise(uv * 30.0 + u_time) * 0.20;
      stamp    = smoothstep(1.0 + en, 0.35, max(fx, fy));
      halo     = stamp * u_waterAmount * 0.30;

    } else {
      // Splatter: scattered droplets
      for (int k = 0; k < 12; k++) {
        float kf = float(k);
        vec2 off = hash2(vec2(kf*0.137, u_time*0.5+kf*0.07)) * R * 2.2;
        stamp = max(stamp, smoothstep(1.0, 0.0, length(d-off)/(R*0.22)));
      }
      for (int k = 0; k < 7; k++) {
        float kf = float(k);
        vec2 off = hash2(vec2(kf*0.31+5.0, u_time*0.3+kf)) * R * 4.0;
        halo = max(halo, smoothstep(1.0, 0.0, length(d-off)/(R*0.09)) * 0.45);
      }
    }

    // Premultiplied over-composite
    float safeA      = max(newA, 0.001);
    vec3  existColor = newRGB / safeA;
    float srcA       = clamp(stamp * u_pigmentLoad, 0.0, 1.0);

    float outA = srcA + newA * (1.0 - srcA);
    vec3  outC = outA > 0.001
      ? (u_color * srcA + existColor * newA * (1.0 - srcA)) / outA
      : u_color;

    newRGB = clamp(outC * outA, vec3(0.0), vec3(1.0));
    newA   = clamp(outA, 0.0, 1.0);

    // Water halo fringe
    if (halo > 0.005) {
      newA = clamp(newA + halo * (1.0 - newA * 0.6), 0.0, 1.0);
      float he = max(newA, 0.001);
      vec3  hc = newRGB / he;
      vec3  hTarget = mix(hc, u_color, clamp(halo * (1.0-safeA), 0.0, 1.0));
      newRGB = clamp(hTarget * newA, vec3(0.0), vec3(1.0));
    }
  }

  gl_FragColor = vec4(clamp(newRGB, vec3(0.0), vec3(1.0)),
                      clamp(newA,   0.0, 1.0));
}
