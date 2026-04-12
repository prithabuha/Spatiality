// Simple fullscreen quad vertex shader for GPGPU passes
// RawShaderMaterial requires explicit attribute declarations
attribute vec3 position;

void main() {
  gl_Position = vec4(position, 1.0);
}
