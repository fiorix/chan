// The program plumbing the WebGL2 animations share: compiling and linking a
// shader pair, looking up a uniform, and the vertices of a fullscreen
// triangle. Each animation keeps its own shaders and render loop. Every
// failure throws, with the driver's info log where it gives one, after
// deleting what the call allocated.

/// Compile one shader of `type` from `source`. Throws the driver's info log
/// on a compile error, after deleting the shader.
export function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("could not allocate shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const detail = gl.getShaderInfoLog(shader) || "unknown compile error";
    gl.deleteShader(shader);
    throw new Error(detail);
  }
  return shader;
}

/// Compile both shaders and link them into a program. The shaders are
/// deleted once linked or on any failure, and the program on a link error,
/// whose info log is thrown.
export function linkProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  let fragmentShader: WebGLShader;
  try {
    fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  } catch (error) {
    gl.deleteShader(vertexShader);
    throw error;
  }

  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    throw new Error("could not allocate shader program");
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const detail = gl.getProgramInfoLog(program) || "unknown link error";
    gl.deleteProgram(program);
    throw new Error(detail);
  }
  return program;
}

/// The location of uniform `name` in `program`. Throws when the program has
/// none, as when the compiler optimized an unused uniform away.
export function uniformLocation(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);
  if (location === null) throw new Error(`missing shader uniform ${name}`);
  return location;
}

/// One triangle whose clip-space corners, (-1, -1), (3, -1) and (-1, 3),
/// cover the whole viewport, for a fragment shader that paints every pixel.
export const FULLSCREEN_TRIANGLE: readonly number[] = [-1, -1, 3, -1, -1, 3];
