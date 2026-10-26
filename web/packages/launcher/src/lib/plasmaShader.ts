// Adapted from the owner's plasma-line shader. Positive smoothstep bounds
// avoid the undefined reversed-edge behavior in the supplied example.
export const VERTEX_SHADER = `
attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

export const FRAGMENT_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 resolution;
uniform float time;
uniform vec3 tint;

float wave(float t) {
  return (cos(t) + cos(t * 1.3 + 1.3) + cos(t * 1.4 + 1.4)) / 3.0;
}
float plasma(float x, float fade, float offset) {
  return wave(x * 0.2 + time * 0.2) * fade + offset;
}
void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  vec2 space = (gl_FragCoord.xy - resolution / 2.0) / resolution.x * 10.0;
  float fade = 0.5 - 0.5 * cos(uv.x * 6.283185);
  float vertical = 0.5 - 0.5 * cos(uv.y * 6.283185);
  space.y += wave(space.x * 0.5 + time * 0.04) * (0.5 + fade);
  space.x += wave(space.y * 0.5 + time * 0.04 + 2.0) * fade;
  float glow = 0.0;
  float offsetTime = time * 0.266;
  for (int l = 0; l < 16; l++) {
    float index = float(l);
    float offsetPosition = index + space.x * 0.5;
    float rand = wave(offsetPosition + offsetTime) * 0.5 + 0.5;
    float halfWidth = mix(0.01, 0.2, rand * fade) * 0.5;
    float offset = wave(offsetPosition + offsetTime * (1.0 + index / 16.0)) * mix(0.6, 2.0, fade);
    float distance = abs(plasma(space.x, fade, offset) - space.y);
    float line = (1.0 - smoothstep(0.0, halfWidth, distance)) * 0.5;
    line += 1.0 - smoothstep(halfWidth * 0.15, halfWidth * 0.15 + 0.015, distance);
    float circleX = mod(index + time * 0.2, 25.0) - 12.0;
    float circleDistance = length(space - vec2(circleX, plasma(circleX, fade, offset)));
    line += (1.0 - smoothstep(0.01, 0.025, circleDistance)) * 4.0;
    glow += line * rand;
  }
  // Transparent between strands so the launcher's own theme supplies the base.
  float alpha = clamp(glow * 0.32 + vertical * 0.025, 0.0, 0.7);
  gl_FragColor = vec4(tint * alpha, alpha);
}
`;
