import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import DropZone from "../components/upload/DropZone";
import YouTubeImport from "../components/upload/YouTubeImport";
import { exportStem, pitchShiftSong } from "../lib/tauri";
import type { Song } from "../lib/types";
import { useLibraryStore } from "../stores/library";

interface LibraryPageProps {
  onSelectSong: (songId: string) => void;
  onGoToExercise: () => void;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface SongCardProps {
  song: Song;
  onSelect: () => void;
  onDelete: () => void;
}

function SongCard({ song, onSelect, onDelete }: SongCardProps) {
  const [pitch, setPitch] = useState(0);
  const [isShifting, setIsShifting] = useState(false);

  const handleExport = async (stem: "vocals" | "instrumental") => {
    const baseName = stem === "vocals" ? "Vocals" : "Instrumental";
    if (pitch === 0) {
      await exportStem(
        `${song.directory}/${stem}.wav`,
        `${song.title} - ${baseName}.wav`,
      );
      return;
    }
    setIsShifting(true);
    try {
      const paths = await pitchShiftSong(song.directory, pitch);
      const path = stem === "vocals" ? paths.vocalsPath : paths.instrumentalPath;
      const suffix = pitch > 0 ? `+${pitch}st` : `${pitch}st`;
      await exportStem(path, `${song.title} - ${baseName} (${suffix}).wav`);
    } finally {
      setIsShifting(false);
    }
  };

  return (
    <div className="song-card" onClick={onSelect}>
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
      <div
        className="song-card__actions"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="song-card__pitch">
          <button
            className="song-card__pitch-btn"
            onClick={() => setPitch((p) => Math.max(-6, p - 1))}
            disabled={isShifting || pitch <= -6}
            title="Shift down one semitone"
          >
            −
          </button>
          <span className="song-card__pitch-val">
            {pitch === 0 ? "0" : pitch > 0 ? `+${pitch}` : pitch} st
          </span>
          <button
            className="song-card__pitch-btn"
            onClick={() => setPitch((p) => Math.min(6, p + 1))}
            disabled={isShifting || pitch >= 6}
            title="Shift up one semitone"
          >
            +
          </button>
          {pitch !== 0 && (
            <button
              className="song-card__pitch-reset"
              onClick={() => setPitch(0)}
              disabled={isShifting}
              title="Reset pitch"
            >
              ×
            </button>
          )}
        </div>
        <button
          className="song-card__export-btn"
          title="Download vocals stem"
          disabled={isShifting}
          onClick={() => handleExport("vocals")}
        >
          {isShifting ? "…" : "↓ Vocals"}
        </button>
        <button
          className="song-card__export-btn"
          title="Download instrumental stem"
          disabled={isShifting}
          onClick={() => handleExport("instrumental")}
        >
          {isShifting ? "…" : "↓ Instr."}
        </button>
        <button
          className="song-card__delete"
          onClick={onDelete}
          title="Delete song"
        >
          &times;
        </button>
      </div>
    </div>
  );
}

function LibraryPage({ onSelectSong, onGoToExercise }: LibraryPageProps) {
  const songs = useLibraryStore((s) => s.songs);
  const isLoading = useLibraryStore((s) => s.isLoading);
  const error = useLibraryStore((s) => s.error);
  const fetchSongs = useLibraryStore((s) => s.fetchSongs);
  const deleteSong = useLibraryStore((s) => s.deleteSong);
  const clearError = useLibraryStore((s) => s.clearError);
  const initProgressListener = useLibraryStore((s) => s.initProgressListener);

  const [showAbout, setShowAbout] = useState(false);
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    fetchSongs();
    const cleanupPromise = initProgressListener();
    getVersion()
      .then(setAppVersion)
      .catch((e: unknown) => console.warn("[About] getVersion failed:", e));
    return () => {
      cleanupPromise.then((unlisten) => unlisten());
    };
  }, []);

  return (
    <div className="library-page">
      <header className="library-page__header">
        <h1>Vocal Practice Studio</h1>
        <div className="library-page__header-actions">
          <button className="library-page__exercise-btn" onClick={onGoToExercise}>
            Free Exercise
          </button>
          <button
            className="library-page__about-btn"
            onClick={() => setShowAbout(true)}
            title="About"
          >
            ⓘ
          </button>
        </div>
      </header>

      {showAbout && (
        <div className="about-overlay" onClick={() => setShowAbout(false)}>
          <div className="about-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="about-modal__title">Vocal Practice Studio</h2>
            {appVersion && <p className="about-modal__version">v{appVersion}</p>}
            <p className="about-modal__desc">
              Desktop app for singers to practice against separated tracks,
              record takes, and analyze pitch, timing, vibrato, and dynamics.
            </p>
            <button className="about-modal__close" onClick={() => setShowAbout(false)}>
              Close
            </button>
          </div>
        </div>
      )}


      <div className="library-page__import">
        <DropZone />
        <YouTubeImport />
      </div>

      {error && (
        <div className="library-page__error" role="alert">
          <span className="library-page__error-msg">{error}</span>
          <button
            className="library-page__error-close"
            onClick={clearError}
            aria-label="Dismiss"
          >
            &times;
          </button>
        </div>
      )}

      <section className="library-page__list">
        {isLoading && <p className="library-page__loading">Loading...</p>}

        {!isLoading && songs.length === 0 && (
          <p className="library-page__empty">
            No songs yet. Upload one to get started.
          </p>
        )}

        {songs.map((song) => (
          <SongCard
            key={song.id}
            song={song}
            onSelect={() => onSelectSong(song.id)}
            onDelete={() => deleteSong(song.id)}
          />
        ))}
      </section>
    </div>
  );
}

export default LibraryPage;
