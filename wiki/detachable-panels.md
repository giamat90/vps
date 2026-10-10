# Detachable panels (spike)

A panel can be dragged out of the practice room into a window of its own, for a second monitor. **Spike status:** Piano roll (with its keyboard and tuner gauge) and Lyrics, on branch `spike/detachable-panels`, not released. See "Not done" for what is missing.

## The model

The main window stays the only owner of audio, the microphone, recording and the song state. A detached window is a **remote view**: it runs the same panel components, against its own stores, which are fed from the main window.

```
 main window                                   detached window (one per panel)
 ───────────                                   ─────────────────────────────
 AudioEngine, mic, recorder                    no engine, no mic
 usePlayerStore / useAnalysisStore  ──state──► mirrored into its own stores
 LivePitchFeed (mic → live trace)   ──live───► livePitch + liveCents
 mainBridge                         ◄─command─ seek / punch actions are replaced by commands
```

| Event | Direction | Content | Rate |
|---|---|---|---|
| `mps:hello` | detached → main | `{ panelId }` | once, after listening |
| `mps:state` | main → detached | transport snapshot + shared state (song, duration, punch, monitoring flags, active take) | on change, seek, or 1 s heartbeat while playing |
| `mps:live` | main → detached | live pitch points appended since the last message, plus the tuner reading | ≤ 30 Hz, only when something changed |
| `mps:command` | detached → main | `seek`, `setPunchIn`, `setPunchOut`, `clearPunch` | on user action |
| `mps:docked` | Rust → main | panel id, when its window is destroyed | once |

Time is **not** sent 30 times a second. The transport snapshot carries `{ time, playing, rate, sentAt }` and the detached window extrapolates (`RemoteClock`); the main window only resends when the playhead leaves that prediction (a seek, a loop jump) or on the heartbeat. Both windows share the machine clock, so `sentAt` is directly comparable.

Analysis data is not streamed: the detached window loads the song analysis itself (`load_analysis`) and receives the active take object. Only the live trace, which exists nowhere on disk, is streamed.

Until a window says hello the main window publishes nothing and runs no timer.

## Files

| File | Role |
|---|---|
| `src/windows/protocol.ts` | event names, message types, `parseCommand` and the guards (everything crossing windows is validated) |
| `src/windows/clock.ts` | `RemoteClock` (extrapolating playhead), `TransportPublisher` (when to resend) |
| `src/windows/liveFeed.ts` | `LivePublisher`: append-only trace → minimal messages |
| `src/windows/mainBridge.ts` | main side: publishes, applies commands, tracks which panels are detached |
| `src/windows/detachedBridge.ts` | detached side: mirrors state into the stores, replaces the engine-touching actions with commands |
| `src/windows/playbackClock.ts` | `getPlaybackTime()`: the audio engine in main, the remote clock in a detached window |
| `src/windows/dropGesture.ts` | `decideDrop`: released outside the window → detach at that screen position |
| `src/windows/useMainBridge.ts`, `DetachedHost.tsx` | the React ends of the two bridges; `main.tsx` picks `DetachedHost` from the window label |
| `src/components/panels/DetachHandle.tsx` | grip (drag out) and pop-out button in a panel corner |
| `src/audio/livePitchFeed.ts`, `components/analysis/LivePitchFeed.tsx` | the microphone → live pitch detector, extracted from `DualTuner` |
| `src/stores/detached.ts` | which panels are currently in their own window (never persisted) |
| `src-tauri/src/windows.rs` | `detach_panel`, `dock_panel`, `close_detached_windows`; the panel allowlist; closes detached windows with the main one |
| `src-tauri/capabilities/detached.json` | events and core only: no dialog or updater access |

## Things that were not obvious

- **`DualTuner` was the live-pitch detector**, and it lived inside `PianoKeyboard`. Hiding or detaching the keyboard would have stopped (or moved to a window without a microphone) the very thing that draws the live ribbon. It is now the headless `LivePitchFeed`, mounted by the practice room and Free Exercise; `DualTuner` only draws the gauge from `liveCents`.
- **A window knows its panel from its label** (`detached-pianoRoll`), not from a URL fragment, and Rust accepts only an allowlisted id, so nothing a caller sends ends up in a label or URL.
- **React mounts effects twice in development.** `installPlaybackTimeSource` returns an uninstaller that only clears the source if it is still current, otherwise the first bridge's late cleanup removes the second one's clock.
- **zustand renders its initial snapshot under `react-dom/server`**, so page tests seed state through storage and import the page fresh per render.

## Trying it by hand

1. `npm run tauri dev`, open a song, select a take.
2. Drag the ⋮⋮ grip in the corner of Piano roll or Lyrics out past the edge of the window (or press ⤢ to pop it out beside the window).
3. Play, seek on the main waveform, set a punch region, monitor or record: the detached window should follow.
4. Click or drag on the detached piano roll; click a lyric line: the main playhead should move.
5. Dock with the button in the detached window, or close it; close the main window and check nothing is left.

## Not done

- Spectrum comparison, dynamics, vibrato, timing, coach and takes cannot be detached yet. Takes is the one that needs more commands (select, rename, delete) and shared state.
- Docking by dragging a detached window back over the main one.
- Remembering a detached window's position, and hiding a detached panel from the Panels menu does not close its window.
- Mixed-DPI multi-monitor placement is untested: the new window position comes from the pointer's screen coordinates.
- macOS is untested.
- SPS: nothing; the protocol and the bridges are app-independent and would move into `mps-core`.
- The component and gesture wiring (pointer capture, window creation) has no automated test: the repository has no DOM environment. The logic around it (protocol, clock, drop decision, both bridges, the feed controller, the Rust planner) is covered.
