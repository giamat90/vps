import { useEffect, useState, type ReactNode } from "react";
import Waveform from "../components/player/Waveform";
import DownloadAllButton from "../components/player/DownloadAllButton";
import ExportMixButton from "../components/player/ExportMixButton";
import TransportControls from "../components/player/TransportControls";
import LoopButton from "../components/player/LoopButton";
import LoopsMenu from "../components/player/LoopsMenu";
import { installPlayerShortcuts } from "../lib/shortcuts";
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
import LyricsPanel from "../components/lyrics/LyricsPanel";
import LivePitchFeed from "../components/analysis/LivePitchFeed";
import DetachHandle from "../components/panels/DetachHandle";
import PanelMenu from "../components/panels/PanelMenu";
import SortablePanels from "../components/panels/SortablePanels";
import { useLibraryStore } from "../stores/library";
import { usePlayerStore } from "../stores/player";
import { useAnalysisStore } from "../stores/analysis";
import { useDetachedStore } from "../stores/detached";
import { availablePracticePanels, usePracticePanels, type PracticePanelId } from "../stores/panels";
import { hiddenTrackTags, useWaveformPanels, waveformMenuItems } from "../stores/waveforms";
import type { DetachablePanel } from "../windows/protocol";
import { useMainBridge } from "../windows/useMainBridge";

/** A panel with the corner handle that moves it into a window of its own. */
function Detachable({ panel, children }: { panel: DetachablePanel; children: ReactNode }) {
  return (
    <div className="detachable">
      <DetachHandle panel={panel} />
      {children}
    </div>
  );
}

/** What each optional panel shows. */
function PanelView({ id, songId }: { id: PracticePanelId; songId: string }) {
  switch (id) {
    case "lyrics":
      return <LyricsPanel songId={songId} />;
    case "takes":
      return <TakeList />;
    case "pianoRoll":
      return (
        <>
          <PianoKeyboard />
          <PianoRoll />
        </>
      );
    case "spectrum":
      return <ShortTermSpectrumComparisonPanel />;
    case "dynamics":
      return <DynamicsCurve />;
    case "vibrato":
      return <VibratoCard />;
    case "timing":
      return <TimingChart />;
    case "coach":
      return <CoachPanel />;
  }
}

const NEEDS_ANALYSIS: readonly PracticePanelId[] = ["pianoRoll", "spectrum", "dynamics"];

const slotClass = (id: PracticePanelId) => (id === "takes" ? "practice-room__takes" : undefined);

interface PracticeRoomProps {
  songId: string;
  onBack: () => void;
}

function PracticeRoom({ songId, onBack }: PracticeRoomProps) {
  const songs = useLibraryStore((s) => s.songs);
  const cleanup = usePlayerStore((s) => s.cleanup);
  const takes = usePlayerStore((s) => s.takes);
  const activeTakeId = usePlayerStore((s) => s.activeTakeId);
  const mutedTracks = usePlayerStore((s) => s.mutedTracks);
  const soloedTrack = usePlayerStore((s) => s.soloedTrack);
  const song = songs.find((s) => s.id === songId);
  const isInstrument = song?.kind === "instrument";
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
  const clearTakeAnalysis = useAnalysisStore((s) => s.clearTakeAnalysis);
  const clearAnalysis = useAnalysisStore((s) => s.clear);
  const isAnalysisLoaded = useAnalysisStore((s) => s.isLoaded);

  const visible = usePracticePanels((s) => s.visible);
  const order = usePracticePanels((s) => s.order);
  const waveformVisible = useWaveformPanels((s) => s.visible);
  const detached = useDetachedStore((s) => s.detached);

  useMainBridge();

  // On screen in this window: wanted, and not living in a window of its own.
  const docked = (id: DetachablePanel) => visible[id] && !detached[id];

  // The waveform area is collapsed, not removed: it owns what the audio engine draws into.
  const waveformsShown = waveformVisible.waveforms;

  // The page draws what is wanted, here, and possible, in the user's order.
  const onScreen = order.filter(
    (id) =>
      docked(id) &&
      !(isInstrument && id === "lyrics") &&
      !(NEEDS_ANALYSIS.includes(id) && !isAnalysisLoaded),
  );

  useEffect(() => installPlayerShortcuts(() => usePlayerStore.getState()), []);

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
    if (!activeTakeId) {
      // e.g. the active take was just deleted — without this, the deleted
      // take's pitch/onsets/dynamics/vibrato stay in the analysis store and
      // PianoRoll keeps drawing its red ribbon indefinitely.
      clearTakeAnalysis();
      return;
    }
    const take = takes.find((t) => t.id === activeTakeId);
    if (take) loadTakeAnalysis(take);
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
      <LivePitchFeed />
      <header className="practice-room__header">
        <button className="practice-room__back" onClick={onBack} aria-label="Back to library">
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
                aria-label="Rename song"
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
        <PanelMenu
          store={usePracticePanels}
          panels={availablePracticePanels({ isInstrument })}
          fixed={{
            store: useWaveformPanels,
            items: waveformMenuItems({ isInstrument }),
            tags: hiddenTrackTags(waveformVisible, { muted: mutedTracks, soloed: soloedTrack }),
          }}
        />
        <DownloadAllButton song={song} />
        <ExportMixButton />
      </header>

      <div className="practice-room__topbar">
        <TransportControls />
        <LoopButton />
        <LoopsMenu />
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
          <div className={`practice-room__waveforms${waveformsShown ? "" : " practice-room__waveforms--collapsed"}`}>
            <Waveform song={song} />
          </div>

          <SortablePanels store={usePracticePanels} ids={onScreen} className={slotClass}>
            {(id) => (
              <Detachable panel={id}>
                <PanelView id={id} songId={songId} />
              </Detachable>
            )}
          </SortablePanels>
        </div>
      </div>
    </div>
  );
}

export default PracticeRoom;
