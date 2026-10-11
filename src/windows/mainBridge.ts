import { startMainBridge as startCoreBridge, type BridgeStream } from "@giamat90/mps-core/windows";
import type { PitchPoint, Song, Take } from "../lib/types";
import { LivePublisher } from "./liveFeed";
import {
  EVT_LIVE,
  EVT_SPECTRUM,
  isDetachablePanel,
  parseCommand,
  type Command,
  type DetachablePanel,
  type SharedState,
  type SpectrumMessage,
  type TakeSummary,
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

function applyCommand(p: PlayerPort, command: Command): void {
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
}

/** The live pitch trace and the tuner reading, sent as appended points. */
function liveStream(analysis: Store<AnalysisPort>, send: (e: string, p: unknown) => void): BridgeStream<DetachablePanel> {
  const publisher = new LivePublisher();
  let dirty = false;
  const unsubscribe = analysis.subscribe(() => {
    dirty = true;
  });
  const flush = () => {
    if (!dirty) return;
    dirty = false;
    const a = analysis.getState();
    const message = publisher.push(a.livePitch, a.liveCents);
    if (message) send(EVT_LIVE, message);
  };
  return {
    tick: flush,
    hello() {
      publisher.forget();
      dirty = true;
      flush();
    },
    dispose: unsubscribe,
  };
}

function spectrumStream(
  spectrum: MainBridgeDeps["spectrum"],
  send: (e: string, p: unknown) => void,
): BridgeStream<DetachablePanel> {
  return {
    tick(attached) {
      if (!spectrum || !attached.has("spectrum")) return;
      const message = spectrum.read();
      if (message) send(EVT_SPECTRUM, message);
    },
    hello() {
      spectrum?.reset?.();
    },
  };
}

/**
 * The practice room's side of the window bridge: what its detached panels
 * receive and the few commands they may send back. The generic plumbing is
 * mps-core; this supplies the shared state and the app's commands.
 */
export function startMainBridge(deps: MainBridgeDeps): Promise<{ dispose(): void }> {
  const { player, analysis } = deps;
  // Rebuilt only when the list itself changes, so a time tick compares equal.
  let lastTakes: Take[] | null = null;
  let lastSummaries: TakeSummary[] = [];

  return startCoreBridge<DetachablePanel, SharedState, Command>({
    isPanel: isDetachablePanel,
    subscribe: (listener) => player.subscribe(listener),
    transport: () => {
      const p = player.getState();
      return { time: p.currentTime, playing: p.isPlaying, rate: p.playbackRate };
    },
    shared: () => {
      const p = player.getState();
      if (p.takes !== lastTakes) {
        lastTakes = p.takes;
        lastSummaries = summarise(p.takes);
      }
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
        takes: lastSummaries,
      };
    },
    parseCommand,
    apply: (command) => applyCommand(player.getState(), command),
    emit: deps.emit,
    listen: deps.listen,
    now: deps.now,
    streams: (send) => [liveStream(analysis, send), spectrumStream(deps.spectrum, send)],
  });
}
