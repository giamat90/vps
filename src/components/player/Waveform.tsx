import { useEffect, useRef, useState, type ChangeEvent, type FocusEvent, type KeyboardEvent } from "react";
import { usePlayerStore, getEngine, takesSilenced, type TrackKey } from "../../stores/player";
import { useAnalysisStore } from "../../stores/analysis";
import TimeRuler from "./TimeRuler";
import type { Song, Take } from "../../lib/types";
import { computeZoomToCursor, computePan, wheelDeltaPixels, clamp } from "@giamat90/mps-core/zoomPan";
import { audibleTakes, takeSilence, type TakeSilence } from "@giamat90/mps-core/takes";

// Live-preview analysis updates during a take drag are throttled to the same
// ~30fps notification rate the audio engine's rAF tick already uses, since
// each call re-derives PitchPoint/onset/dynamics arrays and would otherwise
// fire on every raw pointermove (which can exceed 60/s on a high-poll mouse).
const TAKE_PREVIEW_THROTTLE_MS = 33;

// Chunk-based alternative to dragging: fine enough to correct residual sync
// error left after latency calibration (perceptible misalignment starts
// around 20-30ms), without needing many presses for larger corrections.
const TAKE_NUDGE_STEP_S = 0.01;
const TAKE_NUDGE_COARSE_MULTIPLIER = 5; // Shift+Arrow = 50ms

interface WaveformProps {
  song: Song;
}

/** What the selected take's lane says about itself; the selection must be visible even when it is silent. */
function selectedTakeLabel(playback: "all" | "selected", silence: TakeSilence | null): { text: string; hint: string } {
  switch (silence) {
    case null:
      return playback === "selected"
        ? { text: "\u25B6 Playing", hint: "The selected take is the one you hear." }
        : { text: "Selected", hint: "The selected take. Click another take's name to select it instead." };
    case "muted":
      return { text: "Selected \u00B7 muted", hint: "This take is selected but muted on its own lane: press M on the lane to hear it." };
    case "channel":
      return { text: "Selected \u00B7 takes muted", hint: "This take is selected, but the main take mute (or another track's solo) silences every take." };
    case "recording":
      return { text: "Selected \u00B7 silent while recording", hint: "Takes are silent while recording; see the toggle in the takes bar." };
    case "soloed-other":
      return { text: "Selected \u00B7 another take soloed", hint: "Another take is soloed on its lane, so only that one plays." };
    default:
      return { text: "Selected", hint: "The selected take." };
  }
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
  const forTakes    = track === "take";

  return (
    <div className="waveform__track-controls">
      <button
        className={`waveform__mute${muted ? " waveform__mute--on" : ""}`}
        onClick={() => toggleMute(track)}
        title={
          forTakes
            ? muted
              ? "Unmute the takes"
              : "Mute all the takes. This main mute wins over the mute and solo on each take."
            : muted
              ? "Unmute"
              : "Mute"
        }
      >
        M
      </button>
      <button
        className={`waveform__solo${soloed ? " waveform__solo--on" : ""}`}
        onClick={() => toggleSolo(track)}
        title={
          forTakes
            ? soloed
              ? "Stop soloing the takes"
              : "Solo the takes: only the takes are heard and the other tracks go quiet. Solo on a take then picks one take among them."
            : soloed
              ? "Unsolo"
              : "Solo this track"
        }
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

// Drag handle for manually nudging the take's sync position; commits a
// 0.1s-rounded offset on release. Uses pointer capture (not plain mouse
// events, unlike TimeRuler's full-width canvas) since this is a small
// element and the drag needs to keep tracking even once the cursor leaves it.
// Unclamped in both directions — dragging left of song time 0 is allowed
// (the leading part of the take before song time 0 just isn't reachable
// during playback; the recorded file itself is never trimmed or modified).
function TakeSyncControls({ take, isActive }: { take: Take; isActive: boolean }) {
  const minPxPerSec = usePlayerStore((s) => s.minPxPerSec);
  const setTakeManualOffset = usePlayerStore((s) => s.setTakeManualOffset);
  const previewTakeManualOffset = useAnalysisStore((s) => s.previewTakeManualOffset);
  const dragRef = useRef<{ startX: number; startOffset: number; dragging: boolean } | null>(null);
  const lastPreviewAt = useRef(0);
  const [dragging, setDragging] = useState(false);
  const offsetMs = Math.round((take.manualOffset ?? 0) * 1000);
  // Editable offset field: lets the user jump straight to a rough value (e.g.
  // type 300 for a ~300ms drift) instead of nudging up from 0, then fine-tune
  // with the nudge buttons/arrow keys from there. Local text state so partial
  // input (e.g. a lone "-") doesn't get clobbered by the next store-derived
  // render; only re-synced from the store while the field isn't focused.
  const [offsetInput, setOffsetInput] = useState(String(offsetMs));
  const inputFocused = useRef(false);

  useEffect(() => {
    if (!inputFocused.current) setOffsetInput(String(offsetMs));
  }, [offsetMs]);

  const commitOffsetInput = () => {
    const parsedMs = Number(offsetInput);
    if (Number.isFinite(parsedMs)) {
      setTakeManualOffset(take.id, parsedMs / 1000);
    } else {
      setOffsetInput(String(offsetMs));
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startOffset: take.manualOffset ?? 0, dragging: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const deltaPx = e.clientX - d.startX;
    if (!d.dragging) {
      if (Math.abs(deltaPx) < 3) return;
      d.dragging = true;
      setDragging(true);
    }
    const newOffset = d.startOffset + deltaPx / minPxPerSec;
    getEngine().setTakeManualOffset(take.id, newOffset);
    // Live-track PianoRoll/ShortTermSpectrumComparisonPanel so the user can
    // eyeball pitch/spectral alignment while still dragging, not just after
    // release — throttled since each call re-derives point arrays. Those
    // overlays show the active take only.
    const now = performance.now();
    if (isActive && now - lastPreviewAt.current >= TAKE_PREVIEW_THROTTLE_MS) {
      lastPreviewAt.current = now;
      previewTakeManualOffset(take, newOffset);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    if (!d || !d.dragging) return;
    const deltaPx = e.clientX - d.startX;
    const newOffset = d.startOffset + deltaPx / minPxPerSec;
    setTakeManualOffset(take.id, newOffset);
  };

  const nudge = (direction: 1 | -1, coarse: boolean) => {
    const step = TAKE_NUDGE_STEP_S * (coarse ? TAKE_NUDGE_COARSE_MULTIPLIER : 1) * direction;
    setTakeManualOffset(take.id, (take.manualOffset ?? 0) + step);
  };

  // Scoped (not global) so arrow keys only nudge while this control has
  // focus — click it or Tab to it. Avoids claiming the arrow keys app-wide
  // since there's no other keyboard shortcut in the app yet to coordinate with.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    nudge(e.key === "ArrowLeft" ? -1 : 1, e.shiftKey);
  };

  return (
    <div
      className="waveform__take-sync"
      tabIndex={0}
      role="group"
      aria-label="Take sync offset"
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        className={`waveform__take-drag${dragging ? " waveform__take-drag--active" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        title="Drag to nudge take into sync with the other tracks"
      >
        ⠿
      </button>
      <button
        type="button"
        className="waveform__take-nudge"
        onClick={() => nudge(-1, false)}
        title="Nudge 10ms earlier (Shift: 50ms). Click here first, then use ←/→ arrow keys."
      >
        ◀
      </button>
      <input
        type="number"
        step={10}
        className="waveform__take-offset"
        value={offsetInput}
        onChange={(e: ChangeEvent<HTMLInputElement>) => setOffsetInput(e.target.value)}
        onFocus={(e: FocusEvent<HTMLInputElement>) => {
          inputFocused.current = true;
          e.target.select();
        }}
        onBlur={() => {
          inputFocused.current = false;
          commitOffsetInput();
        }}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          // Stop the container's arrow-nudge handler from firing while typing —
          // arrow keys here should move the text cursor / number step, not nudge.
          e.stopPropagation();
          if (e.key === "Enter") {
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setOffsetInput(String(offsetMs));
            e.currentTarget.blur();
          }
        }}
        title="Take offset in milliseconds — type a value (e.g. 300) and press Enter to jump there, then fine-tune with the nudge buttons or arrow keys"
        aria-label="Take offset in milliseconds"
      /><span className="waveform__take-offset-unit">ms</span>
      <button
        type="button"
        className="waveform__take-nudge"
        onClick={() => nudge(1, false)}
        title="Nudge 10ms later (Shift: 50ms). Click here first, then use ←/→ arrow keys."
      >
        ▶
      </button>
      <button
        type="button"
        className="waveform__take-reset"
        disabled={!take.manualOffset}
        onClick={() => setTakeManualOffset(take.id, 0)}
        title="Reset to auto-detected position"
      >
        ↺
      </button>
    </div>
  );
}

function Waveform({ song }: WaveformProps) {
  const timelineRef      = useRef<HTMLDivElement>(null);
  const vocalsRef        = useRef<HTMLDivElement>(null);
  const instrumentalRef  = useRef<HTMLDivElement>(null);
  const loadSong         = usePlayerStore((s) => s.loadSong);
  const activeTakeId     = usePlayerStore((s) => s.activeTakeId);
  const shownTakeIds     = usePlayerStore((s) => s.shownTakeIds);
  const takes            = usePlayerStore((s) => s.takes);
  const vocalsVolume       = usePlayerStore((s) => s.vocalsVolume);
  const instrumentalVolume = usePlayerStore((s) => s.instrumentalVolume);
  const takeVolume         = usePlayerStore((s) => s.takeVolume);
  const setVocalsVolume       = usePlayerStore((s) => s.setVocalsVolume);
  const setInstrumentalVolume = usePlayerStore((s) => s.setInstrumentalVolume);
  const setTakeVolume         = usePlayerStore((s) => s.setTakeVolume);
  const setActiveTake         = usePlayerStore((s) => s.setActiveTake);
  const hideTake              = usePlayerStore((s) => s.hideTake);
  const takePlayback          = usePlayerStore((s) => s.takePlayback);
  const mutedTakeIds          = usePlayerStore((s) => s.mutedTakeIds);
  const isRecording           = usePlayerStore((s) => s.isRecording);
  const muteTakesWhileRecording = usePlayerStore((s) => s.muteTakesWhileRecording);
  const setTakePlayback       = usePlayerStore((s) => s.setTakePlayback);
  const toggleTakeMute        = usePlayerStore((s) => s.toggleTakeMute);
  const toggleTakeSolo        = usePlayerStore((s) => s.toggleTakeSolo);
  const setTakeGain           = usePlayerStore((s) => s.setTakeGain);
  const takeGains             = usePlayerStore((s) => s.takeGains);
  const soloedTakeId          = usePlayerStore((s) => s.soloedTakeId);
  const takeChannelSilent     = usePlayerStore((s) => takesSilenced(s));
  const setMuteTakesWhileRecording = usePlayerStore((s) => s.setMuteTakesWhileRecording);
  const syncTrackVolumes      = usePlayerStore((s) => s.syncTrackVolumes);
  const isLoading        = useRef(false);
  // Lane containers by take id, and the takes currently loaded into the engine
  const takeRails        = useRef(new Map<string, HTMLDivElement>());
  const loadedTakes      = useRef(new Set<string>());
  const [loadError, setLoadError] = useState<string | null>(null);
  const isInstrument = song.kind === "instrument";
  const shownTakes = shownTakeIds
    .map((id) => takes.find((t) => t.id === id))
    .filter((t): t is Take => t !== undefined);
  const audibility = {
    shown: shownTakeIds,
    active: activeTakeId,
    playback: takePlayback,
    muted: mutedTakeIds,
    recording: isRecording,
    muteWhileRecording: muteTakesWhileRecording,
    soloed: soloedTakeId,
    silenced: takeChannelSilent,
  };
  const audibleIds = audibleTakes(audibility);

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

  // Keep the engine's take tracks in step with the lanes on screen: load the
  // ones that appeared, drop the ones that were hidden or deleted.
  useEffect(() => {
    const eng = getEngine();
    const wanted = new Set(shownTakes.map((t) => t.id));
    for (const id of [...loadedTakes.current]) {
      if (wanted.has(id)) continue;
      eng.removeTakeTrack(id);
      loadedTakes.current.delete(id);
    }
    for (const take of shownTakes) {
      const rail = takeRails.current.get(take.id);
      if (loadedTakes.current.has(take.id) || !rail) continue;
      loadedTakes.current.add(take.id);
      eng.loadTakeTrack(take.id, take.filepath, rail, take.startPosition, take.audioOffset ?? 0, take.manualOffset ?? 0)
        .then(() => syncTrackVolumes())
        .catch((e: unknown) => {
          loadedTakes.current.delete(take.id);
          console.error("[Waveform] loadTakeTrack failed:", e);
        });
    }
  }, [shownTakeIds, takes]);

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

        {shownTakes.length > 0 && (
          <div className="waveform__takes-bar">
            <span className="waveform__label waveform__label--take">Takes</span>
            <button
              type="button"
              className="waveform__takes-toggle"
              aria-pressed={takePlayback === "all"}
              onClick={() => setTakePlayback(takePlayback === "all" ? "selected" : "all")}
              title={
                takePlayback === "all"
                  ? "All shown takes play together; use M on a lane to silence one. Click to hear only the selected take."
                  : "Only the selected take plays; click another take to switch. Click to play all shown takes together."
              }
            >
              {takePlayback === "all" ? "Hear: all shown" : "Hear: selected only"}
            </button>
            <button
              type="button"
              className="waveform__takes-toggle"
              aria-pressed={muteTakesWhileRecording}
              onClick={() => setMuteTakesWhileRecording(!muteTakesWhileRecording)}
              title={
                muteTakesWhileRecording
                  ? "Takes are silent while you record. Click to keep hearing them."
                  : "Takes keep playing while you record. Click to silence them while recording."
              }
            >
              {muteTakesWhileRecording ? "Silent while recording" : "Playing while recording"}
            </button>
            <TrackControls track="take" volume={takeVolume} onVolumeChange={setTakeVolume} />
          </div>
        )}
        {shownTakes.map((take) => {
          const isActive = take.id === activeTakeId;
          const isAudible = audibleIds.includes(take.id);
          const isMuted = mutedTakeIds.includes(take.id);
          const isSoloed = soloedTakeId === take.id;
          const selectedLabel = isActive ? selectedTakeLabel(takePlayback, takeSilence(audibility, take.id)) : null;
          const label = take.name || `Take ${takes.indexOf(take) + 1}`;
          return (
            <div
              key={take.id}
              className={`waveform__track waveform__track--take${isActive ? " waveform__track--active" : ""}${isAudible ? "" : " waveform__track--silent"}`}
            >
              <div className="waveform__track-header">
                <div className="waveform__take-heading">
                  <button
                    type="button"
                    className="waveform__label waveform__label--take waveform__take-name"
                    onClick={() => setActiveTake(take.id)}
                    title={
                      takePlayback === "selected" && !isActive
                        ? "Play this take instead"
                        : isActive
                          ? "This is the selected take"
                          : "Select this take"
                    }
                    aria-pressed={isActive}
                  >
                    {label}
                  </button>
                  {selectedLabel && (
                    <span
                      className={`waveform__take-state${takeSilence(audibility, take.id) ? " waveform__take-state--silent" : ""}`}
                      title={selectedLabel.hint}
                    >
                      {selectedLabel.text}
                    </span>
                  )}
                  <button
                    type="button"
                    className="waveform__take-hide"
                    onClick={() => hideTake(take.id)}
                    title="Hide this take (it stays in the list)"
                    aria-label={`Hide ${label}`}
                  >
                    &times;
                  </button>
                </div>
                <TakeSyncControls take={take} isActive={isActive} />
                <div className="waveform__track-controls">
                  <button
                    type="button"
                    className={`waveform__mute${isMuted ? " waveform__mute--on" : ""}`}
                    onClick={() => toggleTakeMute(take.id)}
                    aria-pressed={isMuted}
                    aria-label={isMuted ? `Unmute ${label}` : `Mute ${label}`}
                    title={
                      isMuted
                        ? `Unmute ${label}`
                        : `Mute ${label}. The main take mute and solo above still come first.`
                    }
                  >
                    M
                  </button>
                  <button
                    type="button"
                    className={`waveform__solo${isSoloed ? " waveform__solo--on" : ""}`}
                    onClick={() => toggleTakeSolo(take.id)}
                    aria-pressed={isSoloed}
                    aria-label={isSoloed ? `Unsolo ${label}` : `Solo ${label}`}
                    title={
                      isSoloed
                        ? `Unsolo ${label}`
                        : `Solo ${label} among the takes. The other tracks are not affected, and the main take mute and solo above still come first.`
                    }
                  >
                    S
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={takeGains[take.id] ?? 1}
                    onChange={(e) => setTakeGain(take.id, Number(e.target.value))}
                    className="waveform__volume"
                    title={`${label} volume`}
                    aria-label={`${label} volume`}
                  />
                </div>
              </div>
              <div className="waveform__track-body">
                <div className="waveform__take-rail">
                  <div
                    ref={(el) => {
                      if (el) takeRails.current.set(take.id, el);
                      else takeRails.current.delete(take.id);
                    }}
                  />
                </div>
                <PunchOverlay />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default Waveform;
