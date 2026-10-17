import { useRef, useEffect } from "react";
import { useAnalysisStore } from "../../stores/analysis";
import { useVoiceViewStore } from "../../stores/voiceView";
import { MAIN_VOICES, isMainVoice } from "../../lib/voices";
import { usePlayerStore } from "../../stores/player";
import { getPlaybackTime } from "../../windows/playbackClock";
import {
  PIANO_WINDOW_DEFAULT_MIN,
  computePianoWindowTarget,
  stepPianoWindow,
} from "../../lib/constants";
import type { PitchPoint } from "../../lib/types";
import { getCurrentMidi, COLOR_SONG, COLOR_SONG_ALT, COLOR_TAKE, COLOR_LIVE } from "./PianoKeyboard";
import { startPreviewNote, startPreview, endPreview, getPreviewState, type PreviewVoice } from "../../audio/notePreview";
import { PIANO_W, WINDOW_S, midiFromY, type PianoColors } from "../../lib/pianoRollGeometry";
import {
  drawLanes,
  drawNoteLabel,
  drawPianoStrip,
  drawPlayhead,
  drawPreviewVoice,
  drawRibbon,
  drawRuler,
} from "../../lib/pianoRollDraw";
import {
  NO_DRAG,
  beginPunchDrag,
  finishPunchDrag,
  hoverCursor,
  updatePunchOverride,
  xToTime,
  type PunchCommit,
  type PunchDrag,
  type PunchOverride,
} from "../../lib/pianoRollPunch";
import { windowDragTime } from "../../lib/spectroUtils";

const COLORS: PianoColors = { song: COLOR_SONG, songAlt: COLOR_SONG_ALT, take: COLOR_TAKE, live: COLOR_LIVE };

interface RollData {
  songPitch: PitchPoint[];
  songPitchAlt: PitchPoint[];
  takePitch: PitchPoint[];
  livePitch: PitchPoint[];
  isLoaded: boolean;
  showMultipleLines: boolean;
}

function drawRulerCanvas(ruler: HTMLCanvasElement | null, override: PunchOverride | null, punchIn: number | null, punchOut: number | null): void {
  if (!ruler) return;
  const rW = ruler.offsetWidth || 600;
  const rH = ruler.offsetHeight || 20;
  if (ruler.width !== rW || ruler.height !== rH) {
    ruler.width = rW;
    ruler.height = rH;
  }
  const rCtx = ruler.getContext("2d");
  if (!rCtx) return;
  drawRuler(
    rCtx, rW, rH, getPlaybackTime(),
    override ? override.inT : punchIn,
    override ? override.outT : punchOut,
  );
}

function drawPreview(ctx: CanvasRenderingContext2D, H: number, midiMin: number, t0: number, currentTime: number, timeToX: (t: number) => number): number | null {
  const preview = getPreviewState();
  if (preview.midi !== null) {
    drawPreviewVoice(
      ctx, H, midiMin, preview.midi,
      timeToX(Math.max(preview.startTime, t0)), timeToX(preview.endTime ?? currentTime),
    );
  }
  return preview.midi;
}

function drawEmptyRoll(ctx: CanvasRenderingContext2D, W: number, H: number, midiMin: number, t0: number, currentTime: number, timeToX: (t: number) => number): void {
  ctx.fillStyle = "#a0a0b060";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("No pitch data", (PIANO_W + W) / 2, H / 2);
  const previewMidi = drawPreview(ctx, H, midiMin, t0, currentTime, timeToX);
  drawPianoStrip(ctx, H, midiMin, { song: null, take: null, live: null, preview: previewMidi, alt: null }, COLORS);
}

function drawLoadedRoll(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  windowMin: { current: number },
  d: RollData,
  t0: number,
  t1: number,
  currentTime: number,
  timeToX: (t: number) => number,
): void {
  const songMidi = getCurrentMidi(d.songPitch, currentTime);
  const takeMidi = getCurrentMidi(d.takePitch, currentTime);
  const liveMidi = getCurrentMidi(d.livePitch, currentTime);
  const showAlt = d.showMultipleLines && d.songPitchAlt.length > 0;
  const altMidi = showAlt ? getCurrentMidi(d.songPitchAlt, currentTime) : null;

  // Slide the visible window to follow whichever pitch is active
  // (live > take > song), staying put when nothing is currently sounding.
  const target = computePianoWindowTarget(liveMidi ?? takeMidi ?? songMidi, windowMin.current);
  windowMin.current = stepPianoWindow(windowMin.current, target);
  const midiMin = windowMin.current;

  drawLanes(ctx, W, H, midiMin);
  // Under the main line: where the two voices cross, the main one stays readable.
  if (showAlt) drawRibbon(ctx, d.songPitchAlt, COLOR_SONG_ALT, t0, t1, H, midiMin, timeToX);
  drawRibbon(ctx, d.songPitch, COLOR_SONG, t0, t1, H, midiMin, timeToX);
  if (d.takePitch.length > 0) drawRibbon(ctx, d.takePitch, COLOR_TAKE, t0, t1, H, midiMin, timeToX);
  if (d.livePitch.length > 0) drawRibbon(ctx, d.livePitch, COLOR_LIVE, t0, t1, H, midiMin, timeToX);
  const previewMidi = drawPreview(ctx, H, midiMin, t0, currentTime, timeToX);
  drawPlayhead(ctx, W, H);
  drawNoteLabel(ctx, W, d.songPitch, d.takePitch, d.livePitch, currentTime, COLORS);
  drawPianoStrip(ctx, H, midiMin, { song: songMidi, take: takeMidi, live: liveMidi, preview: previewMidi, alt: altMidi }, COLORS);
}

function drawRoll(canvas: HTMLCanvasElement, windowMin: { current: number }, d: RollData): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const W = canvas.offsetWidth || 600;
  const H = canvas.offsetHeight || 240;
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0f0f1e";
  ctx.fillRect(0, 0, W, H);

  const currentTime = getPlaybackTime();
  const t0 = currentTime - WINDOW_S / 2;
  const t1 = currentTime + WINDOW_S / 2;
  const rollW = W - PIANO_W;
  const timeToX = (t: number) => PIANO_W + ((t - currentTime + WINDOW_S / 2) / WINDOW_S) * rollW;

  if (!d.isLoaded && d.livePitch.length === 0 && d.takePitch.length === 0) {
    drawEmptyRoll(ctx, W, H, windowMin.current, t0, currentTime, timeToX);
    return;
  }
  drawLoadedRoll(ctx, W, H, windowMin, d, t0, t1, currentTime, timeToX);
}

// ─── component ───────────────────────────────────────────────────────────────

export default function PianoRoll() {
  const canvasRef        = useRef<HTMLCanvasElement>(null);
  const rulerRef         = useRef<HTMLCanvasElement>(null);
  const songPitch        = useAnalysisStore((s) => s.songPitch);
  const songPitchAlt     = useAnalysisStore((s) => s.songPitchAlt);
  const showMultipleLines = useVoiceViewStore((s) => s.showMultipleLines);
  const setShowMultipleLines = useVoiceViewStore((s) => s.setShowMultipleLines);
  const mainVoice        = useVoiceViewStore((s) => s.mainVoice);
  const setMainVoice     = useVoiceViewStore((s) => s.setMainVoice);
  const takePitch        = useAnalysisStore((s) => s.takePitch);
  const livePitch        = useAnalysisStore((s) => s.livePitch);
  const isLoaded         = useAnalysisStore((s) => s.isLoaded);
  const isRecording      = usePlayerStore((s) => s.isRecording);
  const exerciseMode     = usePlayerStore((s) => s.exerciseMode);
  const songLabel        = usePlayerStore((s) => (s.song?.kind === "instrument" ? "Piano" : "Song"));
  const punchIn          = usePlayerStore((s) => s.punchIn);
  const punchOut         = usePlayerStore((s) => s.punchOut);
  const duration         = usePlayerStore((s) => s.duration);
  const setPunchIn       = usePlayerStore((s) => s.setPunchIn);
  const setPunchOut      = usePlayerStore((s) => s.setPunchOut);
  const clearPunch       = usePlayerStore((s) => s.clearPunch);
  const seek             = usePlayerStore((s) => s.seek);
  const selectedOutputDeviceId = usePlayerStore((s) => s.selectedOutputDeviceId);

  const drawRef = useRef<() => void>(() => {});
  const windowMinRef = useRef<number>(PIANO_WINDOW_DEFAULT_MIN);

  const rulerDrag = useRef<PunchDrag>(NO_DRAG);

  const rulerOverride = useRef<PunchOverride | null>(null);

  const rollDrag = useRef<{ active: boolean; startX: number; startTime: number }>({
    active: false,
    startX: 0,
    startTime: 0,
  });

  const stripDrag = useRef<{
    active: boolean;
    lastMidi: number | null;
    voice: PreviewVoice | null;
    startTime: number;
  }>({
    active: false,
    lastMidi: null,
    voice: null,
    startTime: 0,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    drawRef.current = () => {
      drawRulerCanvas(rulerRef.current, rulerOverride.current, punchIn, punchOut);
      drawRoll(canvas, windowMinRef, { songPitch, songPitchAlt, takePitch, livePitch, isLoaded, showMultipleLines });
    };

    drawRef.current();
  }, [songPitch, songPitchAlt, showMultipleLines, takePitch, livePitch, isLoaded, punchIn, punchOut, isRecording]);

  useEffect(() => {
    if (!isLoaded && !exerciseMode) return;
    let rafId: number;
    const tick = () => { drawRef.current(); rafId = requestAnimationFrame(tick); };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isLoaded, exerciseMode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ruler  = rulerRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => drawRef.current());
    ro.observe(canvas);
    if (ruler) ro.observe(ruler);
    return () => ro.disconnect();
  }, []);

  // ── ruler mouse handlers (punch region) ─────────────────────────────────────

  const onRulerMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isRecording) return;
    const canvas = rulerRef.current;
    if (!canvas) return;
    e.preventDefault();

    const begun = beginPunchDrag(
      e.nativeEvent.offsetX, canvas.offsetWidth - PIANO_W, getPlaybackTime() - WINDOW_S / 2, punchIn, punchOut,
    );
    rulerDrag.current = begun.drag;
    rulerOverride.current = begun.override;
  };

  const onRulerMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = rulerRef.current;
    if (!canvas) return;
    const drag = rulerDrag.current;
    const rollW = canvas.offsetWidth - PIANO_W;
    const x = e.nativeEvent.offsetX;

    if (drag.mode) {
      rulerOverride.current = updatePunchOverride(drag, xToTime(x, drag.capturedT0, rollW));
    } else if (!isRecording && punchIn !== null && punchOut !== null) {
      canvas.style.cursor = hoverCursor(x, rollW, getPlaybackTime(), punchIn, punchOut);
    }
  };

  const commitPunch = (commit: PunchCommit) => {
    if (commit.type === "in") setPunchIn(commit.t);
    else if (commit.type === "out") setPunchOut(commit.t);
    else if (commit.type === "clear") clearPunch();
    else {
      setPunchIn(commit.inT);
      setPunchOut(commit.outT);
    }
  };

  const onRulerMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = rulerRef.current;
    if (!canvas) return;
    const drag = rulerDrag.current;
    if (!drag.mode) return;
    rulerDrag.current = { ...drag, mode: null };

    commitPunch(finishPunchDrag(drag, xToTime(e.nativeEvent.offsetX, drag.capturedT0, canvas.offsetWidth - PIANO_W)));

    rulerOverride.current = null;
    canvas.style.cursor = isRecording ? "default" : "crosshair";
  };

  const onRulerMouseLeave = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (rulerDrag.current.mode) onRulerMouseUp(e);
    else if (rulerRef.current) rulerRef.current.style.cursor = "default";
  };

  // ── main canvas drag-to-seek ─────────────────────────────────────────────────

  const playNote = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const H = canvasRef.current?.offsetHeight ?? 0;
    const midi = midiFromY(e.nativeEvent.offsetY, H, windowMinRef.current);
    const now = getPlaybackTime();
    stripDrag.current.voice?.release();
    stripDrag.current = {
      active: true,
      lastMidi: midi,
      voice: startPreviewNote(midi, selectedOutputDeviceId),
      startTime: now,
    };
    startPreview(midi, now);
  };

  const onCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isRecording) return;
    const x = e.nativeEvent.offsetX;
    if (x < PIANO_W) {
      playNote(e);
      return;
    }
    rollDrag.current = { active: true, startX: x, startTime: getPlaybackTime() };
  };

  const onCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (stripDrag.current.active) {
      const H = canvasRef.current?.offsetHeight ?? 0;
      if (midiFromY(e.nativeEvent.offsetY, H, windowMinRef.current) !== stripDrag.current.lastMidi) playNote(e);
      return;
    }
    if (!rollDrag.current.active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { startX, startTime } = rollDrag.current;
    const t = windowDragTime(startTime, startX, e.nativeEvent.offsetX, canvas.offsetWidth - PIANO_W, WINDOW_S, duration);
    if (t !== null) seek(t);
  };

  const onCanvasMouseUp = () => {
    rollDrag.current.active = false;
    if (stripDrag.current.active) {
      stripDrag.current.voice?.release();
      stripDrag.current.active = false;
      stripDrag.current.voice = null;
      endPreview(getPlaybackTime());
    }
  };

  const hasSecondVoice = songPitchAlt.length > 0;
  const noSecondVoiceHint = "No second voice was found in this song";

  return (
    <div className="analysis-panel">
      <div className="analysis-panel__header">
        <span className="analysis-panel__label">Piano Roll</span>
        <div className="analysis-panel__legend">
          <span className="legend-dot legend-dot--song-ribbon" />
          <span>{songLabel}</span>
          {showMultipleLines && hasSecondVoice && (
            <>
              <span className="legend-dot legend-dot--song-alt" />
              <span>Second voice</span>
            </>
          )}
          {takePitch.length > 0 && (
            <>
              <span className="legend-dot legend-dot--take" />
              <span>Your voice</span>
            </>
          )}
          {isRecording && (
            <>
              <span className="legend-dot legend-dot--live" />
              <span>Live</span>
            </>
          )}
        </div>
        {!exerciseMode && (
          <div className="piano-roll__voices">
            <label className="piano-roll__main-voice">
              <span>Main line</span>
              <select
                value={mainVoice}
                disabled={!hasSecondVoice}
                title={hasSecondVoice ? "Which voice is the main line where two sing" : noSecondVoiceHint}
                onChange={(e) => {
                  if (isMainVoice(e.target.value)) setMainVoice(e.target.value);
                }}
              >
                {MAIN_VOICES.map((v) => (
                  <option key={v.id} value={v.id}>{v.label}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={`piano-roll__toggle${showMultipleLines ? " piano-roll__toggle--on" : ""}`}
              aria-pressed={showMultipleLines}
              disabled={!hasSecondVoice}
              title={hasSecondVoice ? "Draw the second singer in a lighter line" : noSecondVoiceHint}
              onClick={() => setShowMultipleLines(!showMultipleLines)}
            >
              Show multiple lines
            </button>
          </div>
        )}
      </div>
      <div className="piano-roll__ruler-wrap">
        <canvas
          ref={rulerRef}
          className="piano-roll__ruler"
          onMouseDown={onRulerMouseDown}
          onMouseMove={onRulerMouseMove}
          onMouseUp={onRulerMouseUp}
          onMouseLeave={onRulerMouseLeave}
          style={{ cursor: isRecording ? "default" : "crosshair" }}
        />
      </div>
      <canvas
        ref={canvasRef}
        className="analysis-panel__canvas analysis-panel__canvas--piano-roll"
        style={{ cursor: isRecording ? "default" : "grab" }}
        onMouseDown={onCanvasMouseDown}
        onMouseMove={onCanvasMouseMove}
        onMouseUp={onCanvasMouseUp}
        onMouseLeave={onCanvasMouseUp}
      />
    </div>
  );
}
