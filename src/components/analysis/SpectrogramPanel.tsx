import { useRef, useEffect } from "react";
import { getMicAnalyser, getEngine, usePlayerStore } from "../../stores/player";
import { useExerciseStore } from "../../stores/exercise";
import { SPECTRO_COLORMAP, windowDragTime } from "../../lib/spectroUtils";
import { computeMagnitudeSpectrumDb, estimateFormants, type FormantEstimate } from "@giamat90/mps-core/spectrum";
import type { TrackSpectrogram } from "../../lib/exerciseSpectrogram";
import {
  AXIS_W,
  CAPTURE_INTERVAL_MS,
  LEGEND_WIDTH,
  WINDOW_S,
  buildFreqBinLut,
  computeRowNorms,
  formantTickYs,
  maxFrequency,
  nextScrollShift,
  writeColumnPixels,
} from "../../lib/spectrogramMath";
import {
  drawCenterPlayhead,
  drawDbLegend,
  drawFreqAxis,
  drawGridLines,
  drawIdleMessage,
  drawTrackSpectrogramWindow,
  fillFormantTicks,
} from "../../lib/spectrogramDraw";
import PanelTitle from "../panels/PanelTitle";
import { usePanelCollapse } from "../../stores/collapsed";

// Matches the mic analyser's fftSize (see getMicAnalyser in stores/player.ts)
// so live and buffer-snapshot data are the same resolution.
const FFT_SIZE = 8192;

type Canvas2D = OffscreenCanvas | HTMLCanvasElement;
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface FrameSource {
  sr: number;
  freqData: Float32Array;
  timeData: Float32Array;
}

interface RenderState {
  offscreen: Canvas2D | null;
  lastCapture: number;
  shiftAccum: number;
  fftScratch: Float32Array<ArrayBuffer> | null;
  timeScratch: Float32Array<ArrayBuffer> | null;
  colNorms: Float32Array | null;
  freqLut: { low: Uint16Array; high: Uint16Array; H: number; sr: number } | null;
  prevFormant: FormantEstimate;
  sr: number;
}

interface FrameParams {
  active: boolean;
  trackActive: boolean;
  shouldScroll: boolean;
  staticMode: boolean;
  trackSpectrogram: TrackSpectrogram | null;
  dpr: number;
  W: number;
  H: number;
  rollW: number;
}

function newRenderState(): RenderState {
  return {
    offscreen: null,
    lastCapture: 0,
    shiftAccum: 0,
    fftScratch: null,
    timeScratch: null,
    colNorms: null,
    freqLut: null,
    prevFormant: { f1: null, f2: null, f3: null },
    sr: 48000,
  };
}

function ensureOffscreen(state: RenderState, rollW: number, H: number): Ctx2D | null {
  if (!state.offscreen || state.offscreen.width !== rollW || state.offscreen.height !== H) {
    try {
      state.offscreen = new OffscreenCanvas(rollW, H);
    } catch {
      const fb = document.createElement("canvas");
      fb.width = rollW;
      fb.height = H;
      state.offscreen = fb;
    }
    const ic = state.offscreen.getContext("2d") as Ctx2D | null;
    if (ic) { ic.fillStyle = "#000"; ic.fillRect(0, 0, rollW, H); }
  }
  return state.offscreen.getContext("2d") as Ctx2D | null;
}

// A loaded track snapshots its decoded buffer at the playhead (works paused or playing); otherwise the live mic.
function readFrameSource(state: RenderState, trackActive: boolean): FrameSource | null {
  if (trackActive) {
    const engineSr = getEngine().getExerciseTrackSampleRate();
    const samples = getEngine().getExerciseTrackSamples(FFT_SIZE);
    if (!engineSr || !samples) return null;
    return { sr: engineSr, timeData: samples, freqData: computeMagnitudeSpectrumDb(samples, FFT_SIZE) };
  }
  const analyser = getMicAnalyser();
  if (!analyser) return null;
  const binCount = analyser.frequencyBinCount;
  if (!state.fftScratch || state.fftScratch.length !== binCount) {
    state.fftScratch = new Float32Array(binCount);
  }
  if (!state.timeScratch || state.timeScratch.length !== analyser.fftSize) {
    state.timeScratch = new Float32Array(analyser.fftSize);
  }
  analyser.getFloatFrequencyData(state.fftScratch);
  analyser.getFloatTimeDomainData(state.timeScratch);
  return { sr: analyser.context.sampleRate, freqData: state.fftScratch, timeData: state.timeScratch };
}

function scrollHistory(offCtx: Ctx2D, state: RenderState, rollW: number, H: number): number {
  const next = nextScrollShift(state.shiftAccum, rollW);
  state.shiftAccum = next.accum;
  const shifted = offCtx.getImageData(next.shift, 0, rollW - next.shift, H);
  offCtx.putImageData(shifted, 0, 0);
  return next.shift;
}

function appendFrame(offCtx: Ctx2D, state: RenderState, src: FrameSource, p: FrameParams): void {
  const { H, rollW } = p;
  state.sr = src.sr;
  if (!state.colNorms || state.colNorms.length !== H) state.colNorms = new Float32Array(H);

  const fftSize = src.freqData.length * 2;
  if (!state.freqLut || state.freqLut.H !== H || state.freqLut.sr !== src.sr) {
    const { low, high } = buildFreqBinLut(H, fftSize, src.sr);
    state.freqLut = { low, high, H, sr: src.sr };
  }
  computeRowNorms(src.freqData, state.freqLut.low, state.freqLut.high, H, state.colNorms);

  // Paused or scrubbed with a loaded track: keep the history and overwrite a fixed strip at the right edge.
  const shift = p.shouldScroll ? scrollHistory(offCtx, state, rollW, H) : Math.min(6, rollW);

  const colImg = offCtx.createImageData(shift, H);
  colImg.data.set(writeColumnPixels(state.colNorms, H, shift, SPECTRO_COLORMAP));
  offCtx.putImageData(colImg, rollW - shift, 0);

  const formant = estimateFormants(src.timeData, src.sr, state.prevFormant);
  state.prevFormant = formant;
  fillFormantTicks(offCtx as CanvasRenderingContext2D, formantTickYs(formant, H, src.sr), rollW - shift, shift);
}

function appendSilence(offCtx: Ctx2D, state: RenderState, rollW: number, H: number): void {
  const shift = scrollHistory(offCtx, state, rollW, H);
  offCtx.fillStyle = "#000000";
  offCtx.fillRect(rollW - shift, 0, shift, H);
}

function captureColumns(offCtx: Ctx2D, state: RenderState, p: FrameParams): void {
  const now = performance.now();
  if (now - state.lastCapture < CAPTURE_INTERVAL_MS) return;
  state.lastCapture = now;

  const src = readFrameSource(state, p.trackActive);
  if (p.active && src) appendFrame(offCtx, state, src, p);
  else if (p.active) appendSilence(offCtx, state, p.rollW, p.H);
}

function drawWaterfall(ctx: CanvasRenderingContext2D, state: RenderState, p: FrameParams): boolean {
  const offCtx = ensureOffscreen(state, p.rollW, p.H);
  if (!offCtx) return false;
  captureColumns(offCtx, state, p);

  // Active: blend the offscreen at 72% over the previous frame (temporal smoothing). Idle: clear the roll area.
  if (p.active) {
    ctx.globalAlpha = 0.72;
    ctx.drawImage(state.offscreen as CanvasImageSource, AXIS_W, 0);
    ctx.globalAlpha = 1.0;
  } else {
    ctx.fillStyle = "#0f0f1e";
    ctx.fillRect(AXIS_W, 0, p.rollW, p.H);
  }
  return true;
}

// Centred, drag-to-seek window over a precomputed track spectrogram; formants are estimated live at the playhead.
function drawStatic(ctx: CanvasRenderingContext2D, state: RenderState, spec: TrackSpectrogram, p: FrameParams): void {
  const engine = getEngine();
  const engineSr = engine.getExerciseTrackSampleRate();
  if (engineSr) state.sr = engineSr;

  drawTrackSpectrogramWindow(ctx, spec, engine.getCurrentTime(), p.rollW, p.H);

  const cx = AXIS_W + p.rollW / 2;
  drawCenterPlayhead(ctx, cx, p.H, p.dpr);

  const samples = engine.getExerciseTrackSamples(FFT_SIZE);
  if (samples && engineSr) {
    const formant = estimateFormants(samples, engineSr, state.prevFormant);
    state.prevFormant = formant;
    fillFormantTicks(ctx, formantTickYs(formant, p.H, engineSr), cx - 2 * p.dpr, 4 * p.dpr);
  }
}

function sizeCanvas(canvas: HTMLCanvasElement, state: RenderState): { dpr: number; W: number; H: number } {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round((canvas.clientWidth || 600) * dpr);
  const H = Math.round((canvas.clientHeight || 200) * dpr);
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
    state.freqLut = null;
    state.offscreen = null;
  }
  return { dpr, W, H };
}

function drawFrame(canvas: HTMLCanvasElement, state: RenderState, flags: Omit<FrameParams, "dpr" | "W" | "H" | "rollW">): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { dpr, W, H } = sizeCanvas(canvas, state);
  const p: FrameParams = { ...flags, dpr, W, H, rollW: W - AXIS_W - LEGEND_WIDTH };

  if (p.staticMode && p.trackSpectrogram) drawStatic(ctx, state, p.trackSpectrogram, p);
  else if (!drawWaterfall(ctx, state, p)) return;

  // Grid lines and axis always drawn at full opacity after composite
  const sr = state.sr;
  drawGridLines(ctx, W, H, maxFrequency(sr));
  drawFreqAxis(ctx, H, sr, dpr);
  drawDbLegend(ctx, W, H, dpr);
  if (!p.active) drawIdleMessage(ctx, AXIS_W + p.rollW / 2, H / 2, dpr);
}

export default function SpectrogramPanel() {
  const collapse = usePanelCollapse("spectrogram");
  const { open } = collapse;
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const isRecording  = usePlayerStore((s) => s.isRecording);
  const isMonitoring = usePlayerStore((s) => s.isMonitoring);
  const isPlaying    = usePlayerStore((s) => s.isPlaying);
  const duration     = usePlayerStore((s) => s.duration);
  const seek         = usePlayerStore((s) => s.seek);
  const loadedTrackId = useExerciseStore((s) => s.loadedTrackId);
  const trackSpectrogram    = useExerciseStore((s) => s.exerciseTrackSpectrogram);
  const isComputingSpectrogram = useExerciseStore((s) => s.isComputingSpectrogram);
  // A loaded track snapshots its decoded buffer at the current playhead —
  // unlike a live AnalyserNode, this works whether playing, paused, or
  // scrubbed, so "active" (i.e. showing something at all) doesn't depend on
  // isPlaying. Whether the waterfall keeps *scrolling* still does — see
  // shouldScroll below.
  const trackActive  = loadedTrackId !== null;
  // A loaded track with its spectrogram precomputed renders a centered,
  // drag-to-seek window (like PianoRoll) instead of the live waterfall —
  // see exerciseSpectrogram.ts. Live mic monitoring/recording has no
  // finite buffer to precompute, so it always uses the waterfall.
  const staticMode   = trackActive && trackSpectrogram !== null;
  const shouldScroll = isRecording || isMonitoring || (trackActive && !staticMode && isPlaying);

  const stateRef = useRef<RenderState>(newRenderState());
  const drawRef  = useRef<() => void>(() => {});
  const rollDrag = useRef<{ active: boolean; startX: number; startTime: number }>({
    active: false,
    startX: 0,
    startTime: 0,
  });

  useEffect(() => {
    console.log('[Spectrogram] thermal LUT active, gamma=0.4, blur=3-tap');
  }, []);

  useEffect(() => {
    console.log('[Spectrogram] dB range: floor=-85, ceiling=-20, span=65dB');
  }, []);

  useEffect(() => {
    console.log('[Spectrogram] LUT: nearest-neighbor, gamma=0.35');
  }, []);

  useEffect(() => {
    console.log('[Spectrogram] LUT: max-in-range, gamma=0.38');
  }, []);

  useEffect(() => {
    console.log('[Spectrogram] soft gate: threshold=0.15');
  }, []);

  useEffect(() => {
    console.log('[Spectrogram] dB legend: -85 to -20 dB, width=48px');
  }, []);

  useEffect(() => {
    drawRef.current = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      drawFrame(canvas, stateRef.current, {
        active: isRecording || isMonitoring || trackActive,
        trackActive,
        shouldScroll,
        staticMode,
        trackSpectrogram,
      });
    };
  }, [isRecording, isMonitoring, trackActive, shouldScroll, staticMode, trackSpectrogram]);

  useEffect(() => {
    if (!open) return;
    let rafId: number;
    const tick = () => { drawRef.current(); rafId = requestAnimationFrame(tick); };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [open]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => drawRef.current());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [open]);

  // ── drag-to-seek — same semantics as PianoRoll's main-canvas drag, so
  // both widgets scrub the shared engine/store time in the same way. Only
  // meaningful with a loaded track (live mic monitoring has no seekable
  // timeline); works during the brief precompute window too, since seeking
  // doesn't depend on the spectrogram picture itself.
  const onCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isRecording || !trackActive) return;
    rollDrag.current = {
      active: true,
      startX: e.nativeEvent.offsetX,
      startTime: getEngine().getCurrentTime(),
    };
  };

  const onCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!rollDrag.current.active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { startX, startTime } = rollDrag.current;
    const t = windowDragTime(startTime, startX, e.nativeEvent.offsetX, canvas.clientWidth - AXIS_W - LEGEND_WIDTH, WINDOW_S, duration);
    if (t !== null) seek(t);
  };

  const onCanvasMouseUp = () => { rollDrag.current.active = false; };

  return (
    <div className="analysis-panel">
      <div className="analysis-panel__header">
        <PanelTitle collapse={collapse}>Spectrum</PanelTitle>
        {open && (
          <span className="analysis-panel__hint">
            {isComputingSpectrogram
              ? "computing…"
              : isRecording || isMonitoring || trackActive
              ? "live"
              : "off"}
          </span>
        )}
      </div>
      {open && (
        <canvas
          ref={canvasRef}
          className="analysis-panel__canvas spectro-panel__canvas"
          style={{ cursor: trackActive && !isRecording ? "grab" : "default" }}
          onMouseDown={onCanvasMouseDown}
          onMouseMove={onCanvasMouseMove}
          onMouseUp={onCanvasMouseUp}
          onMouseLeave={onCanvasMouseUp}
        />
      )}
    </div>
  );
}
