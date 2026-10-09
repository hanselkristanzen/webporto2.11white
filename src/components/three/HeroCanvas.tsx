import { useEffect, useRef, useState } from "react";
import Ferrofluid from "./Ferrofluid";
import { LatticeFallback } from "./LatticeFallback";
import { CanvasErrorBoundary } from "./CanvasErrorBoundary";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import { isLowPowerDevice } from "../../lib/hardwareTier";

function detectWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(
      window.WebGLRenderingContext &&
        (canvas.getContext("webgl2") || canvas.getContext("webgl"))
    );
  } catch {
    return false;
  }
}

// The fluid's rim colours. A module-level constant so the reference is stable
// across renders (Ferrofluid recolours in place when it changes, but there is
// no reason to hand it a fresh array every render).
const FERROFLUID_COLORS = ["#ffffff", "#ffffff", "#ffffff"];

export function HeroCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const [hasBeenVisible, setHasBeenVisible] = useState(false);
  const reducedMotion = useReducedMotion();
  const [webglOk] = useState<boolean>(() => detectWebGL());
  // Render resolution, decided once: capped at 1.5x (1x on low-power devices).
  // The fluid is a full-screen fragment shader, so this is the main cost knob.
  const [pixelRatio] = useState<number>(() =>
    Math.min(window.devicePixelRatio || 1, isLowPowerDevice ? 1 : 1.5)
  );

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { rootMargin: "35% 0px 35% 0px", threshold: 0 }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // PERFORMANCE: the fluid scene is mounted once, the first time the hero is
  // actually visible, and stays mounted from then on; `active={visible}`
  // cancels its render loop (no GPU work, no per-frame wakeups) while the
  // hero is off-screen without tearing anything down, so scrolling back up
  // costs no fresh WebGL context or shader compile.
  useEffect(() => {
    if (visible) setHasBeenVisible(true);
  }, [visible]);

  // The hero is always a dark, cinematic section by design — the global
  // light/dark toggle intentionally doesn't invert it, so the fluid has a
  // single palette. Its canvas is transparent, so the hero's own dark surface
  // (`--color-dark`) is the "background" the rim lines are drawn on.
  const shouldRenderFluid = !reducedMotion && webglOk;

  return (
    <div ref={containerRef} style={{ width: "100%", height: "100%" }}>
      {shouldRenderFluid && hasBeenVisible ? (
        <CanvasErrorBoundary fallback={<LatticeFallback />}>
          <Ferrofluid
            colors={FERROFLUID_COLORS}
            speed={0.5}
            scale={1}
            turbulence={1}
            fluidity={0.1}
            rimWidth={0.2}
            sharpness={3}
            shimmer={1}
            glow={2}
            flowDirection="down"
            opacity={1}
            mouseInteraction
            mouseStrength={1}
            mouseRadius={0.3}
            dpr={pixelRatio}
            active={visible}
          />
        </CanvasErrorBoundary>
      ) : (
        <LatticeFallback />
      )}
    </div>
  );
}
