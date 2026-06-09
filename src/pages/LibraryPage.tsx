import { useEffect } from "react";
import DropZone from "../components/upload/DropZone";
import YouTubeImport from "../components/upload/YouTubeImport";
import { exportStem } from "../lib/tauri";
import { useLibraryStore } from "../stores/library";

interface LibraryPageProps {
  onSelectSong: (songId: string) => void;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function LibraryPage({ onSelectSong }: LibraryPageProps) {
  const songs = useLibraryStore((s) => s.songs);
  const isLoading = useLibraryStore((s) => s.isLoading);
  const fetchSongs = useLibraryStore((s) => s.fetchSongs);
  const deleteSong = useLibraryStore((s) => s.deleteSong);
  const initProgressListener = useLibraryStore((s) => s.initProgressListener);

  useEffect(() => {
    fetchSongs();
    const cleanupPromise = initProgressListener();
    return () => {
      cleanupPromise.then((unlisten) => unlisten());
    };
  }, []);

  return (
    <div className="library-page">
      <header className="library-page__header">
        <h1>Vocal Practice Studio</h1>
      </header>

      <div className="library-page__import">
        <DropZone />
        <YouTubeImport />
      </div>

      <section className="library-page__list">
        {isLoading && <p className="library-page__loading">Loading...</p>}

        {!isLoading && songs.length === 0 && (
          <p className="library-page__empty">
            No songs yet. Upload one to get started.
          </p>
        )}

        {songs.map((song) => (
          <div
            key={song.id}
            className="song-card"
            onClick={() => onSelectSong(song.id)}
          >
            <div className="song-card__info">
              <div className="song-card__title">{song.title}</div>
              <div className="song-card__meta">
                {song.detectedBpm && (
                  <span>{Math.round(song.detectedBpm)} BPM</span>
                )}
                {song.detectedKey && <span>{song.detectedKey}</span>}
                <span>{formatDuration(song.duration)}</span>
              </div>
            </div>
            <div className="song-card__actions" onClick={(e) => e.stopPropagation()}>
              <button
                className="song-card__export-btn"
                title="Download vocals stem"
                onClick={() =>
                  exportStem(
                    `${song.directory}/vocals.wav`,
                    `${song.title} - Vocals.wav`,
                  )
                }
              >
                ↓ Vocals
              </button>
              <button
                className="song-card__export-btn"
                title="Download instrumental stem"
                onClick={() =>
                  exportStem(
                    `${song.directory}/instrumental.wav`,
                    `${song.title} - Instrumental.wav`,
                  )
                }
              >
                ↓ Instr.
              </button>
              <button
                className="song-card__delete"
                onClick={() => deleteSong(song.id)}
                title="Delete song"
              >
                &times;
              </button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

export default LibraryPage;
