import type { PitchPoint, Song, Take } from "../lib/types";
import { TransportPublisher } from "./clock";
import { LivePublisher } from "./liveFeed";
import {
  EVT_COMMAND,
  EVT_DOCKED,
  EVT_HELLO,
  EVT_LIVE,
  EVT_SPECTRUM,
  EVT_STATE,
  isDetachablePanel,
  parseCommand,
  type DetachablePanel,
  type SharedState,
  type SpectrumMessage,
  type TakeSummary,
  type TransportSnapshot,
} from "./protocol";

export interface Store<T> {
  getState(): T;
  subscribe(listener: () => void): () => void;
}

export interface PlayerPort {
  song: Song | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  playbackRate: number;
  isRecording: boolean;
  isMonitoring: boolean;
  exerciseMode: boolean;
  punchIn: number | null;
  punchOut: number | null;
  punchLoop: boolean;
  selectedOutputDeviceId: string | null;
  activeTakeId: string | null;
  takes: Take[];
  seek(time: number): void;
  setPunchIn(time: number): void;
  setPunchOut(time: number): void;
  clearPunch(): void;
  setActiveTake(id: string): void;
  deleteTake(id: string): Promise<void>;
  renameTake(id: string, name: string): Promise<void>;
}

export interface AnalysisPort {
  livePitch: PitchPoint[];
  liveCents: number | null;
}

export interface MainBridgeDeps {
  player: Store<PlayerPort>;
  analysis: Store<AnalysisPort>;
  emit: (event: string, payload: unknown) => void | Promise<void>;
  listen: (event: string, cb: (payload: unknown) => void) => Promise<() => void>;
  now: () => number;
  /** The part of the spectrum comparison that needs the engine or the microphone. */
  spectrum?: { read(): SpectrumMessage | null; reset?(): void };
}

/** One tick serves both the transport heartbeat and the live-trace batching. */
const TICK_MS = 33;

function summarise(takes: Take[]): TakeSummary[] {
  return takes.map((t) => ({
    id: t.id,
    songId: t.songId,
    recordedAt: t.recordedAt,
    filepath: t.filepath,
    name: t.name,
    startPosition: t.startPosition,
  }));
}

function pickShared(p: PlayerPort, takes: TakeSummary[]): SharedState {
  return {
    song: p.song,
    duration: p.duration,
    isRecording: p.isRecording,
    isMonitoring: p.isMonitoring,
    exerciseMode: p.exerciseMode,
    punchIn: p.punchIn,
    punchOut: p.punchOut,
    punchLoop: p.punchLoop,
    selectedOutputDeviceId: p.selectedOutputDeviceId,
    activeTake: p.takes.find((t) => t.id === p.activeTakeId) ?? null,
    takes,
  };
}

function sameShared(a: SharedState, b: SharedState): boolean {
  return (Object.keys(a) as (keyof SharedState)[]).every((k) => a[k] === b[k]);
}

/**
 * Runs in the main window, which stays the only owner of audio, recording and
 * the song state. Detached windows are views of it: this publishes what they
 * need and carries out the few commands they may send back. While no window is
 * detached it subscribes to nothing and runs no timer.
 */
export async function startMainBridge(deps: MainBridgeDeps): Promise<{ dispose(): void }> {
  const { player, analysis, now } = deps;
  const panels = new Set<DetachablePanel>();
  const transportPublisher = new TransportPublisher();
  const livePublisher = new LivePublisher();

  let lastTakes: Take[] | null = null;
  let lastSummaries: TakeSummary[] = [];
  let lastTransport: TransportSnapshot | null = null;
  let lastShared: SharedState | null = null;
  let liveDirty = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const send = (event: string, payload: unknown) => {
    Promise.resolve(deps.emit(event, payload)).catch((e: unknown) =>
      console.warn(`[detached] could not send ${event}:`, e),
    );
  };

  const publishState = () => {
    if (panels.size === 0) return;
    const p = player.getState();
    const transport = transportPublisher.next(
      { time: p.currentTime, playing: p.isPlaying, rate: p.playbackRate },
      now(),
    );
    // Rebuilt only when the list itself changes, so a time tick compares equal.
    if (p.takes !== lastTakes) {
      lastTakes = p.takes;
      lastSummaries = summarise(p.takes);
    }
    const shared = pickShared(p, lastSummaries);
    const sharedChanged = !lastShared || !sameShared(lastShared, shared);
    if (!transport && !sharedChanged) return;
    if (transport) lastTransport = transport;
    lastShared = shared;
    if (lastTransport) send(EVT_STATE, { transport: lastTransport, shared });
  };

  const flushLive = () => {
    if (panels.size === 0 || !liveDirty) return;
    liveDirty = false;
    const a = analysis.getState();
    const message = livePublisher.push(a.livePitch, a.liveCents);
    if (message) send(EVT_LIVE, message);
  };

  const publishSpectrum = () => {
    if (!deps.spectrum || !panels.has("spectrum")) return;
    const message = deps.spectrum.read();
    if (message) send(EVT_SPECTRUM, message);
  };

  const startTimer = () => {
    if (timer === null) {
      timer = setInterval(() => {
        publishState();
        flushLive();
        publishSpectrum();
      }, TICK_MS);
    }
  };

  const stopTimer = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  const unsubscribePlayer = player.subscribe(publishState);
  const unsubscribeAnalysis = analysis.subscribe(() => {
    liveDirty = true;
  });

  const unlistenHello = await deps.listen(EVT_HELLO, (payload) => {
    const id = (payload as { panelId?: unknown } | null)?.panelId;
    if (!isDetachablePanel(id)) {
      console.warn("[detached] ignoring hello from an unknown panel:", payload);
      return;
    }
    panels.add(id);
    startTimer();
    transportPublisher.reset();
    livePublisher.forget();
    deps.spectrum?.reset?.();
    lastShared = null;
    liveDirty = true;
    publishState();
    flushLive();
  });

  const unlistenCommand = await deps.listen(EVT_COMMAND, (payload) => {
    const command = parseCommand(payload);
    if (!command) {
      console.warn("[detached] ignoring an unrecognised command:", payload);
      return;
    }
    const p = player.getState();
    switch (command.type) {
      case "seek":
        p.seek(command.time);
        break;
      case "setPunchIn":
        p.setPunchIn(command.time);
        break;
      case "setPunchOut":
        p.setPunchOut(command.time);
        break;
      case "clearPunch":
        p.clearPunch();
        break;
      case "setActiveTake":
      case "deleteTake":
      case "renameTake": {
        if (!p.takes.some((t) => t.id === command.id)) {
          console.warn(`[detached] ${command.type} names a take that does not exist:`, command.id);
          break;
        }
        if (command.type === "setActiveTake") p.setActiveTake(command.id);
        else if (command.type === "deleteTake") {
          p.deleteTake(command.id).catch((e: unknown) => console.error("[detached] could not delete the take:", e));
        } else {
          p.renameTake(command.id, command.name).catch((e: unknown) =>
            console.error("[detached] could not rename the take:", e),
          );
        }
        break;
      }
    }
  });

  const unlistenDocked = await deps.listen(EVT_DOCKED, (payload) => {
    if (isDetachablePanel(payload)) panels.delete(payload);
    if (panels.size === 0) {
      stopTimer();
      lastShared = null;
      lastTransport = null;
    }
  });

  return {
    dispose() {
      stopTimer();
      unsubscribePlayer();
      unsubscribeAnalysis();
      unlistenHello();
      unlistenCommand();
      unlistenDocked();
    },
  };
}
