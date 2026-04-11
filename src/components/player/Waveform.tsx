import { useEffect, useRef, useState } from "react";
import { usePlayerStore } from "../../stores/player";
import type { Song } from "../../lib/types";

interface WaveformProps {
  song: Song;
}

function Waveform({ song }: WaveformProps) {
  const vocalsRef = useRef<HTMLDivElement>(null);
  const instrumentalRef = useRef<HTMLDivElement>(null);
  const loadSong = usePlayerStore((s) => s.loadSong);
  const isLoading = useRef(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!vocalsRef.current || !instrumentalRef.current || isLoading.current)
      return;

    isLoading.current = true;
    setLoadError(null);
    loadSong(song, vocalsRef.current, instrumentalRef.current)
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[Waveform] loadSong failed:", msg);
        setLoadError(msg);
      })
      .finally(() => { isLoading.current = false; });

    // Allow the next effect run (React StrictMode or song change) to start fresh
    return () => { isLoading.current = false; };
  }, [song.id]);

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
    </div>
  );
}

export default Waveform;
