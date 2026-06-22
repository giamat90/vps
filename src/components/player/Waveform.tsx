import { useEffect, useRef, useState } from "react";
import { usePlayerStore, getEngine } from "../../stores/player";
import type { Song } from "../../lib/types";

interface WaveformProps {
  song: Song;
}

function Waveform({ song }: WaveformProps) {
  const vocalsRef        = useRef<HTMLDivElement>(null);
  const instrumentalRef  = useRef<HTMLDivElement>(null);
  const takeRef          = useRef<HTMLDivElement>(null);
  const loadSong         = usePlayerStore((s) => s.loadSong);
  const activeTakeId     = usePlayerStore((s) => s.activeTakeId);
  const takes            = usePlayerStore((s) => s.takes);
  const isLoading        = useRef(false);
  const loadedTakeId     = useRef<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

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
    eng.loadTakeTrack(take.filepath, takeRef.current, take.startPosition)
      .catch((e: unknown) => console.error("[Waveform] loadTakeTrack failed:", e));
  }, [activeTakeId, takes]);

  return (
    <div className="waveform">
      {loadError && <div className="waveform__error">{loadError}</div>}
      <div className="waveform__track">
        <span className="waveform__label">Vocals</span>
        <div className="waveform__container" ref={vocalsRef} />
      </div>
      <div className="waveform__track">
        <span className="waveform__label">Instrumental</span>
        <div className="waveform__container" ref={instrumentalRef} />
      </div>
      {activeTakeId && (
        <div className="waveform__track">
          <span className="waveform__label waveform__label--take">Take</span>
          <div className="waveform__container" ref={takeRef} />
        </div>
      )}
    </div>
  );
}

export default Waveform;
