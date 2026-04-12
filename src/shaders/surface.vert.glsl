// Surface vertex shader — screen-space paint (no UV atlas needed)
varying vec3 vNormal;
varying vec3 vViewDir;
varying vec3 vWorldPos;
varying vec2 vUv;

void main() {
  vUv = uv;
  vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;

  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  vNormal  = normalize(normalMatrix * normal);
  vViewDir = normalize(-mvPos.xyz);
  gl_Position = projectionMatrix * mvPos;
}
