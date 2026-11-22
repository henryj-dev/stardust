<script lang="ts">
import { onMount } from "svelte";

let canvas: HTMLCanvasElement;

onMount(() => {
  const context = canvas.getContext("2d");
  if (!context) return;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
  const ripples: { x: number; y: number; time: number }[] = [];
  let frame = 0;
  let lastRipple = 0;
  let width = 0;
  let height = 0;

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    context!.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function draw(now: number) {
    context!.clearRect(0, 0, width, height);
    context!.font = "12px ui-monospace, SFMono-Regular, monospace";
    context!.textAlign = "center";
    context!.textBaseline = "middle";
    for (let i = ripples.length - 1; i >= 0; i--) {
      const ripple = ripples[i]!;
      const progress = (now - ripple.time) / 1100;
      if (progress >= 1) {
        ripples.splice(i, 1);
        continue;
      }
      const radius = 20 + progress * 115;
      const fade = (1 - progress) * 0.32;
      const step = 18;
      for (let x = Math.floor((ripple.x - radius - 15) / step) * step; x <= ripple.x + radius + 15; x += step) {
        for (let y = Math.floor((ripple.y - radius - 15) / step) * step; y <= ripple.y + radius + 15; y += step) {
          const distance = Math.hypot(x - ripple.x, y - ripple.y);
          const intensity = Math.max(0, 1 - Math.abs(distance - radius) / 22);
          if (intensity < 0.1) continue;
          context!.fillStyle = `rgba(71, 85, 105, ${fade * intensity})`;
          context!.fillText(intensity > 0.7 ? "+" : intensity > 0.35 ? ":" : ".", x, y);
        }
      }
    }
    frame = ripples.length ? requestAnimationFrame(draw) : 0;
  }

  function move(event: PointerEvent) {
    if (event.pointerType !== "mouse" || reducedMotion.matches || !finePointer.matches) return;
    const now = performance.now();
    if (now - lastRipple < 180) return;
    lastRipple = now;
    ripples.push({ x: event.clientX, y: event.clientY, time: now });
    if (ripples.length > 4) ripples.shift();
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function preferencesChanged() {
    if (!reducedMotion.matches && finePointer.matches) return;
    ripples.length = 0;
    cancelAnimationFrame(frame);
    frame = 0;
    context!.clearRect(0, 0, width, height);
  }

  resize();
  window.addEventListener("resize", resize);
  window.addEventListener("pointermove", move, { passive: true });
  reducedMotion.addEventListener("change", preferencesChanged);
  finePointer.addEventListener("change", preferencesChanged);
  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("resize", resize);
    window.removeEventListener("pointermove", move);
    reducedMotion.removeEventListener("change", preferencesChanged);
    finePointer.removeEventListener("change", preferencesChanged);
  };
});
</script>

<canvas bind:this={canvas} aria-hidden="true" class="pointer-events-none fixed inset-0 h-screen w-screen"></canvas>
