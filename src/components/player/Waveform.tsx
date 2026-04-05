import { useEffect, useRef } from "react";
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

  useEffect(() => {
    if (!vocalsRef.current || !instrumentalRef.current || isLoading.current)
      return;

    isLoading.current = true;
    loadSong(song, vocalsRef.current, instrumentalRef.current).finally(() => {
      isLoading.current = false;
    });
  }, [song.id]);

  return (
    <div className="waveform">
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
