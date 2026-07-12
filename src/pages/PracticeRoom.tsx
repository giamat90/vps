import { useEffect, useState } from "react";
import Waveform from "../components/player/Waveform";
import DownloadAllButton from "../components/player/DownloadAllButton";
import ExportMixButton from "../components/player/ExportMixButton";
import TransportControls from "../components/player/TransportControls";
import LoopButton from "../components/player/LoopButton";
import TempoControl from "../components/player/TempoControl";
import KeyTranspose from "../components/player/KeyTranspose";
import OutputSelector from "../components/player/OutputSelector";
import RecordButton from "../components/recording/RecordButton";
import MonitorButton from "../components/recording/MonitorButton";
import MicSelector from "../components/recording/MicSelector";
import TakeList from "../components/recording/TakeList";
import PianoRoll from "../components/analysis/PianoRoll";
import PianoKeyboard from "../components/analysis/PianoKeyboard";
import DynamicsCurve from "../components/analysis/DynamicsCurve";
import ShortTermSpectrumComparisonPanel from "../components/analysis/ShortTermSpectrumComparisonPanel";
import VibratoCard from "../components/analysis/VibratoCard";
import TimingChart from "../components/analysis/TimingChart";
import CoachPanel from "../components/coaching/CoachPanel";
import { useLibraryStore } from "../stores/library";
import { usePlayerStore } from "../stores/player";
import { useAnalysisStore } from "../stores/analysis";

interface PracticeRoomProps {
  songId: string;
  onBack: () => void;
}

function PracticeRoom({ songId, onBack }: PracticeRoomProps) {
  const songs = useLibraryStore((s) => s.songs);
  const cleanup = usePlayerStore((s) => s.cleanup);
  const takes = usePlayerStore((s) => s.takes);
  const activeTakeId = usePlayerStore((s) => s.activeTakeId);
  const isRecording = usePlayerStore((s) => s.isRecording);
  const isMonitoring = usePlayerStore((s) => s.isMonitoring);
  const song = songs.find((s) => s.id === songId);
  const renameSong = useLibraryStore((s) => s.renameSong);

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState("");

  const startEditingTitle = () => {
    setTitleValue(song?.title ?? "");
    setIsEditingTitle(true);
  };

  const commitTitle = () => {
    setIsEditingTitle(false);
    const trimmed = titleValue.trim();
    if (song && trimmed && trimmed !== song.title) renameSong(song.id, trimmed);
  };

  const loadSongAnalysis = useAnalysisStore((s) => s.loadSongAnalysis);
  const loadTakeAnalysis = useAnalysisStore((s) => s.loadTakeAnalysis);
  const clearAnalysis = useAnalysisStore((s) => s.clear);
  const isAnalysisLoaded = useAnalysisStore((s) => s.isLoaded);

  const [showAnalysis, setShowAnalysis] = useState(false);

  // Load song analysis on mount
  useEffect(() => {
    loadSongAnalysis(songId);
    return () => {
      cleanup();
      clearAnalysis();
    };
  }, [songId]);

  // Load take analysis when active take changes
  useEffect(() => {
    if (!activeTakeId) return;
    const take = takes.find((t) => t.id === activeTakeId);
    if (take) {
      loadTakeAnalysis(take);
      setShowAnalysis(true);
    }
  }, [activeTakeId, takes]);

  if (!song) {
    return (
      <div className="practice-room">
        <button className="practice-room__back" onClick={onBack}>
          &larr; Back to Library
        </button>
        <p>Song not found.</p>
      </div>
    );
  }

  return (
    <div className="practice-room">
      <header className="practice-room__header">
        <button className="practice-room__back" onClick={onBack}>
          &larr; Back
        </button>
        <div className="practice-room__song-info">
          {isEditingTitle ? (
            <input
              className="practice-room__title-input"
              value={titleValue}
              autoFocus
              onChange={(e) => setTitleValue(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitTitle();
                else if (e.key === "Escape") setIsEditingTitle(false);
              }}
            />
          ) : (
            <h1
              className="practice-room__title"
              onDoubleClick={startEditingTitle}
              title="Double-click to rename"
            >
              {song.title}
              <button
                className="practice-room__rename"
                onClick={startEditingTitle}
                title="Rename song"
              >
                &#9998;
              </button>
            </h1>
          )}
          <div className="practice-room__meta">
            {song.detectedBpm && (
              <span>{Math.round(song.detectedBpm)} BPM</span>
            )}
            {song.detectedKey && <span>{song.detectedKey}</span>}
          </div>
        </div>
        <DownloadAllButton song={song} />
        <ExportMixButton />
      </header>

      <div className="practice-room__topbar">
        <TransportControls />
        <LoopButton />
        <TempoControl detectedBpm={song.detectedBpm} />
        <div className="practice-room__topbar-devices">
          <div className="practice-room__io-group">
            <MicSelector />
            <OutputSelector />
          </div>
          <KeyTranspose />
          <MonitorButton />
          <RecordButton />
        </div>
      </div>

      <div className="practice-room__body">
        <div className="practice-room__main">
          <div className="practice-room__waveforms">
            <Waveform song={song} />
          </div>

          {isAnalysisLoaded && (
            <div className="practice-room__analysis">
              <div className="practice-room__analysis-tabs">
                <button
                  className={`analysis-tab ${showAnalysis ? "analysis-tab--active" : ""}`}
                  onClick={() => setShowAnalysis((v) => !v)}
                >
                  Analysis {activeTakeId ? "" : "(select take)"}
                </button>
              </div>
              {(showAnalysis || isRecording || isMonitoring) && (
                <div className="practice-room__analysis-body">
                  <PianoKeyboard />
                  <PianoRoll />
                  <ShortTermSpectrumComparisonPanel />
                  <DynamicsCurve />
                </div>
              )}
            </div>
          )}
        </div>

        <aside className="practice-room__sidebar">
          <div className="practice-room__takes-wrap">
            <TakeList />
          </div>
          <div className="practice-room__sidebar-bottom">
            <VibratoCard />
            <TimingChart />
            <CoachPanel />
          </div>
        </aside>
      </div>
    </div>
  );
}

export default PracticeRoom;
