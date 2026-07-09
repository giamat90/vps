import { useEffect, useRef, useState } from "react";
import { usePlayerStore, getEngine, type TrackKey } from "../../stores/player";
import TimeRuler from "./TimeRuler";
import type { Song } from "../../lib/types";
import { computeZoomToCursor, computePan, wheelDeltaPixels, clamp } from "../../lib/zoomPan";

interface WaveformProps {
  song: Song;
}

function PunchOverlay() {
  const punchIn      = usePlayerStore((s) => s.punchIn);
  const punchOut     = usePlayerStore((s) => s.punchOut);
  const duration     = usePlayerStore((s) => s.duration);
  const minPxPerSec  = usePlayerStore((s) => s.minPxPerSec);
  const scrollTime   = usePlayerStore((s) => s.scrollTime);
  if (punchIn === null || punchOut === null || duration <= 0) return null;
  return (
    <div
      className="waveform__punch-overlay"
      style={{
        left:  `${(punchIn - scrollTime) * minPxPerSec}px`,
        width: `${(punchOut - punchIn) * minPxPerSec}px`,
      }}
    />
  );
}

interface TrackControlsProps {
  track: TrackKey;
  volume: number;
  onVolumeChange: (v: number) => void;
}

function TrackControls({ track, volume, onVolumeChange }: TrackControlsProps) {
  const muted       = usePlayerStore((s) => s.mutedTracks[track]);
  const soloed      = usePlayerStore((s) => s.soloedTrack === track);
  const toggleMute  = usePlayerStore((s) => s.toggleMute);
  const toggleSolo  = usePlayerStore((s) => s.toggleSolo);

  return (
    <div className="waveform__track-controls">
      <button
        className={`waveform__mute${muted ? " waveform__mute--on" : ""}`}
        onClick={() => toggleMute(track)}
        title={muted ? "Unmute" : "Mute"}
      >
        M
      </button>
      <button
        className={`waveform__solo${soloed ? " waveform__solo--on" : ""}`}
        onClick={() => toggleSolo(track)}
        title={soloed ? "Unsolo" : "Solo this track"}
      >
        S
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={volume}
        onChange={(e) => onVolumeChange(Number(e.target.value))}
        className="waveform__volume"
      />
    </div>
  );
}

function Waveform({ song }: WaveformProps) {
  const timelineRef      = useRef<HTMLDivElement>(null);
  const vocalsRef        = useRef<HTMLDivElement>(null);
  const instrumentalRef  = useRef<HTMLDivElement>(null);
  const takeRef          = useRef<HTMLDivElement>(null);
  const loadSong         = usePlayerStore((s) => s.loadSong);
  const activeTakeId     = usePlayerStore((s) => s.activeTakeId);
  const takes            = usePlayerStore((s) => s.takes);
  const vocalsVolume       = usePlayerStore((s) => s.vocalsVolume);
  const instrumentalVolume = usePlayerStore((s) => s.instrumentalVolume);
  const takeVolume         = usePlayerStore((s) => s.takeVolume);
  const setVocalsVolume       = usePlayerStore((s) => s.setVocalsVolume);
  const setInstrumentalVolume = usePlayerStore((s) => s.setInstrumentalVolume);
  const setTakeVolume         = usePlayerStore((s) => s.setTakeVolume);
  const syncTrackVolumes      = usePlayerStore((s) => s.syncTrackVolumes);
  const isLoading        = useRef(false);
  const loadedTakeId     = useRef<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const isInstrument = song.kind === "instrument";

  useEffect(() => {
    if (!vocalsRef.current || !instrumentalRef.current || isLoading.current) return;

    isLoading.current = true;
    setLoadError(null);
    loadSong(song, vocalsRef.current, instrumentalRef.current)
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[Waveform] loadSong failed:", msg);
        setLoadError(msg);
      })
      .finally(() => { isLoading.current = false; });

    return () => { isLoading.current = false; };
  }, [song.id]);

  // Load (or clear) the take track whenever the active take changes.
  useEffect(() => {
    const eng = getEngine();
    if (!activeTakeId) {
      eng.clearTakeTrack();
      loadedTakeId.current = null;
      return;
    }
    if (activeTakeId === loadedTakeId.current) return;
    const take = takes.find((t) => t.id === activeTakeId);
    if (!take || !takeRef.current) return;
    loadedTakeId.current = activeTakeId;
    eng.loadTakeTrack(take.filepath, takeRef.current, take.startPosition, take.audioOffset ?? 0)
      .then(() => syncTrackVolumes())
      .catch((e: unknown) => console.error("[Waveform] loadTakeTrack failed:", e));
  }, [activeTakeId, takes]);

  // Ctrl+wheel zoom-to-cursor / shift+wheel pan. Attached as a native,
  // non-passive listener — React's onWheel prop is passive since React 17,
  // so preventDefault() there would not stop native ctrl+wheel page-zoom.
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      const { minPxPerSec, scrollTime, duration } = usePlayerStore.getState();
      if (duration <= 0) return;
      const eng = getEngine();
      eng.noteManualScrollInteraction();
      const rect = el.getBoundingClientRect();
      const cursorOffsetPx = e.clientX - rect.left;
      if (e.ctrlKey) {
        const { minPxPerSec: newPx, scrollTime: newScroll } = computeZoomToCursor({
          minPxPerSec, scrollTime, cursorOffsetPx, viewportWidthPx: rect.width, duration,
          deltaY: wheelDeltaPixels(e), minBound: eng.getMinPxPerSec(),
        });
        eng.zoomAll(newPx, newScroll);
        usePlayerStore.getState().setZoom(newPx, newScroll);
      } else {
        const newScroll = computePan({
          minPxPerSec, scrollTime, viewportWidthPx: rect.width, duration,
          deltaPx: wheelDeltaPixels(e, "x-or-y") * 1,
        });
        eng.setScrollAll(newScroll);
        usePlayerStore.getState().setScrollTime(newScroll);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Reclamp zoom/scroll on resize — zoom level persists, but the visible
  // window's bounds and the dynamic "whole song fits" lower bound both
  // depend on live container width.
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const { minPxPerSec, scrollTime, duration } = usePlayerStore.getState();
      if (duration <= 0) return;
      const eng = getEngine();
      const minBound = eng.getMinPxPerSec();
      const newPx = Math.max(minPxPerSec, minBound);
      const viewportWidthPx = el.getBoundingClientRect().width;
      const maxScroll = Math.max(0, duration - viewportWidthPx / newPx);
      const newScroll = clamp(scrollTime, 0, maxScroll);
      eng.zoomAll(newPx, newScroll);
      usePlayerStore.getState().setZoom(newPx, newScroll);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="waveform">
      {loadError && <div className="waveform__error">{loadError}</div>}

      <div className="waveform__timeline" ref={timelineRef}>
        <TimeRuler />

        <div className="waveform__track">
          <div className="waveform__track-header">
            <span className="waveform__label">{isInstrument ? "Melody" : "Vocals"}</span>
            <TrackControls track="vocals" volume={vocalsVolume} onVolumeChange={setVocalsVolume} />
          </div>
          <div className="waveform__track-body">
            <div className="waveform__container" ref={vocalsRef} />
            <PunchOverlay />
          </div>
        </div>

        {/* Instrumental track is a required mount for AudioEngine.load() even
            for instrument-kind songs (where it's a silent duplicate of the
            melody track, muted in player.ts) - keep it in the DOM but hide
            its chrome so the user isn't shown a redundant waveform. */}
        <div className={`waveform__track${isInstrument ? " waveform__track--hidden" : ""}`}>
          <div className="waveform__track-header">
            <span className="waveform__label">Instrumental</span>
            <TrackControls track="instrumental" volume={instrumentalVolume} onVolumeChange={setInstrumentalVolume} />
          </div>
          <div className="waveform__track-body">
            <div className="waveform__container" ref={instrumentalRef} />
            <PunchOverlay />
          </div>
        </div>

        {activeTakeId && (
          <div className="waveform__track">
            <div className="waveform__track-header">
              <span className="waveform__label waveform__label--take">Take</span>
              <TrackControls track="take" volume={takeVolume} onVolumeChange={setTakeVolume} />
            </div>
            <div className="waveform__track-body">
              <div className="waveform__take-rail">
                <div ref={takeRef} />
              </div>
              <PunchOverlay />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default Waveform;
