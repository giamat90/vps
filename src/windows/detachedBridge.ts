import type { PitchPoint, Take } from "../lib/types";
import { RemoteClock } from "./clock";
import {
  EVT_COMMAND,
  EVT_HELLO,
  EVT_LIVE,
  EVT_STATE,
  isLiveMessage,
  isStateMessage,
  type Command,
  type DetachablePanel,
  type LiveMessage,
  type StateMessage,
  type TransportSnapshot,
} from "./protocol";

interface MutableStore<T> {
  getState(): T;
  setState(partial: Partial<T>): void;
}

/** What a panel in the detached window reads from the player store. */
export interface DetachedPlayer {
  song: StateMessage["shared"]["song"];
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
  seek: (time: number) => void;
  setPunchIn: (time: number) => void;
  setPunchOut: (time: number) => void;
  clearPunch: () => void;
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
  installTimeSource: (source: () => number) => () => void;
  loadSongAnalysis: (songId: string) => Promise<void>;
  loadTakeAnalysis: (take: Take) => void;
  clearTakeAnalysis: () => void;
}

const TICK_MS = 33;

/** A take is reloaded only when something that moves it on the timeline changed. */
const takeKey = (t: Take) => `${t.id}|${t.startPosition}|${t.audioOffset ?? 0}|${t.manualOffset ?? 0}`;

/**
 * Runs in a detached window. Everything the panels need is mirrored into this
 * window own stores, so the panels themselves are the very same components as
 * in the main window; only the actions that would touch the audio engine are
 * replaced by commands to the main window.
 */
export async function startDetachedBridge(deps: DetachedBridgeDeps): Promise<{ dispose(): void }> {
  const { player, analysis, now } = deps;
  const clock = new RemoteClock();
  let transport: TransportSnapshot | null = null;
  let loadedSongId: string | null = null;
  let loadedTakeKey: string | null = null;
  let lastWritten = Number.NaN;

  const send = (event: string, payload: unknown) => {
    Promise.resolve(deps.emit(event, payload)).catch((e: unknown) =>
      console.warn(`[detached] could not send ${event}:`, e),
    );
  };
  const command = (c: Command) => send(EVT_COMMAND, c);

  const writeTime = () => {
    const t = clock.now(now());
    if (t === lastWritten && !transport?.playing) return;
    lastWritten = t;
    player.setState({ currentTime: t });
  };

  const uninstallTimeSource = deps.installTimeSource(() => clock.now(now()));

  player.setState({
    seek: (time) => {
      if (transport) {
        transport = { ...transport, time, sentAt: now() };
        clock.apply(transport);
      }
      writeTime();
      player.setState({ currentTime: time });
      command({ type: "seek", time });
    },
    setPunchIn: (time) => command({ type: "setPunchIn", time }),
    setPunchOut: (time) => command({ type: "setPunchOut", time }),
    clearPunch: () => command({ type: "clearPunch" }),
  });

  const applyState = (message: StateMessage) => {
    const { shared } = message;
    transport = message.transport;
    clock.apply(transport);
    clock.setDuration(shared.duration);

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
      isPlaying: transport.playing,
      playbackRate: transport.rate,
      currentTime: clock.now(now()),
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
  };

  const applyLive = (message: LiveMessage) => {
    const base = message.reset ? [] : analysis.getState().livePitch;
    analysis.setState({ livePitch: [...base, ...message.points], liveCents: message.cents });
  };

  const unlistenState = await deps.listen(EVT_STATE, (payload) => {
    if (!isStateMessage(payload)) {
      console.warn("[detached] ignoring a malformed state message:", payload);
      return;
    }
    applyState(payload);
  });

  const unlistenLive = await deps.listen(EVT_LIVE, (payload) => {
    if (!isLiveMessage(payload)) {
      console.warn("[detached] ignoring a malformed live message:", payload);
      return;
    }
    applyLive(payload);
  });

  const timer = setInterval(writeTime, TICK_MS);

  send(EVT_HELLO, { panelId: deps.panelId });

  return {
    dispose() {
      clearInterval(timer);
      unlistenState();
      unlistenLive();
      uninstallTimeSource();
    },
  };
}
