# Frontend Components

**Directory:** `src/components/`

> **Logic in mps-core hooks.** `MicSelector`, `OutputSelector`, `KeyTranspose`, `TempoControl`, `LoopButton`, `RecordButton`, `CountInButton`, `TransportControls`, `ExportMixButton` and `DownloadAllButton` hold markup and CSS classes only; their state, effects and handlers are `@giamat90/mps-core/hooks` (`useMicSelect`, `useOutputSelect`, `useKeyTranspose`, `useTempoControl`, `useLoopToggle`, `useCountInButton`, `useRecordButton`, `useTransportControls`, `useExportMix`, `useDownloadAll`), which take the player store and the IPC functions as arguments. What differs between VPS and SPS is an option (`stopEndsRecording`, the `watch` selectors of the mix export, `trackEntries`) or stays in the markup (aria-labels, wording).

## Component Tree

```
App
├── pages/
│   ├── LibraryPage        — song list, import, "Free Exercise" button
│   ├── PracticeRoom       — song practice (waveforms + analysis + recording)
│   └── ExercisePage       — free exercise (no song; piano roll + record)
├── upload/
│   ├── DropZone           — drag-and-drop audio file import
│   ├── YouTubeImport      — paste-and-import YouTube URL
│   └── ImportQueue        — the running import's progress and the numbered list of waiting ones
├── player/
│   ├── Waveform           — 3-track waveform display (vocals + instrumental + take), each row with mute/solo/volume controls
│   ├── TimeRuler          — canvas time ruler with drag-to-select punch region
│   ├── TransportControls  — skip, Stop, Play, Record, skip, ⏱ count-in, elapsed/total time (no volume controls — those live per-track in Waveform)
│   ├── TempoControl       — BPM-first speed control (editable BPM value + editable x-rate)
│   ├── KeyTranspose       — semitone transpose UI
│   └── OutputSelector     — audio output device picker
├── recording/
│   ├── CountInButton      — ⏱ count-in bars for Play, Record and Monitor (in the transport row)
│   ├── RecordButton       — start/stop recording (song practice); rendered by TransportControls
│   ├── MonitorButton      — labelled 🎧 toggle for live mic monitoring (no save); sits between Input and Output
│   ├── MicSelector        — input device picker (labelled "Input")
│   ├── TakeList           — list of song takes with delete
│   └── ExerciseTakeList   — list of exercise takes; click to expand audio player
├── analysis/
│   ├── DualTuner          — real-time pitch tuner (reference vs. singer)
│   ├── PianoKeyboard      — horizontal piano key strip with live/song/take highlight
│   ├── PianoRoll          — scrolling pitch ribbon display (song + take + live; optional second-voice ribbon)
│   ├── PitchMonitorPanel  — the practice room's `pianoRoll` panel: PianoKeyboard with PianoRoll under it, one title button
│   ├── SpectrogramPanel   — scrolling live mic spectrogram (Free Exercise only)
│   ├── ShortTermSpectrumPanel — real-time spectral snapshot of the live mic (Free Exercise)
│   ├── ShortTermSpectrumComparisonPanel — song vs. take vs. live spectral envelope overlay (PracticeRoom)
│   ├── VibratoCard        — vibrato rate / depth / regularity summary
│   ├── TimingChart        — timing deviation chart (user vs. reference onsets)
│   └── DynamicsCurve      — RMS dynamics over time
├── coaching/
│   └── CoachPanel         — AI coaching tips panel
├── lyrics/
│   └── LyricsPanel        — synced lyrics: paste / find online / sync, karaoke view, click a line to seek (PracticeRoom, non-instrument songs)
└── updater/
    └── UpdateDialog       — auto-update modal (release notes, install/restart, progress)
```

## State Management

### Library Store (`src/stores/library.ts`)
**Shared with the sibling app (mps-core `hooks`, group library-page-stores).** The store's actions come from `libraryStateCreator` (the IPC functions, the sign-in and the cookies setter are passed in; the app adds its own `importYoutube(...)` that builds the request its backend takes), the error text from `createFriendlyError` (this app passes two rules of its own, the `VPS_PITCH_ALGORITHM` message shown as written and the ffmpeg-not-found text), and `filterSongs` from `createSongFilter` (plus the artist and "instrument" as extra terms). `LibraryPage.tsx` keeps markup and CSS classes only: loading, search, the New Folder field, the About/Settings toggles and the drop decision are `useLibraryPage` + `resolveLibraryDrop`, title/folder renaming is `useEditableText`, and the dnd-kit rows are `useSortableSongRow`, `useSortableFolder` and `useRootDropZone`. What stays here: the pitch-shift/export controls of `SongCard`, the Free Exercise button and the track-kind toggle.

Manages the song list, import/upload flow, and error state.

| Field | Type | Description |
|-------|------|-------------|
| `songs` | `Song[]` | All songs in the library |
| `folders` | `Folder[]` | All folders in the library |
| `processing` | `ProcessingStatus \| null` | The import running now (null when idle) |
| `processingLabel` | `string \| null` | What `processing` is about: the file name or the link |
| `queue` | `QueuedImport[]` | Imports waiting their turn, oldest first (`id`, `label`, `source`); the running one is not in it |
| `isLoading` | `boolean` | Initial fetch in progress |
| `error` | `string \| null` | Last friendly error message (cleared when an import starts on an idle queue; kept, with the new one appended, while others wait) |

`uploadSong(filePath, highQuality?)` and `importYoutube(url, highQuality?)` both accept an optional `highQuality` flag (default `false`), threaded straight through to the Rust commands → sidecar → `processor.process()`'s Demucs model choice (`htdemucs_ft` vs `htdemucs`). `LibraryPage` owns the toggle's state and passes it down to both `DropZone` and `YouTubeImport`.

**Import queue.** The backend separates one song at a time, so `uploadSong` and `importYoutube` line up behind a running import instead of being refused: each returns a promise that settles when *that* import ends, and the store runs them in the order given. The options (`highQuality`, `trackKind`, the cookies path) are taken when the import is queued, so the import options can be changed for the next song while one is running. A failed import does not stop the line; when others are waiting (or it waited itself) its message starts with its file name or link. `removeFromQueue(id)` drops a waiting import; the running one cannot be stopped (no cancel in `process_song` yet). The queue lives in memory only: closing the app drops the waiting imports. `retryableYoutubeImport` is a single slot, so after several expired-session links only the last is offered for "Sign in again and retry". Design and limits: [mps-core architecture](../../core/wiki/architecture.md).

Actions: `fetchSongs`, `uploadSong`, `importYoutube`, `removeFromQueue`, `deleteSong`, `renameSong`, `fetchFolders`, `createFolder`, `renameFolder`, `deleteFolder`, `reorderFolders`, `moveSongs`, `clearError`, `initProgressListener`. See [Library Folders](#library-folders-drag-and-drop) below for the folder-related actions.

Both `uploadSong` and `importYoutube` set an initial `processing` state ("Preparing…" / "Connecting…" at 0%) before calling the Tauri command, eliminating the dead-time gap before the sidecar sends its first progress event.

Errors from `importYoutube` and `uploadSong` are parsed by `friendlyError()` into human-readable messages covering bot-detection, VPN/proxy blocks, private/geo-blocked videos, and network failures.

### Player Store

All player state lives in a single Zustand store, `usePlayerStore`, built from slices in `src/stores/player/` (`song`, `transport`, `mixer`, `timeline`, `punch`, `devices`, `takes`, `countIn`, `recording`, `exercise`; each file owns the fields and actions of one concern, `index.ts` composes them, `types.ts` holds the interfaces). Import from `../../stores/player` as before.

```ts
import { usePlayerStore } from "../../stores/player";

const isPlaying = usePlayerStore((s) => s.isPlaying);
const togglePlay = usePlayerStore((s) => s.togglePlay);
```

Components subscribe to individual slices to avoid unnecessary re-renders. The store owns the `AudioEngine` and `VocalRecorder` singletons (accessed via module-level `getEngine()` / `getRecorder()` helpers, not stored in Zustand state).

**Mute/solo:** `effectiveVolume()` / `applyEffectiveVolumes()` (module-level helpers, not store actions) compute what actually gets pushed to `AudioEngine.set*Volume()` — soloing a track (`toggleSolo`) silences every other track, muting (`toggleMute`) silences only that one — but the raw `vocalsVolume` / `instrumentalVolume` / `takeVolume` slider values are never modified by either, so unmuting/unsoloing restores the exact prior slider position. `setVocalsVolume` / `setInstrumentalVolume` / `setTakeVolume` all funnel through `applyEffectiveVolumes` after updating their slice. `syncTrackVolumes` re-applies the current effective volumes and is called after `loadSong` and after a new take's WaveSurfer instance is created (`Waveform.tsx`), since a fresh WaveSurfer instance resets to `volume: 1` regardless of stored state.

## Key State Fields

| Field | Type | Description |
|-------|------|-------------|
| `song` | `Song \| null` | Currently loaded song |
| `isPlaying` | `boolean` | Playback state |
| `currentTime` | `number` | Playback position (seconds) |
| `duration` | `number` | Song length (seconds) |
| `playbackRate` | `number` | Speed multiplier (0.25–2.5) |
| `vocalsVolume` | `number` | 0–1 (raw slider value; never overwritten by mute/solo) |
| `instrumentalVolume` | `number` | 0–1 (raw slider value; never overwritten by mute/solo) |
| `mutedTracks` | `Record<TrackKey, boolean>` | Per-track mute state (`TrackKey = "vocals" \| "instrumental" \| "take"`) |
| `soloedTrack` | `TrackKey \| null` | At most one soloed track; solo overrides mute |
| `isLooping` | `boolean` | Loop mode active |
| `loopStart / loopEnd` | `number \| null` | Loop region (seconds) |
| `transpose` | `number` | Active semitone shift |
| `isTransposing` | `boolean` | Pitch-shift in progress |
| `isRecording` | `boolean` | Recording in progress |
| `isSavingTake` | `boolean` | Post-recording: blob flush + pYIN analysis in progress |
| `isMonitoring` | `boolean` | Live mic monitor active (no recording) |
| `takes` | `Take[]` | All takes for current song |
| `activeTakeId` | `string \| null` | Selected take (loads it as the take track) |
| `takeVolume` | `number` | 0–1 volume for the take track (raw slider value; never overwritten by mute/solo) |
| `punchIn` | `number \| null` | Region start (seconds); play always seeks here when set |
| `punchOut` | `number \| null` | Region end (seconds); playback stops or loops here |
| `punchLoop` | `boolean` | Loop the region during playback (cleared with the region) |
| `audioDevices` | `MediaDeviceInfo[]` | Available microphone inputs |
| `selectedDeviceId` | `string \| null` | Selected mic device ID |
| `outputDevices` | `MediaDeviceInfo[]` | Available audio outputs |
| `selectedOutputDeviceId` | `string \| null` | Selected output device ID |
| `minPxPerSec` | `number` | Timeline zoom level (WaveSurfer's own px-per-second unit); ctrl+wheel changes this |
| `scrollTime` | `number` | Song time (seconds) at the left edge of the visible timeline window; shift+wheel changes this |
| `metronomeOffset` | `number` | Song time (seconds) where the metronome's beat 1 lands; persisted per song via `set_metronome_offset` |

### Lyrics Store (`useLyricsStore` from `@giamat90/mps-core/lyrics`)

`{ songId, lyrics, draft, draftSource, status: "idle"|"loading"|"finding"|"syncing", progress, stage, error, notice }` with `load`, `setDraft`, `findOnline`, `sync`, `remove`, `clear`. Every async action re-checks `songId` before writing, so a result for a song that is no longer open is dropped. See [Lyrics Sync](lyrics.md).

### Exercise Store (`src/stores/exercise.ts`)

| Field | Type | Description |
|-------|------|-------------|
| `exerciseTakes` | `ExerciseTake[]` | All free-exercise recordings |
| `activeExerciseTakeId` | `string \| null` | Legacy expanded-take id (superseded by `loadedTrackId` below for the actual playback view) |
| `loadedTrackKind` | `"take" \| "imported" \| null` | UX copy only — both persist as an ordinary `ExerciseTake`, no separate data model for imports |
| `loadedTrackId` | `string \| null` | `ExerciseTake.id` currently loaded into `AudioEngine.exerciseTrack`, if any |
| `isImporting` | `boolean` | True while `importExerciseFile` is mid-flight (spinner state) |

Actions: `fetchExerciseTakes`, `addExerciseTake`, `deleteExerciseTake`, `setActiveExerciseTake`, `loadExerciseTakeIntoTrack(take, container)` (loads into `AudioEngine.exerciseTrack` + populates `useAnalysisStore`'s take-equivalent fields via `loadExerciseTakeAnalysis`), `clearLoadedTrack()`, `importExerciseFile(filePath, container)` (decodes duration client-side, calls the new `import_exercise_file` Tauri command, then loads the resulting take same as a recorded one).

### Updater Store (`useUpdaterStore` from `@giamat90/mps-core/updater`)

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"idle" \| "checking" \| "available" \| "downloading" \| "ready" \| "error"` | Update lifecycle state |
| `update` | `Update \| null` | Tauri `Update` object (version, release notes body, `downloadAndInstall()`) once found |
| `progress` | `number` | Download progress, 0..1, derived from `downloadAndInstall`'s chunk callback |
| `dismissed` | `boolean` | User clicked "Later" |

Actions: `checkForUpdates` (called once on app mount from `App.tsx`; failures are `console.warn`-logged and swallowed — a failed background check must never interrupt startup or surface as a user-facing error), `installAndRestart` (download → verify signature → silent install → `relaunch()`; failures set `status: "error"` so `UpdateDialog` can offer a retry), `dismiss`.

See [Architecture: Auto-Update](architecture.md#auto-update) for the endpoint/signing configuration this depends on.

## GUI Rule

**All dimensions must use relative units** — `%`, `rem`, `vw`, `vh`, `fr`. Never use fixed pixel values (`px`) for layout dimensions. This ensures the UI scales correctly across different screen sizes and DPI settings.

## Notable Component Details

### Library Folders (drag-and-drop)

`LibraryPage.tsx` groups songs into user-named, flat (non-nested) folders — e.g. all songs by one band — with drag-to-reorder and drag-to-move via `@dnd-kit` (first drag-and-drop library in this project; `react-beautiful-dnd` was ruled out as archived/unmaintained).

**Layout:** the folders block (`.library-page__folders`) and the root song list (`.library-page__list`) sit together inside **one scroll region** (`.library-page__scroll` — `flex: 1; min-height: 0; overflow-y: auto`), so a long folder list scrolls together with the songs under a single scrollbar instead of each region owning its own nested scrollbar. Only the Library toolbar (`.library-page__list-toolbar`, holding `+ New Folder`) stays pinned above the scroll region. One `DndContext` wraps the scroll region — `DndContext` renders no wrapper DOM element — and dnd-kit's built-in auto-scroll drives that single container while dragging. Trade-off vs. the earlier two-independent-scrollers design (folders capped at `max-height: 40vh` and pinned): folders now scroll out of view when the list is scrolled far, so reaching a folder as a drop target can mean scrolling back up — an explicit user call (2026-08-30), preferred over the double scrollbar.

**Components:**
- `FolderSection` — one folder's header (drag handle, collapse toggle, inline double-click-to-rename matching `SongCard`'s title-rename pattern, delete) plus its song list. `useSortable({ id: "folder:" + folder.id })` makes the folder itself draggable (reorder folders); a separately-prefixed id (`FOLDER_DRAG_PREFIX = "folder:"`) keeps folder-drag ids from colliding with song ids in dnd-kit's shared id namespace. `useDroppable({ id: folder.id })` (unprefixed) on the folder's body makes it a drop target for songs while it is open; a closed folder has no body, so the song is dropped on its header, which is the `folder:<id>` section (`resolveLibraryDrop` reads that as the folder and appends at the end; the folder stays closed).
- `DraggableSongRow` — wraps `SongCard` with a small drag-handle button (⠿) that receives dnd-kit's `attributes`/`listeners`; the card itself keeps its existing click-to-open/rename/delete handlers untouched, since making the whole card draggable would conflict with those.
- `RootDropZone` — `useDroppable({ id: "root" })` (takes `isDropTarget`) wrapping the un-foldered song list.

**Collapsed state persistence:** a folder's collapse toggle is not local component state — `FolderSection` reads/writes `collapsedFolders: Record<string, boolean>` on the settings store (`vps_settings` in localStorage). `LibraryPage` unmounts whenever the user opens a song or Free Exercise, so local `useState` was lost on every return to the library (bug fixed 2026-08-31). Missing key = expanded (the default).

**Collision detection:** `DndContext` uses a custom `pointerWithin` → `rectIntersection` fallback strategy, not dnd-kit's default `closestCenter`. `closestCenter` compares rect *centers*, so a short/empty folder next to the tall root song list frequently lost to a nearby list row even with the pointer squarely over the folder — the drop silently resolved to the wrong container (or nothing). Resolving by what's actually under the pointer fixed it; `rectIntersection` is only a fallback for the rare case nothing is directly under the pointer (e.g. a fast drag between containers). The highlight no longer reads `isOver` (false whenever the pointer is over a song row, and for a closed folder): `useLibraryPage` keeps `dropTarget` (set in `onDragOver` through `libraryDropTarget`, cleared on end/cancel) and the page puts `library-page__folder--target` on the whole folder section (header included) or `library-page__root-list--target` on the root list. Nothing is highlighted when the song would land in the container it is already in.

**Drop logic (`handleDragEnd` in `LibraryPage`):** a single store action, `moveSongs(folderId, orderedSongIds)`, covers both a same-folder reorder and a cross-folder move-at-position — a drag-and-drop UI naturally yields "the final ordered id list of the destination container" for either case, so there's no need for separate reorder vs. move code paths. Folder-drag (`activeId` starts with `folder:`) is handled separately via `reorderFolders(orderedIds)`.


### Library search

A search box in the Library toolbar (`LibraryPage.tsx`) filters songs as you type; Escape clears it. `filterSongs` in `src/lib/librarySearch.ts` (ported from SPS, 2026-10-12) matches when **every** word of the query appears in the title, artist, detected key, tempo (`93 bpm`), the folder's name or the word `instrument` for instrument tracks; case and accents are ignored. While a query is active the folder/drag-and-drop view is replaced by a flat result list in library order (root songs, then each folder's), each result tagged with its folder; there is no reordering during a search. Not shared through `mps-core`: SPS's `Song` has no `artist` or `kind`, so the haystacks differ.
### TransportControls

Stop button routes to `stopRecording()` during recording, `stop()` otherwise:

```tsx
<button onClick={isRecording ? () => void stopRecording() : stop}>
```

Slimmed down to skip/stop/play/record + elapsed/total time — volume sliders were moved onto each waveform track's own row (see `Waveform` below). Sits inside the sticky `practice-room__topbar` (see `PracticeRoom` layout).

**Record lives here (2026-10-24).** `TransportControls` renders `RecordButton` directly after Play, the Stop, Play, Record order of Pro Tools, Logic, Cubase and Reaper: recording is a global transport action, not a device setting, so it belongs with the transport and not with the input selectors (where it sat until then, after Monitor). The cluster reads skip, Stop, Play, Record, skip, ⏱, time. `RecordButton` stays its own component (hook, store and tests are unchanged); only where it is rendered moved. Pinned by `TransportControls.test.ts`, which fails if Record leaves the cluster or changes place.

**Play with a count-in.** `togglePlay()` is the transport's Play: with `countInBars > 0` and a song loaded it runs `runCountIn(countInPlan(get), "play")` first and calls `play()` only when the count finished; `isPlaying` stays `false` during the count, the Play button shows `countInBeatsRemaining` (`.transport__btn--counting-in`, pulsing) and reads "Cancel count-in", and pressing Play (or Space, the one shortcut that stays live while counting in) again cancels it without ever starting the song. Resuming from a pause counts in too; punch-loop wrap-arounds and the punch-out rewind do not (they never pass through `togglePlay`). `stop()`, `loadSong()` and `cleanup()` cancel a running count. `togglePlay()` leaves a recording's or a monitor's count-in to the Record/Monitor button. `play()` itself never counts in: Monitor's own count and the recording flow end in it.

**CountInButton** (`components/player/CountInButton.tsx`, headless `useCountInButton` from mps-core) is the ⏱ clock that cycles the count-in bars; it sits in the transport row after the buttons, is disabled while recording, counting in or saving, and moved here from beside the Record button when the count-in began to apply to Play.

### LoopsMenu and keyboard shortcuts

`LoopsMenu` (practice-room topbar, beside `LoopButton`) keeps two lists in one popover. **Saved loops** are named regions stored on the song (`Song.loops`, `set_song_loops`; the pure rules are `@giamat90/mps-core/loops`: `addLoop`, `renameLoop`, `removeLoop`, `validateLoop`). Saving takes the current punch region; clicking a loop calls `applyLoopRegion(start, end)`, which sets the punch region, turns the loop on and seeks to the start. **Bars** cuts the song into groups of 2, 4, 8 or 16 bars counted from the metronome downbeat at four beats to a bar (`barSections`); it is not structure detection, and needs a detected tempo.

Keyboard shortcuts (`installPlayerShortcuts` from `@giamat90/mps-core/hooks`, installed by `PracticeRoom` on `window`): Space play/pause, Home / End skip to start / end, ← → step 5 s (Shift: 1 s), L toggle the loop, [ and ] mark the region start and end at the playhead. Typing in a field, ctrl / alt / meta chords, auto-repeat and a focused button's own Space are left alone, and nothing runs while recording or counting in. The Free Exercise page has none.

### LoopButton

Standalone component (`src/components/player/LoopButton.tsx`), self-contained like `RecordButton`/`MonitorButton` — reads `punchIn`/`punchOut`/`punchLoop`/`isRecording`/`setPunchLoop` directly from `usePlayerStore`, no props. Always rendered (unlike the old in-ruler buttons it replaced, which disappeared entirely with no region set) — a circular `⟳` toggle, red-tinted (`.loop-btn--active`, using the same `#e94560` accent as the punch-region highlight) when `punchLoop` is true, `disabled` (dimmed via `.loop-btn:disabled`, `opacity: 0.4`) whenever there's no punch region (`punchIn === null || punchOut === null`) or while recording — so the button stays put as a stable landmark in the topbar instead of shifting the row layout in and out.

Rendered in `PracticeRoom.tsx`'s topbar directly after `<TransportControls />`, so it reads as part of the play/stop cluster rather than living on the ruler. Moved here (2026-07-10) from two separate in-ruler buttons — `TimeRuler.tsx` and `PianoRoll.tsx` each used to render their own absolutely-positioned `⟳` (`.time-ruler__loop-btn` / `.piano-roll__loop-btn`) tied to the same `punchLoop` state; both were removed since a single toggle next to the transport is more discoverable than a small button competing for space on the ruler, and de-duplicates the two copies into one. `.loop-btn` in `global.css` is a fresh rule (not a rename of the old ones) sized to match `.transport__btn` (`2.25rem` circular) since it now sits in that same flex row.

### RecordButton

Starts recording via `startRecording()`. If recording is already active, clicking stops via `stopRecording()`. Displays a pulsing red indicator while `isRecording` is true.

Rendered by `TransportControls` (see there), not by the page. A `2.25rem` ring, the size of the other transport buttons, drawn in the **`--record` token** (`#ef4444`, with `--record-soft` for the active tint and `--record-glow` for the glow in `polish.css`) rather than the accent: record is red in every app whatever its accent, which matters in SPS where the accent is amber. Active = square pulsing dot on a tinted ring; counting in = amber ring with the beat number; saving = amber spinner and an "Analyzing…" label. The status label and the error sit inline in the transport bar, so the error is clipped to `12rem` with an ellipsis and carries the full message in its `title` (it keeps `role="alert"`, so assistive technology reads all of it).

**Count-in (the ⏱ in the transport bar, see `CountInButton` under TransportControls).** One session-only setting, `countInBars` 0 → 1 → 2 → 0 (not persisted per song), counts in Play, Record and Monitor alike; it is independent of the 🥁 metronome toggle in `TempoControl`. The count is the `countIn` slice (`stores/player/countIn.ts`, wrapping mps-core's `createCountInSlice`; `countInPlan(get)` builds the plan): `runCountIn(plan, purpose)` clicks the shared `metronome` with `steadyCountIn(countInBpm(song.detectedBpm, playbackRate), bars)` (four beats a bar, flat, not phase-locked to `metronomeOffset`, first click 50 ms after the start), counts `countInBeatsRemaining` down with one timeout per beat, and resolves `true` when the count ends, `false` when `cancelCountIn()` aborts it or a second `runCountIn` replaces it. `countInFor` (`"play" | "record" | "monitor"`) says which button owns the countdown: the Record button shows it for `"record"` and `"monitor"`, the Play button for `"play"`.

`startRecording()` counts in after the mic is open and the output pinned (`runCountIn(…, "record")`), then starts the engine and the recorder; the click stops the instant capture starts (silence during the take, even if `countInBars` was armed), a deliberate product decision. Clicking Record during the countdown calls `cancelCountIn()`; a `false` result makes `startRecording()` release the mic (`abandonAfterCountIn`) and return without ever setting `isRecording`. It also sets `isPlaying: false` synchronously after `eng.pause()`, so TempoControl's metronome effect releases the shared `metronome` singleton before the count-in claims it. A recording started during the Play count-in replaces that count (a new `runCountIn` cancels the running one, so the song never starts twice).

### MonitorButton

Toggles live mic monitoring via `startMonitoring()` / `stopMonitoring()`. A labelled pill, 🎧 **Monitor** (icon `aria-hidden`, so the name is "Monitor"), with `aria-pressed`; while `isMonitoring` is true it is filled blue (`--info`, dark text) and pulses — this stays true across pause/play; the button reflects "mic session open", not "trace visible". Disabled (grayed out) while `isRecording` is true. Starting a recording automatically stops monitoring first.

**Placement (2026-10-24).** It sits in the input strip, between `MicSelector` and `OutputSelector` (Input, Monitor, Output), the way DAWs put input monitoring beside the input field (Logic's "I", Reaper's speaker, Ableton's In/Auto/Off). It used to be a `2.75rem` circle at the far end of the topbar next to Record. Free Exercise already had it beside the mic selector. `PracticeRoom.test.ts` pins the order.

**Count-in (song practice only).** The ⏱ button also governs the monitor. With `countInBars > 0`, `startMonitoring()` is Record minus the capture: it opens the mic, pins the hardware output (for the engine and the `metronome` singleton), pauses the song (`isPlaying: false` synchronously, same reason as above), plays the click for N bars via `runCountIn(…, "monitor")`, then calls `play()` (which honours `punchIn` and, being the plain start, does not count in a second time). With the count-in off the monitor behaves as before: mic only, the transport starts the song. During the count `isMonitoring` and `isCountingIn` are both true; clicking the monitor button again (or the Record button, which reads "Cancel count-in") cancels it. `stopMonitoring()` sets `isMonitoring: false` first, then `cancelCountIn()`, so the waiting `startMonitoring()` sees the stop and never plays; a cancel that came from the Record button instead makes `startMonitoring()` call `stopMonitoring()` itself. The monitor button is disabled while a count-in it did not start is running, and `startMonitoring()` refuses to start then.

**Works with a Free Exercise track loaded** (`useExerciseStore`'s `loadedTrackId !== null`): the loaded track is the clock and the reference, and the live mic trace (orange) is drawn over the track's pitch ribbon (red) in PianoRoll/PianoKeyboard, with DualTuner's needle comparing the live pitch against the track's (`takePitch`) instead of `songPitch`. Live pitch is only traced while the track is playing (`isMonitoring && isPlaying`), so press Play on the track and sing along. `ShortTermSpectrumPanel` draws both inputs while monitoring with a track loaded: the track's colored spectrum + formants, plus the live mic's smoothed envelope as an orange overlay (legend "● mic / ○ track"). `SpectrogramPanel` still shows only the loaded track (it gives `loadedTrackId` priority over the mic), and Record stays disabled while a track is loaded. History: from 2026-08-11 the button was disabled with a track loaded (starting monitor then froze the UI on the track because `getCurrentTime()` and the spectrum panels prioritize `exerciseTrack`); that guard was lifted by making `startMonitoring()`/`stopMonitoring()` skip the free-running exercise timer whenever `exerciseTrack` exists, and by having `loadExerciseTakeIntoTrack` / `clearLoadedTrack` hand the clock between the free timer and the track while monitoring. Headphones recommended — the monitor has echo cancellation off, so speaker bleed of the track into the mic will pollute the pitch trace.

When monitoring is active **and the track is playing** (`isMonitoring && isPlaying`):
- Microphone stream is opened (same `selectedDeviceId` as recording)
- Windows WASAPI output routing is pinned (same fix as `startRecording`)
- Live pitch flows into the piano roll orange ribbon, piano keyboard highlight, and DualTuner needle

While monitoring but **paused** (`isMonitoring && !isPlaying`), the mic stream stays open (button stays lit) but no pitch is captured or shown — `currentTime` is frozen while paused, so a still-running detector would otherwise keep appending points at that one frozen time, painting a stale smear instead of a trace. `DualTuner`'s effect is keyed on `isRecording || (isMonitoring && isPlaying)` (see [DualTuner](#dualtuner)) so it tears down its detector and clears `livePitch` the moment playback pauses, and starts a fresh trace when play resumes.

Nothing is saved — `startMonitoring()`/`stopMonitoring()` in `stores/player/recording.ts` call `useAnalysisStore.getState().clearLivePitch()` directly (start *and* stop), so the trace is wiped even if the analysis panel/DualTuner isn't mounted at the moment monitoring toggles; `startRecording()` does the same before opening its own stream. A third guard — a `usePlayerStore.subscribe()` in `stores/player/audioSync.ts` — clears `livePitch` on any `isPlaying: true → false` transition while `isMonitoring` is true, regardless of which of the many pause/stop call sites (`pause`, `stop`, punch-out, `onFinish`, `pauseExerciseTrack`, …) caused it. Don't rely on `DualTuner`'s effect alone for correctness — it only clears while it stays mounted across the transition; the store-level guards are what make clearing unconditional.

### TempoControl

BPM-first speed control for playback — no mode toggle, no preset buttons. Two stacked, editable rows in `tempo-control__bpm-group` (same column-alignment pattern as the Input/Output stack — see below):

1. **BPM row** — shown only when the song has a detected BPM: `{Math.round(detectedBpm)} BPM` badge in the header (right of the "Speed" label) plus a number input for the target BPM; the playback rate is computed as `targetBpm / songBpm`.
2. **Rate row** — a number input for the raw `×` multiplier (0.25–2.5), always shown. Both inputs share the same width (`tempo-control__bpm-input`, `3.75rem`) so they align.

Editing either input recomputes and commits the other (`commitBpm` / `commitRate`) — both ultimately call `setPlaybackRate`. Enter or blur commits; invalid input reverts to the last good value. If a song has no detected BPM, only the rate row is usable.

**Metronome (🥁 toggle, header row):** local component state (`metronomeEnabled` — not in the Zustand store, since nothing outside this component needs it), synced to playback rather than free-running: a `useEffect` starts/stops the `Metronome` singleton from `@giamat90/mps-core/metronome` whenever `metronomeEnabled`, `isPlaying`, the effective BPM, or `metronomeOffset` (see below) change, so it's silent while paused, resumes with the transport, and always resyncs — rather than just retuning — on a mid-playback speed change or a dragged downbeat marker. Ticks at the effective BPM (`(detectedBpm ?? 120) * playbackRate` — falls back to 120 when the song has no detected BPM, since the rate row is always usable). `Metronome` uses the standard Web Audio lookahead scheduler (25 ms `setTimeout` tick, 100 ms schedule-ahead window) rather than a naive `setInterval`, so it doesn't drift under JS event-loop jitter. Every 4th click (beat 0 of an assumed 4/4 bar) is accented — higher pitch (1500 Hz vs 900 Hz) and louder gain — with no way to change the time signature, since neither project stores one. `AudioContext` is created lazily on first `start()` and suspended (not closed) on `stop()`, so re-toggling doesn't pay context-creation cost repeatedly.

**Downbeat offset (phase-locking):** the metronome used to always start ticking at beat 0 the instant playback started, drifting out of sync with the song's actual downbeat whenever there's silence (or a pickup) before it. `metronomeOffset` (player store, persisted per song via the `metronomeOffset` field on `Song` and the `set_metronome_offset` Tauri command — mirrors the `rename_take` pattern) is a song-time anchor the click track phase-locks to instead: `src/lib/metronomeSync.ts`'s `computeMetronomePhase()` (pure, byte-identical with SPS) takes the raw `detectedBpm`, `playbackRate`, `metronomeOffset`, and the current song time, and returns the wall-clock delay until the next aligned click plus which beat-in-bar it is — `TempoControl` passes that straight into `Metronome.start()`. `Metronome.start()` was reworked to accept `(bpm, timeUntilNextBeat, startBeat)` and always reset phase, even if already running (removed the old "already running → just retuned" early-return, and the now-unused `setBpm()` method), since a stale scheduled phase is exactly the bug this fixes. The anchor extends the beat grid in both directions — a value later than song position 0 still implies clicks *before* it too (e.g. as a lead-in through intro silence), not just after.

The anchor is set two ways, both in `TempoControl`'s new "Downbeat" row (shown only while `metronomeEnabled`) and on `TimeRuler`:
- **Set button** — captures `getEngine().getCurrentTime()` at the moment it's clicked (play the song, pause on the downbeat, click Set).
- **Drag** — `TimeRuler` draws a draggable marker (dashed blue vertical line + downward flag at the bottom edge, `rgba(74,158,255,...)`) at the anchor's position. Its hit-test (`HANDLE_HIT_PX`) is checked *before* the existing punch-region `create`/`drag-in`/`drag-out` modes in both `onMouseDown` and the hover cursor logic in `onMouseMove`, so grabbing the marker never falls through to punch-region creation. A `"drag-metronome"` `DragMode` and a third `overrideMetronome` parameter on `draw()` (mirroring the existing `overrideIn`/`overrideOut` pattern) give live visual feedback during the drag without committing to the store until `onMouseUp`.

A "↺" reset-to-0 button appears next to Set once the offset is nonzero.

### TimeRuler

The logic (drawing, drag, cursors) is mps-core's `useTimeRuler`; the component is the `<canvas>` and passes the punch accent `233,69,96` and `lockWhileRecording: true`.

Canvas strip above the waveform tracks (`2.8rem` tall). Shows time ticks at adaptive intervals (≥ 80 px target). Font size scales proportionally with canvas height. All ruler interaction is disabled during recording.

**Interactions:**
- **Click + drag** on empty space → draw a new punch region
- **Hover / drag near In or Out handle** (±12 px) → cursor becomes `ew-resize`; drag moves only that boundary, the other stays fixed
- **Click** (< 0.5 s drag) → clear punch region and reset loop toggle
- **Drag the blue downbeat marker** (dashed line + flag at the bottom edge) → move the metronome's phase-lock anchor; checked with priority over the punch-region modes above (see [Metronome: Downbeat offset](#tempocontrol))

Toggling the loop itself is done from [LoopButton](#loopbutton) next to the transport controls, not from a button on this ruler (moved 2026-07-10; see that section for why).

The region is drawn as a red band on the canvas with I-beam caps at the handles. Each waveform track also shows a translucent `PunchOverlay` div, now positioned in pixels (`left`/`width` derived from `minPxPerSec`/`scrollTime`, not the track's raw width — see [Timeline Zoom/Pan](#timeline-zoompan) below) so it stays aligned with the waveform under zoom/pan.

All of `tX`/`xToTime` (coordinate mapping), `modeForOffset` (handle hit-testing), and the tick-drawing loop read `minPxPerSec`/`scrollTime` from the player store instead of assuming the whole song spans the full canvas width — tick spacing gets finer as zoom increases (`tickInterval` is computed from the *visible* duration, `canvasWidthPx / minPxPerSec`, not the song's total duration), and only the visible time range is drawn.

### Waveform

Renders `TimeRuler` at the top, then up to three stacked tracks, each with a `.waveform__track-header` (label + `TrackControls`) above a `.waveform__track-body` (position: relative, `overflow: hidden`, wraps the WaveSurfer container so `PunchOverlay` and the take rail can be absolutely positioned over it without spilling out when off-screen under zoom/pan):

1. **Vocals** — always visible; original vocals track
2. **Instrumental** — always visible; backing track and time reference
3. **Take** — conditionally rendered when `activeTakeId` is set; orange waveform positioned at the correct time offset and proportional width using `eng.loadTakeTrack()`

**`TrackControls`** (local sub-component, one instance per row): mute button (`M`, amber `--on` state), solo button (`S`, green `--on` state), and a volume slider — wired to the player store's `toggleMute`, `toggleSolo`, and the relevant `set*Volume` action for that track. After a new take's WaveSurfer instance loads, the effect calls `syncTrackVolumes()` so the fresh instance picks up the stored effective volume instead of defaulting to full volume.

#### Take Sync Controls

`TakeSyncControls` (local sub-component, rendered in the take track's header next to `TrackControls`) lets the user drag the take into sync with the other tracks after recording, then reset it back to the auto-detected position.

- **Grip handle** (`⠿`) — a small button, not the waveform body itself, so dragging never conflicts with WaveSurfer's own `"interaction"` click-to-seek on the take waveform. Uses **Pointer Events** (`onPointerDown` + `e.currentTarget.setPointerCapture(e.pointerId)`, then `onPointerMove`/`onPointerUp`) rather than `TimeRuler.tsx`'s plain mouse events — the grip is a small element, so tracking needs to survive the pointer leaving its bounds mid-drag, which pointer capture guarantees and plain React mouse handlers on a small target do not.
- A `< 3px` movement threshold distinguishes an intentional drag from a click before calling `getEngine().setTakeManualOffset(newOffset)` live on every `pointermove` (see [Audio Engine: Manual Take Sync](audio-engine.md#manual-take-sync)) — no store write during drag.
- The offset is **unclamped in both directions** — dragging left of song time 0 is allowed (the take's leading edge before song time 0 simply becomes unreachable during playback via the existing `Math.max(0, …)` guard in `_seekTake`; the recorded file itself is never trimmed or otherwise modified). On `pointerup` the offset is committed via the player store's `setTakeManualOffset(takeId, offset)` action, which rounds to `0.01s` (tightened from the original `0.1s` — see nudge buttons below), persists via `set_take_manual_offset`, and re-invokes `loadTakeAnalysis` so PianoRoll/DynamicsCurve/spectrum panels track the new alignment.
- **Live analysis tracking during the drag itself**, not just on commit — the whole reason to drag is comparing the take's pitch/spectral shape against the song's, so waiting until release to update PianoRoll/ShortTermSpectrumComparisonPanel would defeat the point. Every `pointermove` also calls `useAnalysisStore`'s `previewTakeManualOffset(take, newOffset)`, throttled to `TAKE_PREVIEW_THROTTLE_MS` (33ms, matching the engine rAF tick's own ~30fps UI-notification gate) via a `lastPreviewAt` ref — a raw pointermove stream can exceed 60/s on a high-poll-rate mouse, and each call re-derives `PitchPoint`/onset/dynamics arrays. `previewTakeManualOffset` reuses the take's already-decoded short-term-spectrum bytes from state (only remapping the `times` array) rather than re-running `decodeSTSpectrumFrames`'s base64 decode on every call — that decode is the expensive part of a full `loadTakeAnalysis`, and the byte content never changes during a drag, only the time axis. `loadTakeAnalysis` (the full, authoritative recompute) still runs once on commit via `setTakeManualOffset`, so any preview approximation is corrected immediately on release.
- **Reset button** (`↺`) — always mounted, `disabled` (not unmounted) when `take.manualOffset` is falsy, matching how other transport buttons in this codebase indicate unavailability. Calls the same store action with `offset = 0`.
- **Nudge buttons (`◀`/`▶`) + focus-scoped arrow keys** — added because dragging alone was reported hard to use for fine correction. Each click, or each `ArrowLeft`/`ArrowRight` keypress while the `.waveform__take-sync` container has focus (click it or Tab to it — deliberately not a global/app-wide shortcut, since arrow keys aren't claimed for anything else here), nudges by `TAKE_NUDGE_STEP_S` (10ms); holding Shift multiplies by `TAKE_NUDGE_COARSE_MULTIPLIER` (5x = 50ms) for coarser moves. Both paths call the exact same `setTakeManualOffset(take.id, offset)` commit action the drag handle uses on release — no separate live-preview path, no new engine method or Tauri command.
- **Editable offset field** (`waveform__take-offset`, a number input, not a static label) — lets the user type a rough offset directly (e.g. `300` for a ~300ms drift) instead of nudging up from 0 one step at a time, then fine-tune from that starting point with the nudge buttons/arrow keys. Local `offsetInput` text state (not driven straight from the store) so a partially-typed value like a lone `-` survives re-renders; re-synced from `take.manualOffset` via a `useEffect` only while the field isn't focused (tracked with an `inputFocused` ref, since a ref read in an effect wouldn't itself trigger re-sync on blur). Commits on blur or Enter (`Number(offsetInput) / 1000` through the same `setTakeManualOffset` action); Escape reverts the field to the current committed value and blurs without committing. `onFocus` selects all text for quick overwrite. The field's own `onKeyDown` calls `e.stopPropagation()` unconditionally so Left/Right/Up/Down keystrokes move the text cursor / native number-input step instead of triggering the container's arrow-nudge handler — the nudge handler lives one level up on `.waveform__take-sync` and would otherwise catch the same bubbled keydown.

#### Timeline Zoom/Pan

`TimeRuler` and the three track rows are wrapped in a new `.waveform__timeline` element (`ref`'d as `timelineRef`), which owns two `useEffect`-mounted listeners:

- A **non-passive `wheel` listener** (`addEventListener("wheel", handler, { passive: false })` — React's `onWheel` prop is passive since React 17 and can't `preventDefault()` native ctrl+wheel page-zoom). Ctrl+wheel calls `computeZoomToCursor()` (`src/lib/zoomPan.ts`) with the cursor's pixel offset within the wrapper, then `eng.zoomAll(newPx, newScroll)`; shift+wheel calls `computePan()` then `eng.setScrollAll(newScroll)`. Both cases call `eng.noteManualScrollInteraction()` first, suppressing the engine's playhead auto-follow (see [Audio Engine: Timeline Zoom/Pan](audio-engine.md#timeline-zoompan)) for 800ms. Wheel events without `ctrlKey`/`shiftKey` are ignored (not `preventDefault()`-ed), so ordinary page scroll/zoom over the timeline behaves normally.
- A **`ResizeObserver`** that reclamps `scrollTime` into bounds and snaps `minPxPerSec` up to the new dynamic "whole song fits" floor if the container shrank, since both depend on live container width.

`@giamat90/mps-core/zoomPan` holds the pure math (one copy, shared with SPS): `computeZoomToCursor()` keeps the exact song-time under the mouse cursor fixed on screen while `minPxPerSec` changes by an exponential factor of wheel delta (`Math.exp(-deltaY * ZOOM_SENSITIVITY)` — proportional zoom feels consistent regardless of current zoom level, unlike a fixed additive step); `computePan()` shifts `scrollTime` by `deltaPx / minPxPerSec`. Both clamp `scrollTime` into `[0, max(0, duration - viewportWidthPx/minPxPerSec)]` and `minPxPerSec` into `[dynamicLowerBound, MAX_PX_PER_SEC]` — the lower bound comes from `eng.getMinPxPerSec()` (the "whole song fills the container" floor), so zooming out can never scroll past the song's edges.

**Export Mix button** (`ExportMixButton.tsx`) and **Download All button** (`DownloadAllButton.tsx`, ported from SPS) both render in `PracticeRoom.tsx`'s `.practice-room__header`, next to the song title — not inside `Waveform.tsx` itself, since they act on the whole song rather than the waveform view specifically. Extracted out of `Waveform.tsx` (2026-07-08) so the header could host both as an "all whole-song actions live in one place" convention, matching SPS's `AnalyzerPage.tsx` header.

- **Export Mix** renders the current audible mix to a WAV via the `export_mix` Tauri command (sidecar `mix_export`). `buildMixSources(state)` in the player store resolves one final linear gain per track from mute/solo/volume, includes the active take (with its `startPosition`/`audioOffset`/`manualOffset` alignment), and clamps the render window to the punch region when one is set. The button subscribes to every input `buildMixSources` reads so its enabled/disabled state stays correct; it shows "Exporting…" while the sidecar renders, then opens a native Save As dialog. Native `title` tooltip: "Export the currently audible mix as a WAV file" (or "No audible tracks to export" when disabled).
- **Download All** bundles `vocals.wav` (relabeled "Melody.wav" for `kind: "instrument"` songs, which skip the instrumental) + `instrumental.wav` + every take's `filepath` into a single zip via the `export_all` Tauri command, opening one native Save As dialog instead of downloading each track individually. Take archive names dedupe against a running `Set` (`"Take 2 (2).wav"` etc.) the same way SPS's version does. Unlike SPS there's no dynamic stems array to iterate — the two fixed track paths are derived directly from `song.directory`. Native `title` tooltip: "Download all tracks and takes as a zip archive".

**Instrument practice tracks** (`song.kind === "instrument"`): the vocals row is relabeled "Melody" (its `vocals.wav` file is the actual practice-track audio for these songs — see [Data Model](data-model.md#song)). The instrumental row — an identical duplicate of the same audio — stays mounted (WaveSurfer needs a real container to measure) but is visually collapsed via `waveform__track--hidden` (absolute position + `height: 0`, not `display: none`, so it keeps a layout box to measure against). `loadSong` sets `mutedTracks.instrumental = true` by default for these songs so the duplicate isn't audible; the mute button still works normally if the user wants to double-check.

### MicSelector / OutputSelector

Call `fetchAudioDevices()` / `fetchOutputDevices()` on mount to populate device lists. Before the first `getUserMedia` call, `enumerateDevices()` returns devices with empty labels and indistinguishable `deviceId`s. As soon as `getUserMedia` grants permission — whether from clicking **Monitor** or **Record** — the store re-enumerates and pushes the labelled list so named devices (e.g. "Focusrite USB Audio") appear immediately.

`MicSelector`'s label reads **"Input"** (not "Mic"). In `PracticeRoom`'s topbar the two sit in one row inside `practice-room__io-group` with `MonitorButton` between them (Input, Monitor, Output), the labels' `min-width` reset to `0` and the row centred on one baseline.

### KeyTranspose

Displays the current `transpose` value in semitones with ±12 range. Triggers `setTranspose(n)` which pauses playback, calls the Python sidecar to generate shifted WAVs, then reloads the engine with the new files.

While `isTransposing` is true, the displayed value is **not** replaced with a placeholder like `"…"`. Instead a local `pendingTranspose` state holds the target semitone value the instant a button is clicked, displayed immediately with a `key-transpose__value--pending` class that pulses (`opacity` 0.35 ↔ 0.9, 0.9s loop) until the pitch-shift resolves — so the user sees where the control is headed rather than a blank/frozen indicator. Sits in `practice-room__topbar-devices`, to the right of the Input/Output strip. In the topbar it is one row like Speed and Input/Output (label, `-`, value, `+`, Reset), centred on the same line as them (`.practice-room__topbar .key-transpose` is `flex-direction: row`); it used to be a label stacked over the buttons, which stood taller than its neighbours.

### PianoRoll

VoceVista-inspired scrolling pitch display. Renders at native frame rate via a `requestAnimationFrame` loop that reads `getEngine().getCurrentTime()` directly — no React re-renders during playback.

**Layout:**

```
┌─ piano-roll__ruler-wrap (2.4rem) ──────────────────────┐
│     time ruler: ticks · punch region · center playhead │
└────────────────────────────────────────────────────────┘
┌─ canvas (15rem) ───────────────────────────────────────┐
│ |── 36px piano ──|──── scrolling pitch roll ───────── │
│ │  C5 key label  │  song ribbon (blue)                │ │
│ │  white/black   │  take ribbon (red)                 │ │
│ │  keys          │  live ribbon (orange)              │ │
│ │                │       ╎ playhead   [G4 D#4] ──top-right note │
└────────────────────────────────────────────────────────┘
```

**Time ruler (above canvas):**
- Shows the current 8-second window with absolute time tick marks
- Punch region overlay (same `punchIn`/`punchOut` store values as the waveform TimeRuler)
- Drag on empty area → draw new punch region; drag near handle → move that boundary; click → clear
- Coordinates use `capturedT0` from mousedown so the window stays stable during a drag

Loop toggling for this region (and the waveform's identical one — same `punchIn`/`punchOut`/`punchLoop` store fields) is done from [LoopButton](#loopbutton) next to the transport controls; this ruler no longer renders its own `⟳` (moved 2026-07-10, deduplicating what used to be two separate loop buttons — one here, one on `TimeRuler` — into one).

**Drag-to-seek (main canvas):**
- Horizontal drag on the pitch roll area seeks the playhead and syncs all tracks
- Drag left → forward in time; drag right → backward (pan-content gesture)
- Delta is computed from the initial drag position so the view tracks the finger accurately

**Drawing passes (in order):**
1. Lane backgrounds — black-key rows slightly darker, C-octave boundaries marked with a brighter rule
2. Song pitch ribbon — `rgba(74,158,255,0.88)` thick polyline following SRH pitch data; line breaks on gaps > 80ms or confidence < 0.5
3. Take pitch ribbon — `rgba(233,69,96,0.92)` same style, drawn over the song ribbon
4. Live pitch ribbon — `rgba(255,140,30,0.9)` drawn while recording, or while monitoring *and playing*, from autocorrelation readings accumulated in `livePitch[]` (analysis store); disappears the instant recording/monitoring stops, or the track pauses while only monitoring (see [DualTuner](#dualtuner))
5. Playhead — dashed vertical line at canvas center
6. Note label — current note name(s) shown right-aligned at top-right of the roll (e.g. "A4 G#4")
7. Piano key strip — drawn last so it sits on top of any ribbon that bleeds into the left column; key color priority: live (orange) > take (red) > song (blue)

**Constants:** 40-semitone visible window, 8-second time window, `15rem` canvas height.

**Sliding vertical window:** the visible pitch range no longer sits at a fixed MIDI span. `PIANO_WINDOW_SIZE = 40` (unchanged) semitones are always shown, but the window's lower bound (`midiMin`, a float held in a `windowMinRef`) slides to follow whichever pitch is currently active (`liveMidi ?? takeMidi ?? songMidi`), letting the same visual resolution as the old fixed A2–C6 range support the full `PIANO_ABS_MIN`–`PIANO_ABS_MAX` (C0–C7) keyboard — needed for wide-range instrument practice tracks. See [constants.ts](../src/lib/constants.ts): `computePianoWindowTarget()` only moves the window once the active note gets within `PIANO_FOLLOW_MARGIN` (6 semitones) of an edge (a "dead zone" so normal melodic movement doesn't cause drift), and `stepPianoWindow()` eases toward that target by a fixed fraction (`PIANO_FOLLOW_LERP = 0.06`) every animation frame, so the window glides rather than snaps. `midiToY`/`drawLanes`/`drawRibbon`/`drawPianoStrip` (in `src/lib/pianoRollGeometry.ts` / `pianoRollDraw.ts`) all take the float `midiMin` directly — no rounding — so the ribbon and lane backgrounds scroll continuously pixel-by-pixel rather than jumping a whole semitone at a time. When no pitch is active, the window holds its last position.

**No spectrogram:** frequency spectrogram was moved to the dedicated `SpectrogramPanel` component (Free Exercise page only).

**Click-to-preview on the piano key strip:** clicking (or dragging across, glissando-style) the 36px key strip plays a sustained synthesized tone at that note — a quick pitch reference, independent of song/take/live playback. Press-and-hold sustains; releasing (mouseup/mouseleave) or moving to a new key during a drag triggers a short release ramp rather than an instant cutoff. Implemented via `startPreviewNote(midi, sinkId)` in `src/audio/notePreview.ts` (new module, standalone from `AudioEngine` — follows the same singleton `AudioContext` lifecycle pattern as the shared `metronome` module (`@giamat90/mps-core/metronome`), and routes through the user's selected output device via the `sinkId` `AudioContextOptions` construction pattern established in `RecordingOffsetControl.tsx`), which returns a `PreviewVoice` with `.release()`; the component tracks the active voice in the `stripDrag` ref alongside the existing drag-to-seek state, branching on `offsetX < PIANO_W` in the same `onCanvasMouseDown`/`onCanvasMouseMove`/`onCanvasMouseUp` handlers used for drag-to-seek (mutually exclusive by construction — a mousedown is either in the strip or in the roll, never both) so the existing seek gesture on the rest of the canvas is untouched. `midiFromY()` is the algebraic inverse of `midiToY()`, rounded to the nearest semitone lane. The currently-held key is highlighted with a translucent white overlay (`COLOR_PREVIEW`) drawn on top of whatever song/take/live color that lane already has. Disabled during recording (same `isRecording` guard as the rest of this canvas's handlers) so the preview tone can't bleed into a live take. Same feature also applies to [PianoKeyboard](#pianokeyboard) below, sharing the `notePreview.ts` module but with independent (x-based vs. y-based) hit-testing math.

### SpectrogramPanel

Scrolling live spectrogram rendered exclusively in the Free Exercise page. Shows the full audio spectrum in real time — not shown in song practice (`PracticeRoom`). Data source is either the live microphone (recording/monitoring) or, when a track is loaded via [Free Exercise Track Loading](#free-exercise-track-loading), a frame-accurate snapshot of that track's decoded audio (see "Mic analyser" below).

**Formant tick marks:** F1/F2/F3 estimated client-side via `estimateFormants()` (`@giamat90/mps-core/spectrum` (`formants.ts`) — pre-emphasis → Hamming window → autocorrelation → Levinson-Durbin LPC → Durand-Kerner polynomial root-finding → pole-to-resonance conversion → frequency/bandwidth candidate filtering → frame-to-frame continuity matching + light exponential smoothing) drawn as short horizontal tick marks at each formant's `freqToY(...)` position, written into the same new column the spectrogram writes to each capture so they scroll with the waterfall and leave a trail. A `null` estimate (unvoiced/silence) skips that tick rather than holding a stale mark. Durand-Kerner was chosen over the more commonly-cited Bairstow's method for lower implementation risk (no partial-derivative recurrence bookkeeping) at the polynomial orders (~14, after decimating to a ~12kHz-equivalent bandwidth) this needs — both validated against known-root polynomials during development.

**Frequency axis:** 30 Hz (bottom) → 20 kHz / Nyquist (top) on a **log-frequency scale**. The 30 Hz floor (not 20 Hz) keeps the 50–100 Hz region fully visible within canvas bounds. Tick marks and Hz labels at 30 · 50 · 100 · 200 · 500 · 1k · 2k · 5k · 10k · 20k Hz (20k pinned at top edge). Faint horizontal grid lines at 100 · 500 · 1k · 5k · 10k Hz are drawn on the main canvas after the offscreen composite so they remain crisp. Axis strip: `AXIS_W = 56` physical pixels.

**Resolution:** 8192-point FFT (`fftSize = 8192`, `frequencyBinCount = 4096`). `getFloatFrequencyData()` into a `Float32Array` gives full dB precision (no quantisation). Each canvas pixel row maps to an FFT **bin range** via a pre-computed per-row `[low, high]` LUT; the row's value is the **max dB across its bin range** (max-in-range mapping — fills the gaps a nearest-neighbor lookup leaves on a log-frequency axis). LUT is cached and rebuilt only on canvas resize or sample-rate change.

**Scroll rendering (left-shift pattern):**
1. Every ~33 ms tick, call `getFloatFrequencyData` into `fftScratch`.
2. Compute normalised magnitude for each row → `colNorms[]` (no vertical blur — relies on temporal blending only).
3. Shift offscreen canvas left by `shift` pixels: `getImageData(shift, 0, rollW-shift, H)` → `putImageData(…, 0, 0)`.
4. Write `shift` new columns at `rollW - shift` from norms via colormap lookup.
5. Composite offscreen onto main canvas at `globalAlpha = 0.72` for temporal smoothing (main canvas is **not** cleared between frames during active capture — old frames decay naturally).

`shift` is computed from a fractional accumulator: `shiftAccum += rollW * 33 / (WINDOW_S * 1000)`, so the full canvas width always represents exactly `WINDOW_S = 10` seconds regardless of physical canvas width or DPR.

**dB mapping:** `MIN_DB = -85`, `MAX_DB = -20` (VoceVista-matched dynamic range; exported and reused by the Short-Term Spectrum panels). Hard noise gate: `db < -80 → norm = 0`. Soft gate below `norm = 0.15` (`norm·(norm/0.15)·0.3`) pushes the noise floor to black. Gamma correction: `Math.pow(gated, 0.38)`. `smoothingTimeConstant = 0.15` (set on every capture tick — single authoritative location). A vertical dB legend bar (`LEGEND_WIDTH = 52` px, ticks −20 … −85) is drawn on the right using the same constants so it always matches the display mapping.

**Colormap:** Thermal — black → dark navy (index 64) → medium blue → teal (index 148) → yellow → orange → bright red-orange (index 230) → salmon (index 245) → pure white (index 255). Built by `buildColormap()` in `src/lib/spectroUtils.ts` using index-based linear interpolation so the noise floor is dark navy/black and only peak harmonics flash white.

**Mic analyser / track snapshot:** Live mic reads from `getMicAnalyser()` (player store singleton, `fftSize = 8192`); no second `getUserMedia` is opened. When a track is loaded (`loadedTrackId !== null`), the panel instead calls `AudioEngine.getExerciseTrackSamples(8192)` + `AudioEngine.getExerciseTrackSampleRate()` and runs its own FFT (`computeMagnitudeSpectrumDb` in `src/lib/fft.ts`, a dependency-free radix-2 Cooley-Tukey implementation, Blackman-windowed) — this works whether the track is playing, paused, or was just scrubbed, unlike an `AnalyserNode`, which only reports data while audio is actively flowing through it. **Scrolling vs. snapshot:** the waterfall only keeps shifting/scrolling while audio is actually advancing (`shouldScroll = isRecording || isMonitoring || (trackActive && isPlaying)`); paused/scrubbed with a loaded track, prior history stays in place and only a fixed 6px strip at the right edge is overwritten each capture with the current frame, so scrubbing updates the view without the waterfall endlessly "scrolling" a frozen value. Idle state (neither recording, monitoring, nor a loaded track) freezes the canvas; the roll area is cleared to `#0f0f1e` only on true idle.

**Loaded-track centered mode (`staticMode`):** a loaded track's whole spectrogram is precomputed once (`src/lib/exerciseSpectrogram.ts`'s `computeTrackSpectrogram()` — same FFT/LUT/dB-curve pipeline as the live waterfall, `buildFreqBinLut`/`dbToCurvedNorm` exported from this file for that purpose, 4096-sample hop = 50%-overlap of the 8192 FFT, ~93ms/column, `TRACK_SPECTRO_ROWS = 160` fixed rows scaled to canvas height via `drawImage`) into a `TrackSpectrogram { canvas, hopTime, cols, rows }` stored on `useExerciseStore.exerciseTrackSpectrogram`, computed in `loadExerciseTakeIntoTrack` right after `AudioEngine.loadExerciseTrack()` (chunked with a `setTimeout(0)` yield every 40 columns so a multi-minute track doesn't freeze the UI thread) and cleared on unload. Once available, the panel switches from the live right-aligned waterfall to a **centered, drag-to-seek window** over that precomputed canvas — mirroring `PianoRoll`'s centered pitch ribbon instead of the append-and-scroll model, since the whole track's spectrum is already known up front (unlike live mic input, which has no future to precompute). The window is `[currentTime - WINDOW_S/2, currentTime + WINDOW_S/2]`, cropped/padded at the track's start/end, with a dashed center playhead line. Drag-to-seek uses the exact same semantics as `PianoRoll`'s main-canvas drag (`deltaT = -((offsetX - startX) / rollW) * WINDOW_S`, calling the shared `seek()` player-store action) so both widgets scrub the one shared engine/store time the same way — which is also what keeps `ShortTermSpectrumPanel` and the loaded track's own WaveSurfer waveform cursor (`exercise-page__track-strip`) in sync on every drag, since they all read the same `AudioEngine` singleton rather than needing bespoke cross-widget wiring. Formant markers in this mode are drawn only at the center (current-time) position, estimated live from `getExerciseTrackSamples()` each frame — formant tracking needs frame-to-frame continuity (`prevFormant` smoothing) rather than a one-off precomputed pass, so unlike the spectrogram picture itself they aren't precomputed per-column. While the precompute is still running (`isComputingSpectrogram`, shown as "computing…" in the header hint), the panel falls back to the live waterfall so there's no blank/broken view during the brief gap after loading a track. Note `WINDOW_S = 10` here vs. `PianoRoll`'s `WINDOW_S = 8` — visual alignment/dragging behavior is unified, not the exact zoom level.

**Layout in ExercisePage:** Inside `exercise-page__spectro`, below the `exercise-page__keyboard` strip and `exercise-page__roll`, inside the `exercise-page__analysis` scrollable wrapper. Canvas height: `clamp(15rem, 45vh, 35rem)`.

### Where the analysis panels' drawing code lives

`SpectrogramPanel`, `ShortTermSpectrumPanel`, `ShortTermSpectrumComparisonPanel` and `PianoRoll` only wire React to the canvas: they read the stores and the audio engine, pick the data source, and call helpers. Everything that is arithmetic or a drawing pass is in `src/lib/` and imports neither components nor stores (a lib module importing a component was the VPS import cycle `exerciseSpectrogram → SpectrogramPanel → stores/exercise → exerciseSpectrogram`, fixed 2026-10-17).

| Panel | Pure maths | Canvas helpers |
|---|---|---|
| SpectrogramPanel | `spectrogramMath.ts` | `spectrogramDraw.ts` |
| ShortTermSpectrumPanel | `spectroShortTerm.ts` (both) | |
| ShortTermSpectrumComparisonPanel | `spectroComparison.ts` (both; reuses `spectroShortTerm`'s grids) | |
| PianoRoll | `pianoRollGeometry.ts`, `pianoRollPunch.ts` | `pianoRollDraw.ts` |

Canvas helpers take a `CanvasRenderingContext2D` and are tested with the recording context in `src/test/fakeCanvas.ts` (asserts on calls and colours, not pixels). A new constant or draw pass belongs in these modules, not back in the component.

### ShortTermSpectrumPanel

Real-time spectral **snapshot** (not a waterfall) — a single spectrum curve fully redrawn each frame, on the Free Exercise page below the SpectrogramPanel. Horizontal **log-frequency axis** (reuses `freqToX`/`xToFreq` from `src/lib/spectroUtils.ts` and `F_MIN`/`F_MAX`/`MIN_DB`/`MAX_DB`/`AXIS_W`/`LEGEND_WIDTH` exported by `SpectrogramPanel`), vertical dB axis with 10 dB ticks. Draws the raw spectrum plus a **smoothed spectral envelope overlay** — a moving average whose window widens with frequency, since formants are proportionally wider at high frequencies on a log axis.

Data source mirrors `SpectrogramPanel`: live mic via `getMicAnalyser()` (no second `getUserMedia`), or — when a track is loaded — a snapshot via `AudioEngine.getExerciseTrackSamples()`/`getExerciseTrackSampleRate()` + `computeMagnitudeSpectrumDb()`. Since this panel has no scroll/history state at all (it's a full redraw every frame regardless of play state), it needed no paused-vs-scrolling distinction — it already shows the current frame correctly whether playing, paused, or scrubbed.

**dB scale (changed 2026-10-08):** this panel now uses its own `-100..0` dBFS range (same as `ShortTermSpectrumComparisonPanel`, no longer `SpectrogramPanel`'s `-85..-20`) and adds `WEBAUDIO_TO_DBFS` (≈ +13.6 dB) to both inputs. Reason: the sidecar's stored song spectrum divides the STFT by the window's coherent gain (full-scale tone = 0 dBFS) while `AnalyserNode` and `fft.ts`'s mimic divide by N (full-scale tone ≈ −13.6 dB), so the same vocals stem looked 13.6 dB quieter in Free Exercise than in a song's analysis (measured on a real stem: median peak offset 13.6 dB). Remaining known differences vs the practice-room panel: the sidecar's window is now Blackman too, but a trailing 8192-sample window ending at the playhead vs centered frames (`center=True`, hop 2048), and per-pixel max-in-range vs 1024 stored log bins. The comparison panel's live-curve offset described in its own section was fixed the same day.

**Formant markers:** the same `estimateFormants()` LPC estimator `SpectrogramPanel` uses (`@giamat90/mps-core/spectrum` (`formants.ts`)) also drives this panel, fed the same time-domain buffer captured alongside `freqData` (`AudioEngine.getExerciseTrackSamples()` for a loaded track, or `analyser.getFloatTimeDomainData()` for the live mic — a second call alongside the existing `getFloatFrequencyData()`, no extra `getUserMedia`). Unlike the spectrogram's scrolling tick marks, each detected formant (F1/F2/F3) is drawn as a full-height dashed vertical line at its `freqToX(...)` position plus an `"F{n} {Hz}Hz"` label, one color per slot (`FORMANT_COLORS`) so overlapping formants stay distinguishable; labels stack by slot index (not by x-position) so close-together formants don't overlap each other's text. A `null` estimate (unvoiced/silence) skips that line.

### ShortTermSpectrumComparisonPanel

Song-vs-take spectral envelope comparison in `PracticeRoom`. Overlays up to three curves at the current playhead position, using the shared song/take/live colors from `PianoKeyboard` (`COLOR_SONG`/`COLOR_TAKE`/`COLOR_LIVE`):

- **Song** — precomputed spectral envelope over time (`STSpectrum` in the analysis store, produced by the sidecar `compute_st_spectrum` command on the vocals stem).
- **Take** — per-take envelope computed during `save_take` analysis and persisted on the `Take` (`stSpectrumTimes`/`stSpectrumB64`/`stSpectrumFrames`/`stSpectrumBins`/`stSpectrumMinDb`/`stSpectrumMaxDb` — base64-packed byte matrix). The analysis store aligns take frames to **song time** (shifting by `startPosition`/`audioOffset`) so the two curves compare like-for-like at the playhead.
- **Live** — current mic spectrum while recording/monitoring.

Spectrum frames are coarse (~20 fps) relative to rAF, so the draw loop does a nearest-frame binary search per tick. Uses its **own** dB span of −100…0 dBFS — deliberately decoupled from SpectrogramPanel's −85…−20 display window — to cover the full vocal dynamic range, matching the mic `AnalyserNode`'s widened `minDecibels`/`maxDecibels` (see `stores/player/recording.ts`).

**Smoothing:** the Live/Take curve is passed through `smoothSpectrumLight()` (`src/lib/spectroUtils.ts`, fixed ±2-sample window) before stroking — just enough to take the edge off per-frame jitter without flattening real harmonic peaks. This is deliberately **not** the same smoothing `ShortTermSpectrumPanel` uses for its formant-envelope overlay (`smoothSpectrumEnvelope()`, a much heavier widening 15–40-sample window) — that one is designed to be drawn *on top of* a raw curve to show vocal-tract resonance shape, and using it as a full replacement made the comparison panel's vocal line look "unrealistically smooth," erasing the actual spectral detail. The Song reference curve is left fully raw/unsmoothed on purpose, since it's the precise target the singer is comparing against. `storedCurvePoints()`/`liveCurvePoints()` build a `SpectrumPoint[]` first (rather than stroking per-pixel as the frame is scanned) so the smoothing pass has the whole curve to average over before `strokePoints()` draws it.

**Window + dB scale (2026-10-08):** the stored spectrum is now computed with a **Blackman** window (was `chebwin(at=100)`), the same shape as `src/lib/fft.ts` and Web Audio's `AnalyserNode`, so the song curve here matches Free Exercise's `ShortTermSpectrumPanel` in shape. `N_BINS` went 1024 → 1152 and `ST_SPECTRUM_MIN_BINS` to match purely as a cache-invalidation marker (the bin count carries no other meaning in this change), so previously-stored songs/takes recompute lazily on next load. The live mic curve in this panel is lifted by `WEBAUDIO_TO_DBFS` (`spectroUtils.ts`, ≈ +13.6 dB) so it sits on the same dBFS scale as the stored song/take curves — before this it read ~13.6 dB low. Re-measured on a real stem: median peak-level offset between stored curve and the lifted browser-style FFT is −0.3 dB (was +13.6).
**Frequency-axis fix + shared panel code (2026-10-09):** `storedCurvePoints()` used to read the stored bins in reverse (left edge showed the 20 kHz bin, 30 Hz was at the right; the two only agreed near 775 Hz), so the Song and stored-take curves were mirrored against the live curve and the axis labels since the panel was added (`0895c0a`). It now maps each column to its log-frequency bin range (bin 0 = `F_MIN`, low on the left) and takes the max over that range, like the live curve. To keep this panel and Free Exercise's `ShortTermSpectrumPanel` from drifting apart again they now share `analyserCurvePoints()`, `SPECTRUM_MIN_DB/MAX_DB` and `SPECTRUM_BOTTOM_AXIS_H` (`spectroUtils.ts`): same dB span, same 16px bottom Hz-label strip, same live-curve builder. `getMicAnalyser()` now sets `smoothingTimeConstant = 0.15` once at creation (it was set by `SpectrogramPanel` at draw time, so Practice Room, which has no spectrogram, ran at Web Audio's default 0.8). Free Exercise's loaded-track snapshot (`AudioEngine.getExerciseTrackSamples(size, true)`) now matches the stored frames' framing: window centered on the playhead and channels averaged to mono, like `librosa.stft(center=True)` on `mono=True` audio, instead of trailing the playhead on channel 0. Still different by design: Free Exercise adds the heavy formant-envelope overlay, formant lines and gradient fill; Practice Room draws the Song curve raw and the live/take curves lightly smoothed.
**Formant lines (2026-10-09):** like Free Exercise, the panel draws dashed vertical F1/F2/F3 lines with `F1 520`-style labels from the shared LPC estimator (`lib/formants.ts`, ~0.3 ms per call). Two sets, each in its curve's colour: the Song's (blue, labels stacked from the top) from the vocals stem, and the singer's (orange live mic / red take, labels stacked from the bottom). Samples come from `AudioEngine.getTrackSamples("vocals" | "take", 8192)`: a mono window centered on the playhead, using the same song-time to file-time mapping as `_seekVocals`/`_seekTake` (null before the take starts). Song/take estimates are cached per 20 ms of playhead time (the audio window is identical while paused); live mic is estimated every frame from `getFloatTimeDomainData`. Trackers reset when the song/take spectrum changes. Note: after a key transpose the vocals buffer is the pitch-shifted file while the stored spectrum is still the original, so the Song formant lines move with the transpose and the Song curve does not.
**Empty log bins + formant ordering (2026-10-09):** below ~950 Hz a log bin is narrower than the FFT's 5.4 Hz spacing and can contain no FFT bin (94% of stored bins at 30-100 Hz, 66% at 200-480 Hz were empty). They used to stay 0, which drew as a dense "picket fence" in the Song curve while the live curve (nearest-bin fallback) was smooth. `compute_short_term_spectrum` now fills an empty bin from the nearest FFT bin; `N_BINS` 1152 -> 1280 and `ST_SPECTRUM_MIN_BINS` follow purely as the cache-invalidation marker so existing songs/takes recompute once. Also: `estimateFormants` now returns F1 < F2 < F3 (`orderByFrequency`, re-sorting the non-null slots): continuity tracking could leave slots swapped (e.g. F2 3010 Hz above F3 1658 Hz) and smoothing preserved it. Formant labels get a dark outline in both panels, and the top (0 dB) tick label is clamped so it is no longer half clipped. Backfill failures (`compute_st_spectrum` in `commands.rs`: sidecar spawn/not running, send failure, sidecar error, timeout, unexpected message, and the write-back of `analysis.json`) are now each logged with `log::warn!` plus the audio path; before, only the sidecar-error branch was, and the rest returned `None` silently. The backfill is still non-fatal and simply retries on the next open. Known limit: on high sung notes LPC tends to lock onto a harmonic (e.g. F1 = 829 Hz = 2 x G#4) rather than the vocal-tract resonance; sparse harmonics make the estimate unreliable above roughly 400 Hz f0.
**Formant accuracy vs pitch (measured 2026-10-09, synthetic source-filter vowels with known F1-F3, 5 vowels x 3 seeds per pitch, 40 dB SNR, 8192-sample window; harness was a scratch script, not in the repo):** production LPC (order 14 @ 12 kHz) is reliable up to f0 ~250 Hz (F2/F3 within 10% in ~100% of frames) and breaks down from ~300 Hz: F3 mean error 696 Hz at 300 Hz and F2/F3 off by 400-700 Hz or missing at 500-800 Hz; F1 is only within 10% in 20-60% of frames at any pitch. Lowering the LPC order makes it worse (order 8/10 lose F3 entirely). Fitting LPC to a harmonic-interpolated envelope (peak amplitude of each harmonic k*f0, linear dB interpolation between them, autocorrelation from that spectrum, f0 estimated from the spectrum by subharmonic summation - identical to using the true f0) extends the reliable range to ~300 Hz (F3 error at 300 Hz: 35 Hz vs 696 Hz) and halves F1 error at 350-500 Hz, but nothing tested recovers F2/F3 above ~350 Hz: the envelope is only sampled every f0 Hz, wider than the resonances, so it is under-determined, not a tuning problem. Picking local maxima of the harmonic amplitudes as "formants" is worse than LPC everywhere. Caveat: synthetic voices only (clean, fixed F4, no vibrato/reverb/stem bleed).
**Harmonic-envelope formant estimator (shipped 2026-10-09):** `estimateFormants` now first calls `analyseHarmonics` (`@giamat90/mps-core/spectrum` (`harmonicEnvelope.ts`)): Blackman FFT -> f0 by subharmonic summation (70-1100 Hz; the f/2 octave candidate is accepted only if its odd harmonics are real peaks) -> voicing check (several harmonics must stand >= 3x above the valley between them; white noise never does) -> f0 refined by a least-squares fit through the strongest harmonic peaks -> one level per harmonic k*f0 up to 5.2 kHz (capped at 0.9 x Nyquist). `envelopeAutocorrelation` then draws the dB-linear envelope through those points, applies the pre-emphasis weighting and returns lags 0..14, which feed the unchanged Levinson-Durbin -> Durand-Kerner -> candidate filter -> `orderByFrequency` -> continuity tracking chain. If no harmonic structure is found (silence, noise, unvoiced, < 1024 samples, f0 outside range, < 4 harmonics) it falls back to the previous plain-LPC path, so nothing regresses. Signature of `estimateFormants` is unchanged (both panels untouched). Measured on real vocals (Let It Go stem, 444 frames every 0.4 s, 364 with harmonics): share of reported formants lying within 3% of f0 of a harmonic (random ~6%) fell from 25% to 14% at f0 350-500 Hz, 47% to 11% above 500 Hz, 12% to 8% at 250-350 Hz; cost 1.3 ms/frame (was 0.2); ~18% of frames take the fallback. Residual ~14% at 350-500 Hz is expected: trained singers tune F1 to a harmonic. Not done: gating/hiding F2/F3 above ~330 Hz (they remain under-determined there).
**F0 line in both Short-Term Spectrum panels (2026-10-14):** both panels draw a **solid** F0 line next to the dashed F1-F3 lines, with an `F0 173Hz F3` label (practice room: `F0 173 F3`). Where it comes from depends on whether a reference exists:
- **Song and Take (practice room), loaded track (Free Exercise): the stored SRH pitch** at the playhead (`referenceF0()` / `windowPitchHz()` in `src/audio/analysisUtils.ts`: the **median of the voiced points within +-120 ms**, i.e. what the spectrum window actually contains, with **no confidence floor**). So the line and its note name agree with the piano roll's pitch, and it bridges the short gaps between voiced frames. It deliberately does not use the piano roll's `confidence >= 0.3` rule (`currentPitchHz`, still used by the keyboard readout): SRH's confidence is normalised to the loudest frame, so a quieter but plainly voiced stretch sits under it. On one real take 25% of the voiced frames did, and the take's F0 line was missing exactly where the spectrum showed a clear 415 Hz voice (coverage of that take 71% -> 90%); the median keeps a lone octave-jump frame from moving the line. A genuinely unvoiced moment shows no line; the estimate below only stands in when a track has no pitch data at all. Stored pitch is in the original key, like the stored curve: after a transpose the line matches the curve's harmonics, not the pitch-shifted formant lines.
- **Live mic (both panels), and the fallback: a measurement.** `estimateVoice()` (`@giamat90/mps-core/spectrum` (`formants.ts`)) returns `VoiceEstimate = FormantEstimate & { f0 }` from one `analyseHarmonics` pass, then `refineF0()` (`src/lib/pitchRefine.ts`) refines that f0 with the normalised autocorrelation (NSDF, McLeod) of the same 8192-sample window over lags within 6% of the seed's period, parabolic interpolation, clarity >= 0.6 (below it the unrefined harmonic f0 is kept). `f0` is null when the frame is not clearly pitched (silence, noise, unvoiced, < 4 harmonics, outside 70-1100 Hz). `estimateFormants` is a thin wrapper that drops `f0` and skips the refinement (`{ refine: false }`, which costs ~0.3 ms on top of the ~1.3 ms formant estimate), so the spectrogram, its tests and its per-frame budget are unchanged.

*Why not the harmonic estimate alone (measured 2026-10-14 against the stored SRH of two real songs, 626 and 1160 voiced frames):* an 8192-point FFT bin is ~5.4 Hz (~54 cents at 173 Hz), and the k^2-weighted fit through the harmonics smears under vibrato and glide: median 8 cents flat on one song, 45% of voiced frames within 25 cents of SRH, +-2 Hz frame-to-frame jitter. On the reported frame it read 169 Hz (labelled E3) where the singer was on F3 (SRH 173.4 Hz, confirmed by ear). With the NSDF refinement the median bias is 2 cents and 54% / 73% of voiced frames are within 25 cents (the remaining disagreement is where the pitch moves: a 93-186 ms window and a smoothed time-localised track are different measurements, so only the stored pitch can match the piano roll exactly). The old test tolerance (2%, 34 cents) was too loose to catch it; `estimateVoice` f0 is now tested within 1%.

Label slots are fixed (F0, F1, F2, F3 from the anchor edge), so a label does not jump when the one above it comes and goes. With "Show multiple lines" on, the practice-room panel also draws the **second voice's F0** (stored `songPitchAlt` at the playhead, no estimate fallback) as a solid line in `COLOR_SONG_ALT` in a fifth slot below F3; the main line follows the piano roll's "Main line" choice. The mic overlay on a loaded Free Exercise track still gets no markers. This reverses the 2026-10-09 "no F0 marker" decision at the user's request. `SpectrumSource.getFormants` and `SpectrumMessage.formants` keep their names but carry `f0` too (`FormantsPayload.f0`, validated by `isSpectrumMessage`); only the live entry's f0 is used by the panel for the singer, the song/take ones are the fallback.
**Song and take curves measured from the audio (2026-10-15):** the practice-room panel no longer draws the Song and stored-take curves only from the precomputed `stSpectrum*` frames. `SpectrumSource.getTrackSpectrum("song" | "take", timeKey)` FFTs the window at the playhead (`getTrackSamples`, mono, centred, `computeMagnitudeSpectrumDb` = the analyser's window and dB scale), cached per 20 ms of playhead like the formants, and the panel maps it to pixels with `analyserCurvePoints()` exactly as it does the live mic. **The engine's decoded buffers are 8 kHz** (WaveSurfer's default decode `sampleRate: 8000`; the engine does not override it), so: (1) the FFT size follows the sample rate to keep the analyser's ~186 ms (`spectrumFftSize()`: 8192 at 44.1/48 kHz, 2048 = 256 ms and 3.9 Hz bins at 8 kHz); 8192 samples at 8 kHz is a full second and measured 2-5 dB off the stored levels, 2048 is within 0.5 dB; (2) a measured curve has nothing above the buffer's Nyquist (4 kHz), so `stitchAboveNyquist()` (`spectroUtils.ts`) takes the stored frame from 0.9 x Nyquist (3.6 kHz, clear of the resampler's roll-off) upwards. The stored frame is also the whole fallback when there is nothing to measure (no decoded audio yet, playhead before the take). Why: the stored path goes FFT -> 1280 log bins (nearest FFT bin below ~950 Hz, max-pool above) -> 8 bit -> max over 1-2 stored bins per pixel, a second max-pool, snapped to a 46 ms hop. Measured on a real stem (resampled to 8 kHz): median level within 0.5 dB, pixel curves ~3-4 dB RMS apart, ~2x the distinct levels in 100-1000 Hz (84-100 -> 160-176). Side effects, all wanted: the Song curve follows a key transpose like its formant and F0 lines, and sits on the exact playhead. The detached window gets the same curves through `SpectrumMessage.tracks` (`song` / `take`, one byte per bin like `live`; the feed measures the song only when it has a stored spectrum and the take only while not listening, and sends again only when the encoded bins change). Cost: up to two small FFTs per repaint while the playhead moves. **Known, not changed:** `getTrackSamples(track, 8192)` also feeds the song/take formant and fallback-F0 estimates, so on 8 kHz buffers those use a ~1 s window (the live mic's is 186 ms); the song/take F0 line itself comes from stored pitch and is unaffected.
**Tests:** `npm test` (vitest, `src/lib/*.test.ts`, synthetic vowels with known formants from mps-core's `src/spectrum/__fixtures__/synthVowel.ts`; the formant, FFT and harmonic tests now run in mps-core) covers f0 accuracy 110-880 Hz, formant accuracy thresholds taken from the pre-implementation experiment, ordering/finite/no-throw invariants, silence/noise/short-buffer fallback, 48 kHz, an 8 kHz Nyquist case and a per-frame time budget. Runs in CI with the rest of the suite; see [Testing](testing.md).

**Resolution (`stSpectrumBins`):** the sidecar's `compute_short_term_spectrum` (`processor.py`) encodes `N_BINS = 1280` log-spaced bins (1024 originally; 1152 and 1280 are pure cache-invalidation bumps, see below) (`fft_size = 8192`, matching Free Exercise's live FFT panels) — raised from an original `128`/`4096`, which produced a visibly stepped "staircase" polyline once stretched across a ~1000px-wide panel (128 bins is coarser than most of the panel's own pixel width, especially at low frequency where log-spaced bins are widest). `stSpectrumBins` doubles as a version marker the same way `stSpectrumMinDb`/`MaxDb` already did: `commands.rs`'s `ST_SPECTRUM_MIN_BINS` backfill check in `load_analysis`/`list_takes` transparently recomputes any cached blob below that threshold rather than leaving previously-analyzed songs/takes stuck at the old resolution. The frontend point-builders (`storedCurvePoints`/`liveCurvePoints`) are bin-count-agnostic (they loop over `frame.length`), so no frontend change was needed to pick up the higher resolution. Trade-off: a full-song blob at 1024 bins is roughly 8x the base64 size of the old 128-bin encoding (~4MB vs ~550KB raw for a 3-minute song) — a 4096-bin (full parity with the live FFT bin count) option was considered and rejected as a ~32x increase for diminishing visual benefit past the panel's actual pixel width.

### DualTuner

Real-time pitch gauge. Active whenever `isRecording || (isMonitoring && isPlaying)` — monitoring alone isn't enough; the track must also be playing. While monitoring but paused, `currentTime` is frozen, so an active detector would keep appending points at that single time instead of tracing a moving pitch line. `isRecording` always implies `isPlaying` (see `stores/player/recording.ts`), so this only changes behavior for the monitor-only case.

**Form factor:** Thin SVG horizontal bar (`viewBox="0 0 300 8"`, `preserveAspectRatio="none"`) — stretches to full container width. No note labels, no ticks — pure color zones only. Range: ±50 cents. Zones: green ±0–15 ct, yellow ±15–30 ct, red >±30 ct. Needle is a 3 px rect; centre mark at x=150.

**Placement:**
- `PianoKeyboard` owns and renders `<DualTuner />` between its header strip and the canvas key row. `PianoKeyboard` is used by **both** ExercisePage and PracticeRoom's analysis panel, so the tuner appears in both — in PracticeRoom it compares the live mic against the song/piano pitch at the playhead (`songPitch` via `pitchAtTime`), which is exactly the "am I in tune with the piano" readout for instrument practice tracks.

**Stream model:** DualTuner never opens its own `getUserMedia`. It reuses the already-open stream owned by the store:

| Active state | Stream source |
|---|---|
| `isMonitoring` | `getMonitorStream()` — opened by `startMonitoring()` |
| `isRecording` | `getRecorderStream()` — opened by `rec.init()` in `startRecording` / `startExerciseRecording` |

Opening a second `getUserMedia` to the same device caused silent failures on Windows WASAPI (exclusive-mode endpoints reject a second client). By reusing the existing stream there is no device conflict and no extra permission prompt.

**Pitch detection:** A `PitchDetector` (autocorrelation, 2048-sample FFT) is created on each activation, connects the stream to a Web Audio `AnalyserNode`, and runs a `requestAnimationFrame` loop calling `getCurrentPitch()`. Detected frequencies are pushed into `livePitch[]` in the analysis store and shown on the needle gauge. On deactivation (recording/monitoring stops, *or* playback pauses while only monitoring), the `AudioContext` is closed and DualTuner's own effect also calls `clearLivePitch()` — but that only fires if DualTuner stays mounted through the transition. The authoritative clears live in `stores/player.ts`:
- `startMonitoring`/`stopMonitoring`/`startRecording` call `clearLivePitch()` directly, so the trace is wiped even when the analysis panel (and DualTuner with it) unmounts in the same render that stops monitoring.
- A `usePlayerStore.subscribe()` clears `livePitch` on every `isPlaying: true → false` transition while `isMonitoring` is true, regardless of which pause/stop call site triggered it — so a paused (not stopped) monitor session doesn't leave a frozen-time smear even if DualTuner is unmounted at that instant.

Don't rely on DualTuner's own effect for correctness — it's a UI-reactivity convenience for while it's mounted, not the source of truth. The underlying media stream is **not** stopped by DualTuner (it is owned externally).

### PianoKeyboard

Horizontal piano key strip showing the currently playing note highlighted in the matching color (song=blue, take=red, live=orange). All white keys show a full note label with octave number at the bottom of each key: `C3`, `D3`, `E3`, `F3`, `G3`, `A3`, `B3`, `C4`, `D4` … The octave is derived as `Math.floor(midi / 12) - 1` (MIDI convention).

**Sliding window:** shares the same `PIANO_WINDOW_SIZE`/`computePianoWindowTarget`/`stepPianoWindow` helpers as `PianoRoll` (see that section and [constants.ts](../src/lib/constants.ts)) to follow the active pitch across the full C0–C7 range, via its own `windowMinRef` — the two components' windows aren't shared state and can drift slightly out of sync, which isn't visually noticeable. Unlike `PianoRoll`'s continuous pixel-level scroll, `buildLayout()` here rounds the smoothed `midiMin` to the nearest semitone before laying out keys, so the keyboard image shifts key-by-key rather than scrolling fractionally — a discrete white/black key strip reads more naturally snapping to whole keys than sliding continuously.

**Redraw loop gating:** the rAF tick loop only runs while `isLoaded || exerciseMode` — mirroring `PianoRoll`'s gate (see that section's `isLoaded`/`exerciseMode` dependency). `isLoaded` is set only by `loadSongAnalysis` (`PracticeRoom`'s flow), so without the `exerciseMode` fallback the keyboard never redraws after `usePlayerStore`'s `startExercise()` sets `exerciseMode: true` in `ExercisePage` — it would draw once on mount and then freeze, never reflecting a loaded exercise track's or the live mic's detected pitch. `PianoRoll` already had this fallback; `PianoKeyboard` needed the same fix.

**Click-to-preview:** same feature as [PianoRoll's piano strip](#pianoroll) — clicking or dragging across keys plays a sustained tone via `startPreviewNote()` from `src/audio/notePreview.ts`, sustaining while held and releasing on mouseup/mouseleave/key-change. Hit-testing here is `midiFromLayout()`, an x-position lookup against the `KeyLayout` map `buildLayout()` already produces each frame (black keys checked first, matching `drawKeyboard`'s black-drawn-on-top z-order) — read from a `layoutRef` snapshot taken at the end of each draw call rather than recomputed per click, so it's pixel-exact with what's on screen despite the sliding window. Disabled during recording. The currently-held key gets the same `COLOR_PREVIEW` overlay treatment as the `PianoRoll` strip.

**Pitch readout:** a `"{note} {Hz}Hz"` label per active source (song/take/live, same priority/colors as the key highlight) is drawn top-right each frame, averaging raw Hz directly across nearby pitch points (not derived from the rounded MIDI key) so it reflects the actual detected frequency rather than snapping to the nearest semitone. Unlike `PianoRoll`'s note label — which sits in empty lane space above the ribbon — this readout draws directly over the key strip, so each label gets a small translucent backing chip (`rgba(15,15,30,0.78)`) for contrast against light/colored keys underneath.

### PracticeRoom

Song practice page. Requires a processed song.

**Layout:**
```
┌─ practice-room__header ───────────────────────────────┐
│  ← Back   Song Title   BPM / Key                      │
├─ practice-room__topbar (pinned with the header) ──────┤
│  TransportControls (skip · Stop · Play · ⏺ Record) ·  │
│  TempoControl · [Input · 🎧 Monitor · Output] ·        │
│  KeyTranspose                                          │
├─ practice-room__body → practice-room__main (one column)┤
│  Waveform (vocals + instrumental + take,              │
│            mute/solo/volume per track row)            │
│  then the optional panels, one `sortable-panel` slot  │
│  each, in the user's order (default as listed):       │
│    LyricsPanel         (`lyrics`, non-instrument)     │
│    TakeList            (`takes`, slot class           │
│                         `practice-room__takes`)       │
│    PitchMonitorPanel   (`pianoRoll`)*                 │
│    ShortTermSpectrumComparisonPanel (`spectrum`)*     │
│    DynamicsCurve       (`dynamics`)*                  │
│    VibratoCard · TimingChart · CoachPanel             │
│    (`vibrato`, `timing`, `coach`)                     │
│  * only once isAnalysisLoaded                         │
└───────────────────────────────────────────────────────┘
```

**Topbar cards (2026-10-24).** The bar is one wrapping list of five `topbar-section` cards in the user's order: Transport | Loop (`LoopButton`, `LoopsMenu`) | Tempo | Input and output (`MicSelector`, `MonitorButton`, `OutputSelector`) | Transpose (`KeyTranspose`). Each is a card (`--bg-secondary`, like the transport's), never splits across lines, and has a ⋮⋮ grip (`SortableTopbar`) that drags it anywhere in the bar (shared `useSortableBar`, modifier `withinBar` keeps it inside the bar), with the arrow keys once the grip has focus; double-clicking a grip restores the usual order. A **Cards** menu next to Panels hides and restores cards (`PanelMenu` with `labels`). Store `vps_topbar` (`stores/topbar.ts`); it is separate from the panels' vertical drag (`SortablePanels`, `vps_panels`): other context, store, grip, menu. Pinned by `PracticeRoom.test.ts`, `SortableTopbar.test.ts`, `stores/topbar.test.ts`. The paragraph below describes the bar's pinning and still holds; its rows are now whatever the width makes of the cards.

**Topbar:** `practice-room__topbar` sits between the header and the body — above `practice-room__main` — and consolidates every transport/recording control that used to be split across a controls row and a transport row inside the scrollable main column: `TransportControls` (skip/stop/play/record/time), `TempoControl`, the input strip (Input, `MonitorButton`, Output, in a row in `practice-room__io-group`) and `KeyTranspose`. It's `position: sticky; top: 0` so it stays visible while the column below it scrolls — though in practice `.practice-room` itself doesn't scroll (only `practice-room__main` does), so the sticky rule is a safety net rather than load-bearing.

**Layout:** one vertical column (`practice-room__main`) with no side widgets. **The page is the one scroll region** (2026-10-24): `.practice-room` is `overflow-y: auto` with no top padding, its children never shrink, and no section has a scroll box or height cap of its own (the takes slot used to be capped at `16rem`). The header and the topbar are wrapped in `practice-room__pinned` (`position: sticky; top: 0`), so the title, Panels menu and export buttons stay with the transport while the rest scrolls under them. Inside it the topbar is compact: speed, BPM and × on one row beside the transport, and input, monitor, output and transpose on a second row (Record is in the transport on the first), about a quarter of the window height. Plain wheel over a waveform scrolls the page; ctrl+wheel zooms and shift+wheel pans (those two call `preventDefault`, nothing else does). Free Exercise scrolls the same way: `.exercise-page` scrolls, its header is sticky at the top and the record/import bar sticky at the bottom. The column holds: the waveforms, then every optional panel in the order the user chose (see "Panel order" below; default lyrics, takes, piano roll, spectrum, dynamics, vibrato, timing, coach). A panel that is hidden, detached or not yet possible is not rendered, so hiding a panel always gives its space back. The old `practice-room__analysis` and `practice-room__feedback` groups no longer exist: any panel can sit between any others. The `min-height: 0` chain must be present at every ancestor (`html/body/#root → .app → .practice-room → .practice-room__body → .practice-room__main`) for the scroll to engage.

**Analysis panel:** Visible when `isAnalysisLoaded` is true and either `showAnalysis` is toggled on, `isRecording`, or `isMonitoring`. `showAnalysis` is set automatically when the user selects a take, **and on mount for `kind: "instrument"` songs** — an instrument practice track exists to be pitched against, so its piano-pitch ribbon + Pitch Monitor open without waiting for a take, and the tab drops the "(select take)" hint. `PianoKeyboard` renders `<DualTuner />` internally, so the tuner *is* present here (comparing the live mic against the song/piano pitch) — despite older revisions of this note claiming it was ExercisePage-only. For instrument songs the PianoRoll/PitchMonitor legend reads "Piano" instead of "Song".

### VibratoCard

Compact widget showing vibrato Rate (Hz), Depth (cents), and Evenness (%) for the currently selected take. Shown in the feedback group below the analysis block.

Rendered only when `takeVibrato` is non-null in the analysis store. If all values are zero, no vibrato was detected (pitch swings < 10 ct or pattern too irregular).

**Info popover (ⓘ button):** A toggle in the card header opens an inline explanation panel below the stats. The panel describes each metric's ideal range (Rate 4–7 Hz, Depth 20–100 ct, Evenness ≥ 60 %) and a note explaining zero output. CSS class: `vibrato-card__info-panel`. State is local to the component (`useState`).

**Color coding:** Each value is highlighted green (`vibrato-card__val--ok`) or amber (`vibrato-card__val--warn`) based on ideal-range thresholds.

### TakeList

The logic (audibility, rename, download, delete) is mps-core's `useTakeList`; the component is markup only. `RecordingOffsetControl` likewise uses `useLatencyCalibration` (output-device routing on).

List of recorded takes for the current song, in `practice-room__takes`. Each row shows the take's display name (`take.name || "Take {n}"`) and the recorded date; clicking a row calls `setActiveTake`. Three icon buttons sit on each row (`take-item__actions`):

- **✎ rename** — or double-click the name itself — swaps the name for an inline `<input>` (local `editingId`/`editValue` state). Enter or blur commits via `renameTake(takeId, name)`; Escape cancels without saving. Trimmed-empty names clear back to the default `"Take N"` label (Rust command `rename_take` stores `None` in that case).
- **↓ download** — calls `exportTake(take.filepath, "{Song Title} - {display name}.wav")`, opening a native Save-As dialog. The take is always exported as WAV: the Rust `export_take` command first sends a `convert_take` request to the Python sidecar (`analysis.py: convert_take_to_wav`, decodes the source webm/opus via `librosa.load` + writes `soundfile.write` — the same backend already used for take analysis, so no new dependency) into a temp file, copies that to the chosen destination, and deletes the temp file (`TempFile` RAII guard). The sidecar mutex guard is dropped in an inner block before the dialog `.await` so the command future stays `Send`. Mirrors the `exportStem` pattern used by `SongCard`. The download button shows `…` and disables itself while the conversion/dialog is in flight.
- **× delete** — calls `deleteTake(take.id)`, which clears `activeTakeId` if the deleted take was active. `PracticeRoom.tsx`'s `activeTakeId` effect reacts to that by calling `useAnalysisStore`'s `clearTakeAnalysis()` — **fixed bug (2026-08-11):** this effect used to just bail out (`if (!activeTakeId) return;`) when the active take was deleted, leaving `takePitch`/`takeOnsets`/`takeDynamics`/`takeVibrato` populated with the deleted take's stale data, so PianoRoll kept drawing its red ribbon indefinitely until a different take was selected. `clearTakeAnalysis()` resets all four fields (plus `takeSTSpectrum`/`timingDeviations`) to empty.

All three buttons call `e.stopPropagation()` so clicking them doesn't also select the take. `Take.name` is persisted in `takes.json` (optional field, omitted when unset) and round-trips through `list_takes`/`save_take`/`rename_take`.

### CoachPanel

Generates coaching tips from pitch deviation, timing deviation, vibrato, and dynamics comparisons (`generateTips`). Tips are hidden by default — a header toggle button (`coach-panel__toggle`, "See Tips (N)" / "Hide Tips") reveals `coach-panel__tips`. State is local (`useState`), so it resets to hidden whenever a new take is selected and the component remounts/rerenders with fresh tips. This keeps the feedback group compact until the user opts in.

### ExercisePage

Standalone practice page — no song required. Used for warming up, vocal exercises, or free improvisation.

**Layout:**
```
┌─ header ──────────────────────────────────────────────┐
│  ← Back   FREE EXERCISE                   00:00       │  ← timer turns red while active or a track is loaded
├─ exercise-page__keyboard (flex-shrink: 0) ────────────┤
│  PianoKeyboard  [DualTuner bar above keys]            │  ← pinned, does not scroll
├─ exercise-page__track-strip ──────────────────────────┤
│  loaded-track WaveSurfer waveform (always rendered,   │  ← real dimensions before load, so
│  so it has real dimensions before loadExerciseTrack)  │    WaveSurfer doesn't size a 0px canvas
├─ ▶/⏸ Play · Unload  (only when a track is loaded) ───┤
├─ exercise-page__analysis (flex: 1, overflow-y: auto) ─┤
│  ┌─ exercise-page__roll ──────────────────────────┐   │
│  │  PianoRoll   (live orange, or loaded-take red) │   │
│  └────────────────────────────────────────────────┘   │
│  ┌─ exercise-page__spectro ───────────────────────┐   │
│  │  SpectrogramPanel  (30 Hz – 20 kHz, + formants)│   │
│  └────────────────────────────────────────────────┘   │
│  ┌─ exercise-page__spectro ───────────────────────┐   │
│  │  ShortTermSpectrumPanel (+ formant lines)      │   │
│  └────────────────────────────────────────────────┘   │
│  ┌─ exercise-page__dynamics ───────────────────────┐   │
│  │  DynamicsCurve                                  │   │
│  └────────────────────────────────────────────────┘   │
│  VibratoCard                                          │
├─ exercise-page__controls ─────────────────────────────┤
│  MicSelector · MonitorButton · ⏺ Record · 📂 Load track…│
├───────────────────────────────────────────────────────┤
│  Recordings (ExerciseTakeList)                        │
└───────────────────────────────────────────────────────┘
```

`exercise-page__keyboard` is `flex-shrink: 0` and sits **outside** the scrollable analysis wrapper — it is always visible regardless of scroll position. `PianoKeyboard` owns and renders the `DualTuner` bar internally (between its header and its canvas key row). The `exercise-page__analysis` wrapper is `flex: 1; overflow-y: auto` so PianoRoll and SpectrogramPanel scroll independently on small screens.

**Time source:** `AudioEngine` exercise timer (`_exerciseMode = true`). `getCurrentTime()` returns `performance.now()` elapsed seconds while live-recording/monitoring, or `exerciseTrack.getCurrentTime()` whenever a track is loaded (see [Free Exercise Track Playback](audio-engine.md#free-exercise-track-playback)) — no changes needed to PianoRoll/DualTuner, which just read through `getEngine().getCurrentTime()` either way.

**Monitor mode:** calls `startMonitoring()` / `stopMonitoring()` from the player store. In exercise mode with no track loaded, `startMonitoring()` also calls `eng.startExerciseTimer()` so `currentTime` advances and the piano roll scrolls while monitoring. `stopMonitoring()` stops the timer again. With a track loaded (`eng.exerciseTrack`), both skip the timer — the track's play/pause drives `isPlaying`/`currentTime` — and loading/unloading a track mid-monitor swaps the clock (`loadExerciseTakeIntoTrack` stops the free timer, `clearLoadedTrack` restarts it). The exercise `onFinish` handler also sets `isPlaying: false` when a loaded track ends, which clears the live trace instead of smearing it at the end time.

**Record mode:** `startExerciseRecording()` opens the mic, applies WASAPI output routing, then calls `eng.startExerciseTimer()`. `stopExerciseRecording()` stops the timer, drains the recorder, calls `save_exercise_take` Tauri command (pitch algorithm decided by the backend, SRH — see [python-sidecar.md#pitch-detection](python-sidecar.md)), and returns the `ExerciseTake`. `ExercisePage` then calls `addExerciseTake(take)` on the exercise store.

**Mutual exclusivity:** Monitor and Record buttons follow the same rules as PracticeRoom — `startRecording` stops monitoring first. Recording and loaded-track playback are mutually exclusive (monitoring is not — see MonitorButton): the Record button is disabled while `loadedTrackId !== null`, and loading a take/importing a file is disabled while `isRecording` — `AudioEngine`'s exercise-mode stopwatch and the `exerciseTrack` playback clock are two different `getCurrentTime()` sources that must never both be "current" at once.

### Free Exercise Track Loading

Clicking a past take in `ExerciseTakeList`, or importing an external file via the "📂 Load track…" button (native file-open dialog filtered to audio extensions, reusing `DropZone`'s exported `AUDIO_EXTENSIONS` list), loads it into `AudioEngine.exerciseTrack` for full post-hoc inspection — synced `PianoRoll` pitch ribbon, `DynamicsCurve`, `VibratoCard`, and the Spectrogram/Short-Term Spectrum panels (including formant ticks), all driven by the loaded track's own already-stored `pitchData`/`dynamics`/`vibrato` (no re-analysis needed for a past take).

`useAnalysisStore.loadExerciseTakeAnalysis(take)` populates `takePitch`/`takeDynamics`/`takeVibrato` directly from the `ExerciseTake` object — unlike `loadTakeAnalysis(take: Take)` (used by `PracticeRoom`), it needs no `startPosition`/`songId` context and computes no `timingDeviations`, since a song-less exercise recording has no reference onsets to compare against.

An imported external file is persisted through the **same** `ExerciseTake` model as a recorded take (new `import_exercise_file` Tauri command: copies the file into `~/.vps/exercises/takes/`, runs it through the sidecar `analyze` command, appends it to `exercises.json`) — no separate data model for "imported" vs. "recorded," `loadedTrackKind` in the exercise store is UX copy only.

**`DynamicsCurve` gating fix:** this component previously gated its rAF loop and "no data" message purely on the song-only `isLoaded` flag, which Free Exercise never sets — it would never have drawn here without adding `exerciseMode` (from the player store) as an alternate gate, mirroring `PianoRoll`'s existing `!isLoaded && !exerciseMode` precedent, and checking `takeDynamics.length === 0` instead of `songDynamics` in exercise mode. `VibratoCard` needed no changes — it already gates purely on `takeVibrato` being non-null.

### ExerciseTakeList

Flat list of recorded exercise takes. Each row shows the recorded date and duration. Clicking an inactive row loads it into the main view (see [Free Exercise Track Loading](#free-exercise-track-loading) above) via `loadExerciseTakeIntoTrack(take, containerEl)`, where `containerEl` is a ref to `ExercisePage`'s shared waveform-strip container (passed down as a prop, so there's one WaveSurfer container reused across list clicks rather than one per row). Clicking the already-loaded row again unloads it via `clearLoadedTrack()`. Disabled (no-op) while recording.

Two icon buttons sit on each row, both `e.stopPropagation()`-guarded so clicking them doesn't also select/load the row:

- **↓ download** (added 2026-08-23) — reuses `TakeList`'s `exportTake(take.filepath, suggestedName)` as-is, no backend change needed: `export_take` only takes a raw file path + suggested name, with no song/take-table dependency, so it works unmodified against an `ExerciseTake`'s `filepath` (already the sidecar's loudness-normalized WAV in the common case — see [Free Exercise Track Loading](#free-exercise-track-loading)). The suggested filename is `"Free Exercise - {date}.wav"`, where `{date}` is built by a local `formatFileLabel` (`YYYY-MM-DD HH-MM`) kept deliberately separate from the row's *display* date string — the display format's `:`/`,` characters are invalid/ugly in a Windows filename. Button disables itself (shows `…`) while the conversion/dialog is in flight, mirroring `TakeList`'s `exportingId` pattern.
- **× delete** — deletes the take; deleting the currently-loaded one also unloads it.

### YouTubeImport

Input + button for pasting a YouTube URL. Validates the URL client-side with a regex before calling `importYoutube(url, highQuality)` on the library store (`highQuality` passed down as a prop from `LibraryPage`). Never disabled by a running import: the link is queued and the box is emptied at once. Errors from the store are shown as a dismissible red banner in `LibraryPage`.

### DropZone

Click-to-browse file picker (native `open()` dialog filtered to audio extensions) that calls `uploadSong(filePath, highQuality, trackKind)` on the library store. Stays usable while an import runs (the file is queued); the progress moved to `ImportQueue`. `highQuality` and `trackKind` are passed down as props from `LibraryPage`.

### ImportQueue

Under the two import controls in `LibraryPage` (`components/upload/ImportQueue.tsx`, CSS `.import-queue*`). Renders nothing when idle. While an import runs: its `processingLabel`, percent, stage and a progress bar from `processing`. Below it the numbered list of waiting imports, each with a × that calls `removeFromQueue(id)`. Plain markup over the store fields, so there is no hook for it in mps-core. When `trackKind === "instrument"` the idle label reads "Upload a practice track" instead of "Upload a song".

**Instrument practice track import:** `LibraryPage` renders a `library-page__track-kind-toggle` radio group above `DropZone` — "Song (separate vocals & instrumental)" vs. "Instrument practice track (piano/guitar melody)" — backed by local `trackKind` state (`"vocal" | "instrument"`, default `"vocal"`). Selecting "instrument" also disables the high-quality checkbox (Demucs quality is irrelevant when separation is skipped) and threads `trackKind` through `uploadSong` → `processSong(filePath, highQuality, trackKind)` → Tauri `process_song(track_kind: Option<String>)` → sidecar `skipSeparation`. See [Data Model: Song.kind](data-model.md#song) and [Python Sidecar: process](python-sidecar.md#process) for the rest of the pipeline.

### SongCard (inline in `LibraryPage`)

Each song in the library list is rendered by a `SongCard` component with local state:

- **Pitch control** — ±6 semitone offset (−/+ buttons + value display + × reset). At 0 the export is direct; at any other value `pitchShiftSong(song.directory, n)` is called first and the shifted WAV paths are passed to `exportStem`. The suggested filename includes the offset, e.g. `Song - Vocals (+3st).wav`.
- **Export buttons** — for `kind: "vocal"` songs (default), "↓ Vocals" and "↓ Instr." trigger `exportStem` via a native Save-As dialog, both disabled and showing `…` while pitch-shifting is in progress. For `kind: "instrument"` songs, a single "↓ Download" button exports the practice track (still via `handleExport("vocals")`, since `vocals.wav` holds the actual audio for instrument-kind songs). Instrument-kind cards also show an "Instrument" badge (`song-card__badge`) next to the title.

## Panel visibility (Panels menu)

The practice room has more on it than anyone wants at once, so everything optional can be shown or hidden from the **Panels** menu in the header (`src/components/panels/PanelMenu.tsx`). The state is `usePracticePanels` in `src/stores/panels.ts`, a `createPanelStore` from `@giamat90/mps-core/panels`, persisted under `vps_panels`.

| Panel id | Shows | Default |
|---|---|---|
| `lyrics` | `LyricsPanel` (never offered for instrument tracks) | on |
| `takes` | `TakeList` | on |
| `pianoRoll` | **Pitch Monitor**: `PitchMonitorPanel` = `PianoKeyboard` with `PianoRoll` under it (one panel, one title button) | on |
| `spectrum` | `ShortTermSpectrumComparisonPanel` | off |
| `dynamics` | `DynamicsCurve` | off |
| `vibrato` | `VibratoCard` | on |
| `timing` | `TimingChart` | off |
| `coach` | `CoachPanel` | on |

Always on: transport, tempo, mic/output, transpose, monitor, record. The waveform area is also not in this list (see "Waveforms and single tracks" below). The Pitch Monitor, spectrum and dynamics only appear once the song analysis has loaded. There is no side column: everything is one vertical stack. The table is the default order.

### Panel order

The user can move any docked panel up or down. Each panel's corner handle (`DetachHandle`) has a **↕ grip** next to the detach grip: drag it to put the panel in another place (or focus it, space to pick up, arrows, space to drop). `SortablePanels` (`src/components/panels/SortablePanels.tsx`, `@dnd-kit/sortable`, already used by the library) wraps each panel in a `sortable-panel` slot and moves nothing in the DOM until the drop. The order is `order` / `move` / `resetOrder` of the panel store (mps-core v0.6.0), persisted next to the visibility choices in `vps_panels`; the Panels menu lists panels in that order, and **Reset** restores default visibility *and* order.
- The order covers every panel, including hidden and detached ones, so a panel docked again returns to its place; a panel added in a later version slots in after its default predecessor.
- The waveform area and the transport are not movable panels: the waveforms stay above the stack, and the transport is in the topbar.
- The detached window has no move grip (`MoveGrip` renders nothing outside `SortablePanels`).
- Not hand-tested in a running app when this was written (vitest has no DOM here); the drag itself is dnd-kit's, the order logic and the page's use of it are tested.

Rules for a panel:
- **A hidden panel is not mounted.** It must be a pure view: nothing may depend on it being on screen. `TakeList` used to fetch the takes on mount; that moved into `loadSong` for exactly this reason. Anything a panel needs to keep running goes in a store or the page, not the panel.
- **Only the user decides.** There is no automatic open/close: the old "Analysis" tab that opened when a take was selected or while recording was removed.
- A panel that is on but has nothing to show (vibrato without a take) still renders nothing, as before.
- Add a panel by adding it to `PRACTICE_PANELS` (its default is a product decision), rendering it behind `visible.<id>` in `PracticeRoom`, and extending `PracticeRoom.test.ts`.
- Known limit: hiding Lyrics while a sync is running unmounts the panel (its cleanup clears the lyrics store). The sync still finishes and is saved; showing the panel again loads the result.
- The piano roll's ruler (in the Pitch Monitor panel) also sets the punch region; with it hidden, use the main timeline ruler.

### Waveforms and single tracks

The waveform area can be hidden as a whole, and the vocals / instrumental waveforms can be shrunk to a strip one by one, as in a DAW. State: `useWaveformPanels` in `src/stores/waveforms.ts` (also `createPanelStore`, persisted under `vps_waveforms`, **not** in `vps_panels`). Ids: `waveforms` (the area), `vocals`, `instrumental`. The Panels menu lists them first: **Waveforms**, with **Vocals** / **Instrumental** (**Melody** only, for an instrument track) indented under it and greyed while the area is off. Each track's header starts with an arrow: **^** shrinks the track to its strip (name, M, S, volume, as in a DAW), **∨** brings the waveform back. The arrow and the menu tick are the same state, so unticking Vocals in the menu also leaves just the strip. The count on the menu button counts the area, not its tracks.

- **Hidden means collapsed, never unmounted.** `Waveform` owns the containers the audio engine draws into (`loadSong`, the take rails), so it always stays mounted. A minimized track gets `waveform__track--collapsed`, which collapses only its `waveform__track-body` (height 0, `visibility: hidden`, a small negative margin) so the header strip stays; a hidden area gets `practice-room__waveforms--collapsed` (everything, strips included). Both keep the box at full width on purpose: WaveSurfer measures its container, and `getMinPxPerSec()` reads the width of the master track. Verified in Chromium that an instance created inside a collapsed lane measures and paints at full width and repaints when shown.
- **Minimizing a waveform does not change what is heard.** Mute, solo and volume are on the strip; a minimized track that is muted or the soloed one also gets a "muted" / "solo" tag in the menu.
- The area stays (ruler and strips) until it is switched off in the menu; with both tracks minimized you keep the ruler, the punch region and the two strips. (The earlier rule that the area vanished when both tracks were hidden is gone.) Take lanes are not tracks of this store: each has its own show/hide (the list, or the × on the lane).
- **Hide all** collapses the area but keeps the user's choice of tracks (they come back with it); **Show all** and **Reset** also expand every track.
- Adding a track: add it to `WAVEFORM_PANELS`, give its lane a `TrackTitle` (the arrow) and the collapsed class, and extend `Waveform.test.ts` and `waveforms.test.ts`.

### Free Exercise page

The Free Exercise page has the same menu (`Panels n/8`), without the move hint. State: `useExercisePanels` in `src/stores/exercisePanels.ts`, persisted under `vps_exercise_panels`, everything on by default. Here the keyboard (menu name **Pitch Monitor**) and the piano roll are two panels, each with its own title button. Ids: `keyboard`, `track`, `pianoRoll`, `spectrogram`, `spectrum`, `dynamics`, `vibrato`, `recordings`. Everything is unmounted when hidden except `track`, the strip a loaded recording is drawn into, which is collapsed in height only (same reason as the waveforms). The analysis area disappears when all five views in it are hidden. These panels are not movable or detachable.

## Folding a panel to its title

Every panel's name is a button, the one the Lyrics panel always had (`PanelTitle`, class `analysis-tab`, lit while the panel is open). Clicking it folds the panel down to that title and opens it again. State: `useCollapsedPanels` in `src/stores/collapsed.ts`, a `createCollapseStore` from `@giamat90/mps-core/panels`, persisted under `vps_collapsed` as the list of folded ids; `usePanelCollapse(id)` is `useCollapsiblePanel` from `@giamat90/mps-core/hooks` bound to it. Panels start open.

- **Keyed by the panel's own id**, not by page, so the practice room, the Free Exercise page and a panel in a window of its own agree (the window re-reads the store when the main window writes). Ids: `pitchMonitor` (the practice room's whole Pitch Monitor panel: its button, on the keyboard, folds the roll with it, and the roll shows a plain "Piano Roll" label), `spectrumComparison` (practice room), `pianoRoll` (Free Exercise only, where the roll is a panel of its own), `shortTermSpectrum`, `spectrogram`, `recordings` (Free Exercise), and `dynamics`, `vibrato`, `timing`, `coach`, `takes` in both. The Lyrics panel keeps its own `open` (closed until it has lyrics).
- **A folded panel is not drawn and does not run.** Canvas panels render their canvas only while open, and their rAF loop and ResizeObserver effects list `open` as a dependency, so folding stops the loop and unfolding re-attaches it to the new canvas (the spectrogram's scrolled history starts again). Everything in the header that belongs to the body goes with it: the legend (Song / Your voice / Live), the spectrum hints, the piano roll's voice controls, the Coaching "See Tips" and the vibrato info button; a folded panel is its title button and nothing else.
- **The button sits outside the card.** Panels whose content is a card (Coaching, Vibrato, Timing) draw the title button above the card in a `panel-bar`, the way the Lyrics button sits above its card; folded, only the button is left. Controls stay in the card. `polish.css` draws the card's outline on `.vibrato-card__body` / `.coach-panel__body`, not on the wrapper, or the outline would enclose the button.
- **A panel that renders nothing leaves no gap.** Vibrato and Timing return `null` without a take; the `.sortable-panel:has(> .detachable > .detach-handle:only-child)` rule hides their slot (the handle was already hidden), otherwise each empty slot adds a row gap to the stack.
- **This is not the Panels menu.** The menu decides whether a panel is mounted at all; folding is the quick way to make one small without losing its place or order. The waveform areas are not folded this way: they own the audio engine's containers and keep their own collapse (MPS rule 15).

## Second voice in the PianoRoll (2026-10-11)

When a song holds two singers at once the sidecar stores the second one as `pitchData.f0Alt` (see `wiki/python-sidecar.md`, "Second voice"). Two controls in the PianoRoll header, both disabled with a tooltip when the song has no second voice, and hidden in Free Exercise:

- **Show multiple lines** (toggle, `aria-pressed`, **off by default**): draws the second singer as a lighter tint of the song blue (`COLOR_SONG_ALT` `rgba(170, 212, 255, 0.82)` vs `COLOR_SONG` `rgba(74, 158, 255, 0.88)`), *under* the main line so it stays readable where they cross. The legend gains a "Second voice" entry while it is on.
- **Main line** (select: Loudest / Higher / Lower, default Loudest): which of two simultaneous voices is *the* line. Applied per frame by `arrangeVoices` (`src/lib/voices.ts`); a frame with one voice is never moved. It is applied in the analysis store, so `songPitch` - and with it the DualTuner, coach tips, keyboard highlight and live-feedback reference - follows the choice, not just the ribbon.

State: `useVoiceViewStore` (`src/stores/voiceView.ts`, localStorage key `vps_voice_view`, `{showMultipleLines, mainVoice}`). It follows `storage` events so a detached piano-roll window and the main window stay in step. `useAnalysisStore` keeps the raw `songPitchData` and re-arranges `songPitch` / `songPitchAlt` when `mainVoice` changes, without reloading the song. Takes have no second voice.

Songs analysed before this get `f0Alt` on their next open through the `load_analysis` backfill (once, persisted); the lead line of such a song may also change, because inside a two-voice stretch it is now held on one voice.

## Panel menu, sortable panels, detach/dock handles, loops menu (headless hooks)

`PanelMenu`, `SortablePanels` (`MoveGrip`), `DetachHandle`, `DockHandle` and `LoopsMenu` keep only markup and CSS class names; their logic is in `@giamat90/mps-core/hooks` (`usePanelMenu`, `usePopover`, `useSortablePanels` / `useSortablePanel` / `usePanelGrip`, `useDetachHandle`, `useDockHandle`, `useLoopsMenu`), which takes the app's stores and IPC functions as parameters.

## Lyrics, import and update components: logic in mps-core hooks

`LyricsPanel`, `YouTubeCookiesControl`, `YouTubeImport`, `DropZone` and `UpdateDialog` keep only markup and CSS class names. Their logic is a headless hook in `@giamat90/mps-core/hooks` (`useLyricsPanel`, `useYouTubeCookies`, `useYouTubeImport`, `useDropZone`, `useUpdateDialog`), shared with the other app; what differs is passed in: the player store adapter, the library action, the import call's arguments (quality, track kind). The native file dialog is injected through `src/lib/pickFile.ts` (the one place that imports `@tauri-apps/plugin-dialog` for these components). The hooks' tests live in mps-core.
