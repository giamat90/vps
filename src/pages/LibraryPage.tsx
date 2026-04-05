import { useEffect } from "react";
import DropZone from "../components/upload/DropZone";
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

      <DropZone />

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
            <button
              className="song-card__delete"
              onClick={(e) => {
                e.stopPropagation();
                deleteSong(song.id);
              }}
              title="Delete song"
            >
              &times;
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}

export default LibraryPage;
