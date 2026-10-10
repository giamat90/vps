# Detachable panels (spike)

Any panel of the practice room can be dragged out into a window of its own, for a second monitor: Takes, Lyrics, Piano roll (with its keyboard and tuner gauge), Spectrum comparison, Dynamics, Vibrato, Timing and Coach. On branch `spike/detachable-panels`, not released. See "Not done" for what is missing.

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
| `mps:spectrum` | main → detached (spectrum window only) | the live dB spectrum, one byte per bin, and the song / take / live formants | ≤ 30 Hz while listening; otherwise only when the formants move |
| `mps:command` | detached → main | `seek`, `setPunchIn`, `setPunchOut`, `clearPunch`, `setActiveTake`, `deleteTake`, `renameTake` | on user action |
| `mps:docked` | Rust → main | panel id, when its window is destroyed | once |

Time is **not** sent 30 times a second. The transport snapshot carries `{ time, playing, rate, sentAt }` and the detached window extrapolates (`RemoteClock`); the main window only resends when the playhead leaves that prediction (a seek, a loop jump) or on the heartbeat. Both windows share the machine clock, so `sentAt` is directly comparable.

Analysis data is not streamed: the detached window loads the song analysis itself (`load_analysis`) and receives the active take object. Only what exists nowhere on disk is streamed: the live trace and, for the spectrum panel, what only the microphone and the decoded audio can give.

The list of takes is mirrored as slim summaries (id, name, date, file, start): a full `Take` carries pitch and spectrum arrays that can run to megabytes, and only the active one is sent whole.

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
| `src/audio/spectrumSource.ts` | `SpectrumSource`: what the spectrum panel needs from the engine and the microphone. Local (this window) and remote (the stream) implementations |
| `src/windows/spectrumRegistry.ts` | which source the panel reads: the local one, or the one a detached window installed |
| `src/windows/spectrumFeed.ts`, `spectrumCodec.ts` | main side: reads the local source for a detached spectrum window and says it only when it changed; one-byte-per-bin codec |
| `src/windows/panelsToClose.ts` | a detached panel hidden in the Panels menu has its window closed |
| `src/windows/dropGesture.ts` | `decideDrop`: released outside the window → detach at that screen position |
| `src/windows/useMainBridge.ts`, `DetachedHost.tsx` | the React ends of the two bridges; `main.tsx` picks `DetachedHost` from the window label |
| `src/components/panels/DetachHandle.tsx` | grip (drag out) and pop-out button in a panel corner |
| `src/audio/livePitchFeed.ts`, `components/analysis/LivePitchFeed.tsx` | the microphone → live pitch detector, extracted from `DualTuner` |
| `src/stores/detached.ts` | which panels are currently in their own window (never persisted) |
| `src-tauri/src/windows.rs` | `detach_panel`, `dock_panel`, `close_detached_panel`, `close_detached_windows`; the panel allowlist; remembered window geometry; closes detached windows with the main one |
| `src-tauri/capabilities/detached.json` | events and core only: no dialog or updater access |

## Things that were not obvious

- **`DualTuner` was the live-pitch detector**, and it lived inside `PianoKeyboard`. Hiding or detaching the keyboard would have stopped (or moved to a window without a microphone) the very thing that draws the live ribbon. It is now the headless `LivePitchFeed`, mounted by the practice room and Free Exercise; `DualTuner` only draws the gauge from `liveCents`.
- **A window knows its panel from its label** (`detached-pianoRoll`), not from a URL fragment, and Rust accepts only an allowlisted id, so nothing a caller sends ends up in a label or URL.
- **The spectrum comparison reads decoded audio and the microphone**, not just stores: formants of the song and the take come from `engine.getTrackSamples`, the live curve and the singer's formants from the mic analyser. Those can only be measured in the main window, so the panel was given a `SpectrumSource` seam and the main window streams the result (a one-byte-per-bin spectrum, a few numbers of formants), never the audio.
- **Cached formant estimates are keyed by playhead position**, so a different take at the same position would show the previous take's formants; the feed resets the source whenever the song's or the take's spectrum is replaced, as the docked panel always did.
- **Where a window goes:** a drag-drop position always wins; the pop-out button (no position) uses where the panel was last, but only if enough of that window is still on a connected monitor, otherwise the OS places it. Size is always remembered. Geometry is kept in `~/.vps/detached_windows.json`, written when a window closes, and a damaged file is ignored rather than stopping a panel from opening.
- **React mounts effects twice in development.** `installPlaybackTimeSource` returns an uninstaller that only clears the source if it is still current, otherwise the first bridge's late cleanup removes the second one's clock.
- **zustand renders its initial snapshot under `react-dom/server`**, so page tests seed state through storage and import the page fresh per render.

## Trying it by hand

1. `npm run tauri dev`, open a song, select a take. Turn on the panels you want in the Panels menu (spectrum, dynamics and timing start hidden).
2. Drag the ⋮⋮ grip in the corner of any panel out past the edge of the window (or press ⤢ to pop it out where it was last).
3. Play, seek on the main waveform, set a punch region, monitor or record: the detached window should follow.
4. Click or drag on the detached piano roll; click a lyric line: the main playhead should move.
5. Dock with the button in the detached window, or close it; close the main window and check nothing is left.
6. Move and resize a detached window, close it, pop it out again with ⤢: it should return to the same place and size.
7. Detach a panel, then untick it in the Panels menu: its window should close. The menu marks panels that are in their own window.
8. With Takes detached: click a take, rename it (✎ or double-click), delete one, download one. With Spectrum detached: monitor or record and watch the live curve and the formant markers.

## Not done

- Docking by dragging a detached window back over the main one (there is a Dock button, and closing the window docks it).
- Mixed-DPI multi-monitor placement is untested: a dropped window's position comes from the pointer's screen coordinates, a remembered one is stored in physical pixels.
- Several windows of the same panel (one window per panel id).
- macOS is untested.
- SPS: nothing; the protocol and the bridges are app-independent and would move into `mps-core`.
- The component and gesture wiring (pointer capture, window creation) has no automated test: the repository has no DOM environment. The logic around it (protocol, clock, drop decision, both bridges, the feed controller, the Rust planner) is covered.
