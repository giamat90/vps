import { useCallback, useEffect, useRef } from "react";
import { usePlayerStore } from "../../stores/player";

function tickInterval(duration: number, widthPx: number): number {
  // Target at least 80px between ticks
  const raw = (duration / widthPx) * 80;
  for (const n of [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]) {
    if (n >= raw) return n;
  }
  return 600;
}

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function TimeRuler() {
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const duration    = usePlayerStore((s) => s.duration);
  const punchIn     = usePlayerStore((s) => s.punchIn);
  const punchOut    = usePlayerStore((s) => s.punchOut);
  const isRecording = usePlayerStore((s) => s.isRecording);
  const setPunchIn  = usePlayerStore((s) => s.setPunchIn);
  const setPunchOut = usePlayerStore((s) => s.setPunchOut);
  const clearPunch  = usePlayerStore((s) => s.clearPunch);

  const drag = useRef<{ on: boolean; startT: number }>({ on: false, startT: 0 });

  // ── drawing ──────────────────────────────────────────────────────────────

  const draw = useCallback(
    (overrideIn?: number | null, overrideOut?: number | null) => {
      const canvas = canvasRef.current;
      if (!canvas || duration <= 0) return;
      const W = canvas.width;
      const H = canvas.height;
      if (W === 0 || H === 0) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const tX = (t: number) => (t / duration) * W;

      // Background
      ctx.fillStyle = "#0d1b2e";
      ctx.fillRect(0, 0, W, H);

      // Punch region
      const inT  = overrideIn  !== undefined ? overrideIn  : punchIn;
      const outT = overrideOut !== undefined ? overrideOut : punchOut;
      if (inT !== null && outT !== null && outT > inT) {
        const x1 = tX(inT);
        const x2 = tX(outT);
        ctx.fillStyle = "rgba(233,69,96,0.22)";
        ctx.fillRect(x1, 0, x2 - x1, H);
        ctx.strokeStyle = "rgba(233,69,96,0.85)";
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x1, H); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x2, 0); ctx.lineTo(x2, H); ctx.stroke();
        // "I" markers at top
        ctx.fillStyle = "rgba(233,69,96,0.85)";
        ctx.fillRect(x1 - 1, 0, 3, 5);
        ctx.fillRect(x2 - 1, 0, 3, 5);
      }

      // Ticks
      const interval = tickInterval(duration, W);
      ctx.font = "10px monospace";
      for (let t = 0; t <= duration + 0.001; t += interval) {
        const x = Math.round(tX(t));
        ctx.strokeStyle = "#3a4a5e";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, H);
        ctx.lineTo(x, H * 0.35);
        ctx.stroke();
        if (x + 3 < W) {
          ctx.fillStyle = "#7a8a9e";
          ctx.textAlign = "left";
          ctx.fillText(fmt(t), x + 3, H * 0.55);
        }
      }

      // Bottom border
      ctx.strokeStyle = "#2a3a4e";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, H - 0.5);
      ctx.lineTo(W, H - 0.5);
      ctx.stroke();
    },
    [duration, punchIn, punchOut],
  );

  // Resize observer — sync canvas pixel size to CSS size
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const sync = () => {
      canvas.width  = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      draw();
    };
    const ro = new ResizeObserver(sync);
    ro.observe(canvas);
    sync();
    return () => ro.disconnect();
  }, [draw]);

  // Redraw when store state changes
  useEffect(() => { draw(); }, [draw]);

  // ── helpers ──────────────────────────────────────────────────────────────

  const xToTime = (offsetX: number): number => {
    const canvas = canvasRef.current;
    if (!canvas || duration <= 0) return 0;
    return Math.max(0, Math.min(duration, (offsetX / canvas.width) * duration));
  };

  // ── mouse handlers ───────────────────────────────────────────────────────

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isRecording || duration <= 0) return;
    e.preventDefault();
    const t = xToTime(e.nativeEvent.offsetX);
    drag.current = { on: true, startT: t };
    draw(t, t);
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drag.current.on) return;
    const t   = xToTime(e.nativeEvent.offsetX);
    const inT  = Math.min(drag.current.startT, t);
    const outT = Math.max(drag.current.startT, t);
    draw(inT, outT);
  };

  const onMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drag.current.on) return;
    drag.current.on = false;
    const t    = xToTime(e.nativeEvent.offsetX);
    const inT  = Math.min(drag.current.startT, t);
    const outT = Math.max(drag.current.startT, t);
    if (outT - inT < 0.5) {
      clearPunch();
    } else {
      setPunchIn(Math.round(inT * 10) / 10);
      setPunchOut(Math.round(outT * 10) / 10);
    }
  };

  const onMouseLeave = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (drag.current.on) onMouseUp(e);
  };

  return (
    <div className="time-ruler">
      <canvas
        ref={canvasRef}
        className="time-ruler__canvas"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        style={{ cursor: isRecording || duration <= 0 ? "default" : "crosshair" }}
      />
    </div>
  );
}
