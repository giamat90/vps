import { useRef, useEffect } from "react";
import { getMicAnalyser, getEngine, usePlayerStore } from "../../stores/player";
import { useExerciseStore } from "../../stores/exercise";
import { AXIS_W, LEGEND_WIDTH, F_MAX } from "../../lib/spectrogramMath";
import { drawIdleMessage } from "../../lib/spectrogramDraw";
import {
  BOTTOM_AXIS_H,
  buildSpectrumPoints,
  drawCurveFill,
  drawCurveSegments,
  drawDbGrid,
  drawDecadeGrid,
  drawEnvelope,
  drawLiveOverlay,
  drawVoiceMarkers,
  envelopeWithY,
  voiceMarkers,
} from "../../lib/spectroShortTerm";
import { computeMagnitudeSpectrumDb } from "../../lib/fft";
import { estimateVoice, type VoiceEstimate } from "../../lib/formants";
import { referenceF0 } from "../../audio/analysisUtils";
import { useAnalysisStore } from "../../stores/analysis";

// Matches the mic analyser's fftSize (see getMicAnalyser in stores/player.ts)
// so live and buffer-snapshot data are the same resolution.
const FFT_SIZE = 8192;

interface Source {
  sr: number;
  freqData: Float32Array;
  timeData: Float32Array;
}

interface PanelState {
  prevFormant: VoiceEstimate;
  timeScratch: Float32Array<ArrayBuffer> | null;
}

interface FrameFlags {
  trackActive: boolean;
  isMonitoring: boolean;
  anyInput: boolean;
}

interface Geometry {
  dpr: number;
  W: number;
  H: number;
  rollW: number;
  plotH: number;
  fMax: number;
}

function readSource(state: PanelState, trackActive: boolean): Source | null {
  if (trackActive) {
    const engineSr = getEngine().getExerciseTrackSampleRate();
    const samples = getEngine().getExerciseTrackSamples(FFT_SIZE, true);
    if (!engineSr || !samples) return null;
    return { sr: engineSr, timeData: samples, freqData: computeMagnitudeSpectrumDb(samples, FFT_SIZE) };
  }
  const analyser = getMicAnalyser();
  if (!analyser) return null;
  const data = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(data);
  if (!state.timeScratch || state.timeScratch.length !== analyser.fftSize) {
    state.timeScratch = new Float32Array(analyser.fftSize);
  }
  analyser.getFloatTimeDomainData(state.timeScratch);
  return { sr: analyser.context.sampleRate, freqData: data, timeData: state.timeScratch };
}

// F0 and the formants all come from the same window, so F0 is the pitch whose harmonics the curve shows.
function drawVoice(ctx: CanvasRenderingContext2D, state: PanelState, src: Source, trackActive: boolean, geo: Geometry): void {
  const voice = estimateVoice(src.timeData, src.sr, state.prevFormant);
  state.prevFormant = voice;
  // A loaded track has its stored SRH pitch (the piano roll's line); the live mic has only the estimate.
  const f0 = trackActive
    ? referenceF0(useAnalysisStore.getState().takePitch, getEngine().getCurrentTime(), voice.f0)
    : voice.f0;
  drawVoiceMarkers(ctx, voiceMarkers(f0, voice, geo.fMax, geo.rollW), geo.plotH, geo.dpr);
}

// Second input: the live mic overlaid on the loaded track's spectrum.
function drawMicOverlay(ctx: CanvasRenderingContext2D, geo: Geometry): void {
  const analyser = getMicAnalyser();
  if (!analyser) return;
  const liveData = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(liveData);
  const livePoints = buildSpectrumPoints(liveData, analyser.context.sampleRate, geo.rollW, geo.fMax, geo.plotH);
  drawLiveOverlay(ctx, envelopeWithY(livePoints, geo.plotH), geo.W, geo.plotH, geo.dpr);
}

function drawFrame(canvas: HTMLCanvasElement, state: PanelState, flags: FrameFlags): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const W = Math.round((canvas.clientWidth || 600) * dpr);
  const H = Math.round((canvas.clientHeight || 200) * dpr);
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const rollW = W - AXIS_W - LEGEND_WIDTH;
  const plotH = H - BOTTOM_AXIS_H * dpr;

  const src = readSource(state, flags.trackActive);
  const fMax = Math.min(F_MAX, (src?.sr ?? 48000) / 2);
  const geo: Geometry = { dpr, W, H, rollW, plotH, fMax };

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0f0f1e";
  ctx.fillRect(0, 0, W, H);
  drawDbGrid(ctx, W, plotH, dpr);
  drawDecadeGrid(ctx, rollW, plotH, fMax, dpr);

  if (!flags.anyInput || !src) {
    drawIdleMessage(ctx, AXIS_W + rollW / 2, plotH / 2, dpr);
    return;
  }

  const points = buildSpectrumPoints(src.freqData, src.sr, rollW, fMax, plotH);
  drawCurveSegments(ctx, points, dpr);
  drawCurveFill(ctx, points, plotH);
  drawEnvelope(ctx, points, plotH, dpr);
  drawVoice(ctx, state, src, flags.trackActive, geo);
  if (flags.trackActive && flags.isMonitoring) drawMicOverlay(ctx, geo);
}

export default function ShortTermSpectrumPanel() {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const isRecording  = usePlayerStore((s) => s.isRecording);
  const isMonitoring = usePlayerStore((s) => s.isMonitoring);
  const loadedTrackId = useExerciseStore((s) => s.loadedTrackId);
  // A loaded track snapshots its decoded buffer at the current playhead —
  // works whether playing, paused, or scrubbed, unlike a live AnalyserNode.
  const trackActive  = loadedTrackId !== null;
  const drawRef      = useRef<() => void>(() => {});
  const loggedRef    = useRef(false);
  const stateRef     = useRef<PanelState>({ prevFormant: { f0: null, f1: null, f2: null, f3: null }, timeScratch: null });

  useEffect(() => {
    if (!loggedRef.current) {
      loggedRef.current = true;
      console.log('[ShortTermSpectrum] panel active, height-colored stroke, sharing FLOOR/CEILING from spectrogram');
    }
  }, []);

  useEffect(() => {
    console.log('[ShortTermSpectrum] envelope overlay: moving-average, window 15-40 columns');
  }, []);

  useEffect(() => {
    drawRef.current = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      drawFrame(canvas, stateRef.current, {
        trackActive,
        isMonitoring,
        anyInput: isRecording || isMonitoring || trackActive,
      });
    };
  }, [isRecording, isMonitoring, trackActive]);

  useEffect(() => {
    let rafId: number;
    const tick = () => { drawRef.current(); rafId = requestAnimationFrame(tick); };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => drawRef.current());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="analysis-panel">
      <div className="analysis-panel__header">
        <span className="analysis-panel__label">Short-Term Spectrum</span>
        <span className="analysis-panel__hint">
          {isRecording || isMonitoring || trackActive ? "live" : "off"}
        </span>
      </div>
      <canvas ref={canvasRef} className="analysis-panel__canvas short-term-spectrum-panel__canvas" />
    </div>
  );
}
