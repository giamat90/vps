import { useRef, useEffect } from "react";
import { useAnalysisStore } from "../../stores/analysis";
import { usePlayerStore } from "../../stores/player";
import { getPlaybackTime } from "../../windows/playbackClock";
import { getSpectrumSource } from "../../windows/spectrumRegistry";
import { drawComparisonFrame } from "../../lib/spectroComparison";
import { COLOR_SONG, COLOR_SONG_ALT, COLOR_TAKE, COLOR_LIVE } from "./PianoKeyboard";
import { useVoiceViewStore } from "../../stores/voiceView";

const COLORS = { song: COLOR_SONG, songAlt: COLOR_SONG_ALT, take: COLOR_TAKE, live: COLOR_LIVE };

export default function ShortTermSpectrumComparisonPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const songSTSpectrum = useAnalysisStore((s) => s.songSTSpectrum);
  const takeSTSpectrum = useAnalysisStore((s) => s.takeSTSpectrum);
  const isLoaded = useAnalysisStore((s) => s.isLoaded);
  const isRecording = usePlayerStore((s) => s.isRecording);
  const isMonitoring = usePlayerStore((s) => s.isMonitoring);
  const drawRef = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    getSpectrumSource().reset();

    drawRef.current = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const W = Math.round((canvas.clientWidth || 600) * dpr);
      const H = Math.round((canvas.clientHeight || 200) * dpr);
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }

      const source = getSpectrumSource();
      const { songPitch, songPitchAlt, takePitch } = useAnalysisStore.getState();
      drawComparisonFrame(ctx, {
        W,
        H,
        dpr,
        time: getPlaybackTime(),
        song: songSTSpectrum,
        take: takeSTSpectrum,
        live: isRecording || isMonitoring ? source.getLiveSpectrum() : null,
        source,
        colors: COLORS,
        songPitch,
        songPitchAlt,
        takePitch,
        showSecondVoice: useVoiceViewStore.getState().showMultipleLines,
      });
    };

    drawRef.current();
  }, [songSTSpectrum, takeSTSpectrum, isRecording, isMonitoring]);

  useEffect(() => {
    if (!isLoaded && !isRecording && !isMonitoring) return;
    let rafId: number;
    const tick = () => { drawRef.current(); rafId = requestAnimationFrame(tick); };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isLoaded, isRecording, isMonitoring]);

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
        <div className="analysis-panel__legend">
          <span className="legend-dot legend-dot--song" />
          <span>Song</span>
          {(isRecording || isMonitoring) ? (
            <>
              <span className="legend-dot legend-dot--live" />
              <span>Live</span>
            </>
          ) : takeSTSpectrum && (
            <>
              <span className="legend-dot legend-dot--take" />
              <span>Your voice</span>
            </>
          )}
        </div>
      </div>
      <canvas ref={canvasRef} className="analysis-panel__canvas short-term-spectrum-panel__canvas" />
    </div>
  );
}
