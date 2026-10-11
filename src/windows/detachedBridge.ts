import { createDetachedBridge } from "@giamat90/mps-core/windows";
import type { PitchPoint, Take } from "../lib/types";
import {
  EVT_LIVE,
  EVT_SPECTRUM,
  isLiveMessage,
  isSharedState,
  isSpectrumMessage,
  type Command,
  type DetachablePanel,
  type LiveMessage,
  type SharedState,
  type SpectrumMessage,
  type TakeSummary,
} from "./protocol";

interface MutableStore<T> {
  getState(): T;
  setState(partial: Partial<T>): void;
}

/** What a panel in the detached window reads from the player store. */
export interface DetachedPlayer {
  song: SharedState["song"];
  duration: number;
  currentTime: number;
  isPlaying: boolean;
  playbackRate: number;
  isRecording: boolean;
  isMonitoring: boolean;
  exerciseMode: boolean;
  punchIn: number | null;
  punchOut: number | null;
  punchLoop: boolean;
  selectedOutputDeviceId: string | null;
  activeTakeId: string | null;
  takes: TakeSummary[];
  seek: (time: number) => void;
  setPunchIn: (time: number) => void;
  setPunchOut: (time: number) => void;
  clearPunch: () => void;
  setActiveTake: (id: string) => void;
  deleteTake: (id: string) => Promise<void>;
  renameTake: (id: string, name: string) => Promise<void>;
}

export interface DetachedAnalysis {
  livePitch: PitchPoint[];
  liveCents: number | null;
}

export interface DetachedBridgeDeps {
  panelId: DetachablePanel;
  player: MutableStore<DetachedPlayer>;
  analysis: MutableStore<DetachedAnalysis>;
  emit: (event: string, payload: unknown) => void | Promise<void>;
  listen: (event: string, cb: (payload: unknown) => void) => Promise<() => void>;
  now: () => number;
  onSpectrum: (message: SpectrumMessage) => void;
  installTimeSource: (source: () => number) => () => void;
  loadSongAnalysis: (songId: string) => Promise<void>;
  loadTakeAnalysis: (take: Take) => void;
  clearTakeAnalysis: () => void;
}

/** A take is reloaded only when something that moves it on the timeline changed. */
const takeKey = (t: Take) => `${t.id}|${t.startPosition}|${t.audioOffset ?? 0}|${t.manualOffset ?? 0}`;

/**
 * Runs in a detached practice-room panel: mirrors the shared state into this
 * window's own stores, so the panels are the very same components as in the main
 * window, and replaces the actions that would touch the audio engine by
 * commands to the main window.
 */
export async function startDetachedBridge(deps: DetachedBridgeDeps): Promise<{ dispose(): void }> {
  const { player, analysis } = deps;
  let loadedSongId: string | null = null;
  let loadedTakeKey: string | null = null;

  const bridge = createDetachedBridge<DetachablePanel, SharedState, Command>({
    panelId: deps.panelId,
    isShared: isSharedState,
    emit: deps.emit,
    listen: deps.listen,
    now: deps.now,
    installTimeSource: deps.installTimeSource,
    writeTime: (time) => player.setState({ currentTime: time }),

    applyShared(shared, transport, currentTime) {
      player.setState({
        song: shared.song,
        duration: shared.duration,
        isRecording: shared.isRecording,
        isMonitoring: shared.isMonitoring,
        exerciseMode: shared.exerciseMode,
        punchIn: shared.punchIn,
        punchOut: shared.punchOut,
        punchLoop: shared.punchLoop,
        selectedOutputDeviceId: shared.selectedOutputDeviceId,
        activeTakeId: shared.activeTake?.id ?? null,
        takes: shared.takes,
        isPlaying: transport.playing,
        playbackRate: transport.rate,
        currentTime,
      });

      const songId = shared.song?.id ?? null;
      if (songId && songId !== loadedSongId) {
        loadedSongId = songId;
        deps.loadSongAnalysis(songId).catch((e: unknown) =>
          console.error("[detached] could not load the song analysis:", e),
        );
      }

      const key = shared.activeTake ? takeKey(shared.activeTake) : null;
      if (key !== loadedTakeKey) {
        loadedTakeKey = key;
        if (shared.activeTake) deps.loadTakeAnalysis(shared.activeTake);
        else deps.clearTakeAnalysis();
      }
    },

    listeners: {
      [EVT_LIVE]: (payload) => {
        if (!isLiveMessage(payload)) {
          console.warn("[detached] ignoring a malformed live message:", payload);
          return;
        }
        const message: LiveMessage = payload;
        const base = message.reset ? [] : analysis.getState().livePitch;
        analysis.setState({ livePitch: [...base, ...message.points], liveCents: message.cents });
      },
      [EVT_SPECTRUM]: (payload) => {
        if (!isSpectrumMessage(payload)) {
          console.warn("[detached] ignoring a malformed spectrum message:", payload);
          return;
        }
        deps.onSpectrum(payload);
      },
    },
  });

  player.setState({
    seek: (time) => {
      bridge.seekLocal(time);
      bridge.command({ type: "seek", time });
    },
    setPunchIn: (time) => bridge.command({ type: "setPunchIn", time }),
    setPunchOut: (time) => bridge.command({ type: "setPunchOut", time }),
    clearPunch: () => bridge.command({ type: "clearPunch" }),
    setActiveTake: (id) => {
      player.setState({ activeTakeId: id });
      bridge.command({ type: "setActiveTake", id });
    },
    deleteTake: async (id) => bridge.command({ type: "deleteTake", id }),
    renameTake: async (id, name) => bridge.command({ type: "renameTake", id, name }),
  });

  await bridge.start();
  return { dispose: bridge.dispose };
}
