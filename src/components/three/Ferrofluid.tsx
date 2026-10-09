import { useEffect, useRef, type CSSProperties } from "react";
import { Renderer, Program, Mesh, Triangle } from "ogl";
import { isDocumentVisible } from "../../lib/documentVisibility";
import "./Ferrofluid.css";

/**
 * Ferrofluid — the React Bits "Ferrofluid" background (https://reactbits.dev),
 * JavaScript + CSS variant, ported to TypeScript. The shaders and every visual
 * prop are upstream's, unchanged. What differs is integration only, so the
 * effect follows the same performance rules as Aurora and Particles:
 *
 *  - Upstream rebuilds the whole WebGL scene whenever any prop's reference
 *    changes (an inline `colors={[...]}` would re-create the context on every
 *    render). Here only `dpr` rebuilds the scene; every other prop is pushed
 *    into the live uniforms in place.
 *  - `active` is not in upstream. While it's false the render loop is
 *    cancelled outright — an off-screen hero costs no GPU work and no
 *    per-frame wakeups — and turning it back on resumes with the scene intact:
 *    no context recreation, no shader recompile. (`paused` also stops the
 *    loop, but keeps upstream's meaning: freeze the current frame.)
 *  - The animation clock is accumulated from clamped frame deltas instead of
 *    reading the raw rAF timestamp, so resuming after a pause never makes the
 *    fluid jump.
 *  - The pointer starts off-canvas and snaps to its first real position.
 *    Upstream starts it at the bottom-left corner, which punches a dark hole
 *    in the rim lines there until the mouse moves (permanently, on touch).
 *  - `antialias` is off: the scene is one full-screen triangle, so MSAA would
 *    cost memory and bandwidth without smoothing anything.
 *  - Frames are skipped while the tab is hidden; teardown releases the WebGL
 *    context and resize observer, not just the canvas node.
 *  - The canvas is decorative, so the root is aria-hidden.
 */

const MAX_COLORS = 8;

const defaultColors = ["#ffffff", "#ffffff", "#ffffff"];

/** Longest step the animation clock will take, so a stall can't cause a jump. */
const MAX_FRAME_MS = 100;
/** Where the pointer rests until it first moves: far outside any canvas. */
const POINTER_REST = -10000;

type Vec3 = [number, number, number];
type Vec2 = [number, number];

export type FerrofluidFlowDirection = "up" | "down" | "left" | "right";

const hexToRgb = (hex: string): Vec3 => {
  let value = hex.replace(/^#/, "");
  if (value.length === 3) {
    value = value
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const c = value.padEnd(6, "0");
  return [
    parseInt(c.slice(0, 2), 16) / 255,
    parseInt(c.slice(2, 4), 16) / 255,
    parseInt(c.slice(4, 6), 16) / 255,
  ];
};

/** Up to MAX_COLORS hexes → exactly MAX_COLORS vec3s (the last one repeats). */
const prepColors = (input: readonly string[] | undefined) => {
  const base = (input && input.length > 0 ? input : defaultColors).slice(0, MAX_COLORS);
  const rgb: Vec3[] = [];
  for (let i = 0; i < MAX_COLORS; i++) {
    rgb.push(hexToRgb(base[Math.min(i, base.length - 1)]));
  }
  return { rgb, count: base.length };
};

const flowVec = (direction: FerrofluidFlowDirection): Vec2 => {
  switch (direction) {
    case "up":
      return [0, 1];
    case "left":
      return [-1, 0];
    case "right":
      return [1, 0];
    case "down":
    default:
      return [0, -1];
  }
};

const vertex = /* glsl */ `
attribute vec2 position;
attribute vec2 uv;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const fragment = /* glsl */ `
precision highp float;

uniform vec3  iResolution;
uniform vec2  iMouse;
uniform float iTime;

uniform vec3  uColor0;
uniform vec3  uColor1;
uniform vec3  uColor2;
uniform vec3  uColor3;
uniform vec3  uColor4;
uniform vec3  uColor5;
uniform vec3  uColor6;
uniform vec3  uColor7;
uniform int   uColorCount;

uniform vec3  uMouseColor;
uniform vec2  uFlow;
uniform float uSpeed;
uniform float uScale;
uniform float uTurbulence;
uniform float uFluidity;
uniform float uRimWidth;
uniform float uSharpness;
uniform float uShimmer;
uniform float uGlow;
uniform float uOpacity;
uniform float uMouseEnabled;
uniform float uMouseStrength;
uniform float uMouseRadius;

varying vec2 vUv;

#define PI 3.14159265

vec3 palette(float h) {
  int count = uColorCount;
  if (count < 1) count = 1;
  int idx = int(floor(clamp(h, 0.0, 0.999999) * float(count)));
  if (idx <= 0) return uColor0;
  if (idx == 1) return uColor1;
  if (idx == 2) return uColor2;
  if (idx == 3) return uColor3;
  if (idx == 4) return uColor4;
  if (idx == 5) return uColor5;
  if (idx == 6) return uColor6;
  return uColor7;
}

float hash(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float smin(float a, float b, float k) {
  float r = exp2(-a / k) + exp2(-b / k);
  return -k * log2(r);
}

float sinlerp(float a, float b, float w) {
  return mix(a, b, (sin(w * PI - PI / 2.0) + 1.0) / 2.0);
}

float vn(vec2 p, float s, float seed) {
  vec2 cellp = floor(p / s);
  vec2 relp = mod(p, s);
  float g1 = hash(vec3(cellp, seed));
  float g2 = hash(vec3(cellp.x + 1.0, cellp.y, seed));
  float g3 = hash(vec3(cellp.x + 1.0, cellp.y + 1.0, seed));
  float g4 = hash(vec3(cellp.x, cellp.y + 1.0, seed));
  float bx = sinlerp(g1, g2, relp.x / s);
  float tx = sinlerp(g4, g3, relp.x / s);
  return sinlerp(bx, tx, relp.y / s);
}

float dbn(vec2 p, float s, float seed) {
  float o = s / 2.0;
  float n0 = vn(p, s, seed);
  float n1 = vn(p + vec2(o, o), s, seed + 0.1);
  float n2 = vn(p + vec2(-o, o), s, seed + 0.2);
  float n3 = vn(p + vec2(o, -o), s, seed + 0.3);
  float n4 = vn(p + vec2(-o, -o), s, seed + 0.4);
  return (2.0 * n0 + 1.5 * n1 + 1.25 * n2 + 1.125 * n3 + n4) / 7.0;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  float ref = 700.0 / max(uScale, 0.05);
  vec2 p = fragCoord / iResolution.y * ref;

  float spd = 200.0 * uSpeed;
  float t = iTime;

  vec2 dir = uFlow;
  vec2 perp = vec2(-dir.y, dir.x);

  float distort1 = vn(p + perp * (t * spd), 60.0, 10.0) * 50.0 * uTurbulence;
  float distort2 = vn(p - perp * (t * spd), 120.0, 15.0) * 100.0 * uTurbulence;

  float peaks = dbn(p + distort1 + dir * (t * spd * 0.5), 40.0, 1.0);
  float peaks2 = dbn(p + distort2 - dir * (t * spd * 0.5), 40.0, 0.0);

  float mapeaks = smin(peaks, peaks2, max(uFluidity, 0.001));

  float mGlow = 0.0;
  if (uMouseEnabled > 0.5) {
    vec2 mp = iMouse / iResolution.y * ref;
    float md = length(p - mp) / ref;
    float rr = max(uMouseRadius, 0.02);
    mGlow = exp(-md * md / (rr * rr)) * uMouseStrength;
  }

  float band = (uRimWidth - abs((mapeaks - 0.4) * 2.0)) * 5.0;
  float ltn = clamp(band - vn(p + dir * (t * spd * 0.5), 60.0, 12.0) * uShimmer, 0.0, 1.0);
  ltn = pow(ltn, uSharpness) * uGlow;
  ltn *= clamp(1.0 - mGlow, 0.0, 1.0);

  float h = clamp(0.5 + (peaks - peaks2) * 0.8, 0.0, 1.0);
  vec3 col = palette(h);

  vec3 outc = col * ltn;
  float a = clamp(max(outc.r, max(outc.g, outc.b)), 0.0, 1.0);
  fragColor = vec4(outc, a * uOpacity);
}

void main() {
  vec4 color;
  mainImage(color, vUv * iResolution.xy);
  gl_FragColor = color;
}
`;

export interface FerrofluidProps {
  /** Hex colours (up to 8) tinting the rim, spread across the surface by height. */
  colors?: string[];
  /** Multiplier for how fast the fluid churns and flows. */
  speed?: number;
  /** Overall feature size. Higher values zoom in for larger, fewer blobs. */
  scale?: number;
  /** Amount of domain distortion — higher is more chaotic and swirling. */
  turbulence?: number;
  /** Softness of the merge between the two fluid layers. */
  fluidity?: number;
  /** Thickness of the glowing contour lines tracing the fluid surface. */
  rimWidth?: number;
  /** Contrast of the rim highlights — higher gives crisper, thinner edges. */
  sharpness?: number;
  /** Fine grainy break-up applied to the rim. 0 = smooth lines. */
  shimmer?: number;
  /** Overall brightness multiplier of the rim highlights. */
  glow?: number;
  /** Primary direction the fluid surface drifts. */
  flowDirection?: FerrofluidFlowDirection;
  /** Overall alpha of the rendered canvas. */
  opacity?: number;
  /** Enables a magnetic spike that rises and glows under the cursor. */
  mouseInteraction?: boolean;
  /** Intensity of the magnetic cursor spike. */
  mouseStrength?: number;
  /** Falloff radius of the magnetic cursor spike. */
  mouseRadius?: number;
  /** Easing time constant (seconds) for the cursor to follow the pointer. 0 = immediate. */
  mouseDampening?: number;
  /** CSS mix-blend-mode applied to the root (e.g. "screen", "lighten"). */
  mixBlendMode?: string;
  /** Freezes the current frame (the render loop stops). */
  paused?: boolean;
  /**
   * When false the render loop is cancelled (no GPU work, no per-frame
   * wakeups) without tearing the scene down, so resuming is instant. Not
   * part of upstream React Bits. Defaults to true.
   */
  active?: boolean;
  /** Device pixel ratio the canvas renders at; lower for performance. */
  dpr?: number;
  className?: string;
}

/** Every prop that is applied to a live scene in place (none rebuilds it). */
interface Tunables {
  speed: number;
  scale: number;
  turbulence: number;
  fluidity: number;
  rimWidth: number;
  sharpness: number;
  shimmer: number;
  glow: number;
  opacity: number;
  flowDirection: FerrofluidFlowDirection;
  mouseInteraction: boolean;
  mouseStrength: number;
  mouseRadius: number;
  mouseDampening: number;
}

interface SceneControls {
  setRunning: (next: boolean) => void;
  setTunables: (next: Tunables) => void;
  setPalette: (hexes: readonly string[] | undefined) => void;
}

export default function Ferrofluid({
  colors = defaultColors,
  speed = 0.5,
  scale = 1.6,
  turbulence = 1,
  fluidity = 0.1,
  rimWidth = 0.2,
  sharpness = 2.5,
  shimmer = 1.5,
  glow = 2,
  flowDirection = "down",
  opacity = 1,
  mouseInteraction = true,
  mouseStrength = 1,
  mouseRadius = 0.35,
  mouseDampening = 0.15,
  mixBlendMode,
  paused = false,
  active = true,
  dpr,
  className,
}: FerrofluidProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<SceneControls | null>(null);
  // The latest values, read when a scene is (re)built. Kept in refs — and
  // pushed to a live scene via `controlsRef` — so none of them ever appears
  // in the main effect's dependency array below.
  const tunablesRef = useRef<Tunables>({
    speed,
    scale,
    turbulence,
    fluidity,
    rimWidth,
    sharpness,
    shimmer,
    glow,
    opacity,
    flowDirection,
    mouseInteraction,
    mouseStrength,
    mouseRadius,
    mouseDampening,
  });
  const paletteRef = useRef(colors);
  const runningRef = useRef(active && !paused);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new Renderer({
      dpr: dpr ?? (window.devicePixelRatio || 1),
      alpha: true,
      antialias: false,
    });
    const gl = renderer.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    gl.clearColor(0, 0, 0, 0);
    container.appendChild(canvas);

    const initial = tunablesRef.current;
    const palette = prepColors(paletteRef.current);

    const uniforms = {
      iResolution: { value: [gl.drawingBufferWidth, gl.drawingBufferHeight, 1] as Vec3 },
      iMouse: { value: [POINTER_REST, POINTER_REST] as Vec2 },
      iTime: { value: 0 },
      uColor0: { value: palette.rgb[0] },
      uColor1: { value: palette.rgb[1] },
      uColor2: { value: palette.rgb[2] },
      uColor3: { value: palette.rgb[3] },
      uColor4: { value: palette.rgb[4] },
      uColor5: { value: palette.rgb[5] },
      uColor6: { value: palette.rgb[6] },
      uColor7: { value: palette.rgb[7] },
      uColorCount: { value: palette.count },
      uFlow: { value: flowVec(initial.flowDirection) },
      uSpeed: { value: initial.speed },
      uScale: { value: initial.scale },
      uTurbulence: { value: initial.turbulence },
      uFluidity: { value: initial.fluidity },
      uRimWidth: { value: initial.rimWidth },
      uSharpness: { value: initial.sharpness },
      uShimmer: { value: initial.shimmer },
      uGlow: { value: initial.glow },
      uOpacity: { value: initial.opacity },
      uMouseEnabled: { value: initial.mouseInteraction ? 1 : 0 },
      uMouseStrength: { value: initial.mouseStrength },
      uMouseRadius: { value: initial.mouseRadius },
    };

    const geometry = new Triangle(gl);
    const program = new Program(gl, { vertex, fragment, uniforms });
    const mesh = new Mesh(gl, { geometry, program });

    let tunables = initial;
    let running = false;
    let rafId = 0;
    let lastTime = 0;
    let elapsed = 0;

    const draw = () => renderer.render({ scene: mesh });

    // Resizing reallocates the canvas (and clears it), so only do it when the
    // size really changed — ResizeObserver also reports once on `observe`. A
    // stopped scene repaints once so a resize never leaves it blank.
    let lastWidth = 0;
    let lastHeight = 0;
    const resize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width === 0 || height === 0) return;
      if (width === lastWidth && height === lastHeight) return;
      lastWidth = width;
      lastHeight = height;
      renderer.setSize(width, height);
      uniforms.iResolution.value = [gl.drawingBufferWidth, gl.drawingBufferHeight, 1];
      if (!running) draw();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();

    // Pointer, in drawing-buffer pixels with y up (what the shader expects).
    const mouseTarget: Vec2 = [POINTER_REST, POINTER_REST];
    let hasPointer = false;
    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const ratio = renderer.dpr || 1;
      const x = (e.clientX - rect.left) * ratio;
      const y = (rect.height - (e.clientY - rect.top)) * ratio;
      mouseTarget[0] = x;
      mouseTarget[1] = y;
      // The first move (and any move with easing off) lands exactly, so the
      // spike never sweeps in from its resting place off-canvas.
      if (!hasPointer || tunables.mouseDampening <= 0) {
        uniforms.iMouse.value[0] = x;
        uniforms.iMouse.value[1] = y;
        hasPointer = true;
      }
    };
    canvas.addEventListener("pointermove", onPointerMove, { passive: true });

    const frame = (t: number) => {
      rafId = requestAnimationFrame(frame);
      const delta = Math.min(Math.max(t - lastTime, 0), MAX_FRAME_MS);
      lastTime = t;
      // Backgrounded tab: keep the clock current but skip the GPU submission.
      if (!isDocumentVisible()) return;

      elapsed += delta;
      uniforms.iTime.value = elapsed * 0.001;

      if (tunables.mouseDampening > 0 && hasPointer) {
        const tau = Math.max(1e-4, tunables.mouseDampening);
        const factor = Math.min(1, 1 - Math.exp(-delta / 1000 / tau));
        const cur = uniforms.iMouse.value;
        cur[0] += (mouseTarget[0] - cur[0]) * factor;
        cur[1] += (mouseTarget[1] - cur[1]) * factor;
      }

      try {
        draw();
      } catch (e) {
        console.error(e);
      }
    };

    const start = () => {
      if (running) return;
      running = true;
      lastTime = performance.now();
      rafId = requestAnimationFrame(frame);
    };

    const stop = () => {
      running = false;
      cancelAnimationFrame(rafId);
    };

    controlsRef.current = {
      setRunning: (next) => {
        if (next) start();
        else stop();
      },
      setTunables: (next) => {
        tunables = next;
        uniforms.uFlow.value = flowVec(next.flowDirection);
        uniforms.uSpeed.value = next.speed;
        uniforms.uScale.value = next.scale;
        uniforms.uTurbulence.value = next.turbulence;
        uniforms.uFluidity.value = next.fluidity;
        uniforms.uRimWidth.value = next.rimWidth;
        uniforms.uSharpness.value = next.sharpness;
        uniforms.uShimmer.value = next.shimmer;
        uniforms.uGlow.value = next.glow;
        uniforms.uOpacity.value = next.opacity;
        uniforms.uMouseEnabled.value = next.mouseInteraction ? 1 : 0;
        uniforms.uMouseStrength.value = next.mouseStrength;
        uniforms.uMouseRadius.value = next.mouseRadius;
      },
      setPalette: (hexes) => {
        const next = prepColors(hexes);
        uniforms.uColor0.value = next.rgb[0];
        uniforms.uColor1.value = next.rgb[1];
        uniforms.uColor2.value = next.rgb[2];
        uniforms.uColor3.value = next.rgb[3];
        uniforms.uColor4.value = next.rgb[4];
        uniforms.uColor5.value = next.rgb[5];
        uniforms.uColor6.value = next.rgb[6];
        uniforms.uColor7.value = next.rgb[7];
        uniforms.uColorCount.value = next.count;
      },
    };

    if (runningRef.current) start();

    return () => {
      stop();
      controlsRef.current = null;
      resizeObserver.disconnect();
      canvas.removeEventListener("pointermove", onPointerMove);
      if (container.contains(canvas)) {
        container.removeChild(canvas);
      }
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [dpr]);

  useEffect(() => {
    const next: Tunables = {
      speed,
      scale,
      turbulence,
      fluidity,
      rimWidth,
      sharpness,
      shimmer,
      glow,
      opacity,
      flowDirection,
      mouseInteraction,
      mouseStrength,
      mouseRadius,
      mouseDampening,
    };
    tunablesRef.current = next;
    controlsRef.current?.setTunables(next);
  }, [
    speed,
    scale,
    turbulence,
    fluidity,
    rimWidth,
    sharpness,
    shimmer,
    glow,
    opacity,
    flowDirection,
    mouseInteraction,
    mouseStrength,
    mouseRadius,
    mouseDampening,
  ]);

  useEffect(() => {
    paletteRef.current = colors;
    controlsRef.current?.setPalette(colors);
  }, [colors]);

  useEffect(() => {
    const next = active && !paused;
    runningRef.current = next;
    controlsRef.current?.setRunning(next);
  }, [active, paused]);

  return (
    <div
      ref={containerRef}
      className={className ? `ferrofluid-container ${className}` : "ferrofluid-container"}
      style={mixBlendMode ? { mixBlendMode: mixBlendMode as CSSProperties["mixBlendMode"] } : undefined}
      aria-hidden="true"
    />
  );
}
