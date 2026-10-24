# VPS: UML architecture

Vocal Practice Studio, drawn from the code at `v0.0.92` (mps-core `v0.14.0`). Thirteen [Mermaid](https://mermaid.js.org/) diagrams; they render on GitHub and in VS Code's Markdown preview. Mermaid has no native UML component or deployment diagram, so those are flowcharts with the UML meaning in the caption.

What is shared with SPS is shown as **mps-core** and not redrawn here: see [Shared core](shared-core.md) and the mps-core diagrams in `core/wiki/uml.md`. The workspace-level picture of both apps is `MPS/wiki/uml-architecture.md`. When code and a diagram disagree, the code wins; fix the diagram.

| # | Diagram | Kind | Question |
|---|---|---|---|
| 1 | Layers and processes | Deployment | What runs, and where does each concern live? |
| 2 | Screens and panels | Component | Which page shows which components, and what makes a panel movable? |
| 3 | Domain model | Class | What is a Song, a Take, a Folder, and what is stored per take? |
| 4 | Data on disk | Component | Which files hold which part of the model? |
| 5 | Player store | Class | How is the player state split into slices? |
| 6 | AudioEngine | Class | What does the fixed vocals / instrumental / takes engine own? |
| 7 | Live analysis chain | Component | How does the microphone become pitch, spectrum and coaching? |
| 8 | Rust backend | Class | Which modules make up the Tauri shell, and who calls the sidecar? |
| 9 | Python sidecar | Component | Which commands exist and which module serves each? |
| 10 | Process a song | Sequence | From the import click to a song in the library. |
| 11 | Record a take | Sequence | Count-in, recording, analysis, and the take in the list. |
| 12 | Recording states | State | The flags in the recording slice as a state machine. |
| 13 | Send to phone | Sequence | The LAN hand-off of a practice pack to VPP. |

---

## 1. Layers and processes (deployment view)

VPS is the app with the **analysis** concern: pitch, vibrato, dynamics, timing, spectrum and spectrogram. Heavy analysis runs in the Python sidecar; live feedback runs in the WebView.

```mermaid
flowchart LR
    subgraph machine["User machine"]
        subgraph tauri["VPS process (Tauri v2)"]
            subgraph web["WebView2 (React 19, Zustand, WaveSurfer)"]
                PAGES["pages: Library, PracticeRoom, Exercise"]
                STORES["stores: player slices, library, analysis, panels ..."]
                ENGINE["AudioEngine + mic analysers<br/>(Web Audio)"]
                IPCG["ipc.generated.ts"]
            end
            subgraph rust["Rust shell"]
                CMDS["commands.rs + pack_share, windows,<br/>youtube_signin (46 registered commands)"]
                LIB["library.rs, storage.rs, lyrics.rs"]
                PACK["pack_share.rs (LAN server)"]
                WIN["windows.rs, youtube_signin.rs"]
                SIDE["sidecar.rs (wrapper)"]
            end
        end
        SC["Python sidecar (PyInstaller)<br/>Demucs, librosa, SRH pitch, yt-dlp"]
        DATA[("~/.vps<br/>library.json, songs, takes, exercises")]
    end
    PHONE["VPP phone (Wi-Fi)"]
    NET["YouTube, lyrics sources, GitHub updater"]

    PAGES --> STORES --> IPCG
    STORES --> ENGINE
    IPCG -- "invoke()" --> CMDS
    CMDS --> LIB --> DATA
    CMDS --> SIDE
    SIDE -- "JSON lines" --> SC
    SC --> DATA
    PACK -- "HTTP, one-time token" --> PHONE
    CMDS --> PACK
    SC --> NET
    web -- "updater" --> NET
```

## 2. Screens and panels (component view)

`App.tsx` holds a three-way route in state (no router). The practice room is a stack of **panels**; each panel id is in a panel store (visibility and order, persisted), and the ones in `DetachablePanel` can also leave the window.

```mermaid
flowchart TB
    APP["App.tsx<br/>route: library | practice songId | exercise"]
    APP --> LP["LibraryPage<br/>folders, songs, import, search"]
    APP --> PR["PracticeRoom<br/>one song"]
    APP --> EP["ExercisePage<br/>free singing, no song"]
    APP --> UD["UpdateDialog"]

    subgraph pr["PracticeRoom"]
        direction TB
        TOP["Transport: TransportControls, TempoControl, KeyTranspose,<br/>LoopButton, LoopsMenu, OutputSelector, Export / Send buttons"]
        WF["Waveform (vocals, instrumental)"]
        REC["Recording: RecordButton, MonitorButton, MicSelector"]
        SP["SortablePanels (drag to reorder)"]
    end
    PR --> pr
    PR --> LPFC["LivePitchFeed (mounted in the room, not a panel)"]
    SP --> P1["lyrics: LyricsPanel"]
    SP --> P2["takes: TakeList"]
    SP --> P3["pianoRoll: PianoKeyboard (with DualTuner) + PianoRoll"]
    SP --> P4["spectrum: ShortTermSpectrumComparisonPanel"]
    SP --> P5["dynamics: DynamicsCurve"]
    SP --> P6["vibrato: VibratoCard"]
    SP --> P7["timing: TimingChart"]
    SP --> P8["coach: CoachPanel (rule-based tips)"]

    PM["PanelMenu + usePracticePanels (visibility, order)"]
    DH["DetachHandle / DockHandle -> useDetachedStore -> detach_panel"]
    PM -.-> SP
    DH -.-> SP
    EP --> E1["keyboard, track, pianoRoll, spectrogram, spectrum,<br/>dynamics, vibrato, recordings (useExercisePanels)"]
```

## 3. Domain model (class view)

TypeScript types are in `src/lib/types.ts`; the Rust twins are in `library.rs` and `commands.rs` (camelCase over the wire). Analysis results of a take are stored as JSON blobs inside the take.

```mermaid
classDiagram
    direction LR
    class Folder {
        +id
        +name
        +sortIndex
    }
    class Song {
        +id
        +title
        +artist
        +duration
        +detectedKey
        +detectedBpm
        +kind : vocal or instrument
        +directory
        +metronomeOffset
        +folderId
        +sortIndex
        +officialTitle
        +officialArtist
        +processedAt
    }
    class NamedLoop {
        +id
        +name
        +start
        +end
    }
    class Take {
        +id
        +songId
        +recordedAt
        +filepath
        +name
        +startPosition
        +audioOffset
        +manualOffset
        +onsets
        +stSpectrum* (times, b64, frames, bins, min/max dB)
    }
    class PitchData {
        parallel arrays from the sidecar
        +times
        +f0 (Hz, 0 when unvoiced)
        +voiced
        +confidence
        +f0Alt (second voice, optional)
    }
    class PitchPoint {
        frontend-internal view of PitchData
        +time
        +frequency
        +confidence
    }
    class DynamicsPoint {
        +time
        +rms
    }
    class VibratoMetrics {
        +rate
        +depth
        +regularity
    }
    class Lyrics {
        +version
        +source
        +aligner
        +meanScore
        +warning
        +lines : LyricLine list
    }
    class LyricLine {
        +text
        +start
        +end
        +score
        +words : LyricWord list
    }
    class ExerciseTake {
        +id
        +recordedAt
        +filepath
        +duration
    }
    class TimingDeviation {
        +noteIndex
        +referenceTime
        +userTime
        +deltaMs
    }

    Folder "1" o-- "0..*" Song : folderId
    Song "1" *-- "0..*" NamedLoop : loops
    Song "1" *-- "0..*" Take : takes.json
    Song "1" o-- "0..1" Lyrics : lyrics.json
    Take "1" *-- "0..1" PitchData
    Take "1" *-- "0..*" DynamicsPoint
    Take "1" *-- "0..1" VibratoMetrics
    PitchData ..> PitchPoint : converted on load
    Lyrics "1" *-- "1..*" LyricLine
    ExerciseTake "1" *-- "0..1" PitchData
    ExerciseTake "1" *-- "0..*" DynamicsPoint
    ExerciseTake "1" *-- "0..1" VibratoMetrics
    Take ..> TimingDeviation : computed client-side
```

## 4. Data on disk (component view)

`~/.vps` (see `storage.rs`). The Rust shell is the only writer of the JSON files; the sidecar writes audio and analysis next to them.

```mermaid
flowchart TB
    ROOT["~/.vps"]
    ROOT --> LJ["library.json<br/>songs + folders (library.rs)"]
    ROOT --> SD["library/ID/ (one folder per song)"]
    ROOT --> EX["exercises/<br/>exercises.json + takes/ID.webm"]
    ROOT --> YC["youtube_cookies.txt (in-app sign-in)"]
    ROOT --> MD["models/ (lyrics-sync model, downloaded on first use)"]
    SD --> V["vocals.wav"]
    SD --> I["instrumental.wav"]
    SD --> A["analysis.json<br/>pitch, onsets, dynamics, short-term spectrum"]
    SD --> LY["lyrics.json"]
    SD --> TJ["takes.json (list of Take)"]
    SD --> TD["takes/ID.wav (RMS-normalised take audio)"]
    SD --> SRC["original file copy"]
    SD --> CA["pitched/N/ (pitch-shifted WAV cache)"]
    LJ -. "Song.directory" .-> SD
    TJ -. "Take.filepath" .-> TD
```

## 5. Player store (class view)

`usePlayerStore` is one Zustand store composed from nine slice creators (`src/stores/player/`). Slices are plain functions that share `get`/`set`; non-reactive objects (engine, recorder, timers) live in `singletons.ts`, not in state.

```mermaid
classDiagram
    direction TB
    class PlayerStore {
        <<usePlayerStore>>
    }
    class SongSlice {
        song, duration, transpose, isTransposing
        loadSong() cleanup() setTranspose()
    }
    class TransportSlice {
        isPlaying, currentTime, playbackRate
        loopStart, loopEnd, isLooping
        play() pause() seek() setPlaybackRate() toggleLoop()
    }
    class MixerSlice {
        vocalsVolume, instrumentalVolume, takeVolume
        mutedTracks, soloedTrack
        toggleMute() toggleSolo()
    }
    class TimelineSlice {
        minPxPerSec, scrollTime, metronomeOffset
        setZoom() setScrollTime()
    }
    class PunchSlice {
        punchIn, punchOut, punchLoop
        saveLoop() renameLoop() deleteLoop() applyLoopRegion()
    }
    class DevicesSlice {
        audioDevices, selectedDeviceId
        outputDevices, selectedOutputDeviceId
        recordingOffsets, usedLatencyFallback
        applyCalibration()
    }
    class TakesSlice {
        takes, shownTakeIds, activeTakeId
        takePlayback, mutedTakeIds, soloedTakeId, takeGains
        fetchTakes() deleteTake() renameTake() setTakeGain()
    }
    class RecordingSlice {
        isRecording, isSavingTake, isMonitoring
        countInBars, isCountingIn
        startRecording() stopRecording() startMonitoring()
    }
    class ExerciseSlice {
        exerciseMode
        startExercise() startExerciseRecording() stopExerciseRecording()
    }
    class Singletons {
        <<singletons.ts>>
        engine : AudioEngine
        recorder : VocalRecorder (core)
        session, mic analyser
    }
    class AudioSync {
        <<audioSync.ts>>
        installAudioSync()
        store subscriptions keep engine and analysis in step
    }
    class Persistence {
        <<persistence.ts>>
        localStorage: take prefs, recording offsets
    }

    PlayerStore *-- SongSlice
    PlayerStore *-- TransportSlice
    PlayerStore *-- MixerSlice
    PlayerStore *-- TimelineSlice
    PlayerStore *-- PunchSlice
    PlayerStore *-- DevicesSlice
    PlayerStore *-- TakesSlice
    PlayerStore *-- RecordingSlice
    PlayerStore *-- ExerciseSlice
    PlayerStore ..> Singletons : reads
    PlayerStore ..> AudioSync : installed once
    DevicesSlice ..> Persistence
    TakesSlice ..> Persistence
```

## 6. AudioEngine (class view)

VPS's shape is a **fixed** set of named tracks: `vocals` and `instrumental` WaveSurfers (the instrumental is master clock) plus a `Map` of take tracks (several loadable, one audible). This is the structural difference from SPS (`Map<string, WaveSurfer>` of stems), so engine features are re-derived, not copied.

```mermaid
classDiagram
    direction LR
    class AudioEngine {
        vocals : WaveSurfer
        instrumental : WaveSurfer (master clock)
        -_takes : Map of id to TakeTrack
        -_activeTakeId
        -_audibleTakeIds
        -_loopStart / _loopEnd
        -_exerciseMode (timer clock, no song)
        +load() play() pause() stop() seekTo()
        +setPlaybackRate() setOutputDevice()
        +loadVocalsFromPath() loadInstrumentalFromPath()
        +loadTakeTrack() removeTakeTrack() setTakeManualOffset()
        +setActiveTakeTrack() setAudibleTakeTracks() setTakeGains()
        +zoomAll() setScrollAll()
        +loadExerciseTrack() playExerciseTrack()
        +getTrackSamples() getExerciseTrackSamples()
        +onTimeUpdate() onFinish() onScrollChange()
        -_startTimeUpdate() rAF tick 60 fps, notify 30 fps
        -_correctDrift() every 250 ms, 50 ms tolerance
    }
    class TakeTrack {
        id
        ws : WaveSurfer
        offset
        audioOffset
        manualOffset
        duration
        container
    }
    class WaveSurfer {
        <<wavesurfer.js>>
        interaction event, not seeking
    }
    AudioEngine *-- "0..*" TakeTrack
    AudioEngine o-- "2..*" WaveSurfer
    TakeTrack o-- WaveSurfer
```

## 7. Live analysis chain (component view)

What the singer sees while singing comes from the browser; what is stored after the take comes from the sidecar. Both use the same stored `Song` pitch as the reference.

```mermaid
flowchart LR
    MIC["Microphone stream<br/>(VocalRecorder, core)"]
    MIC --> PD["pitchDetector.ts<br/>AnalyserNode + autocorrelation (core/pitch)"]
    PD --> LPF["livePitchFeed.ts<br/>pairs live note with song note at the current time"]
    LPF --> AS["analysis store<br/>livePitch, cents deviation"]
    MIC --> SS["spectrumSource.ts<br/>FFT window 8192, formants (core/spectrum)"]
    SS --> UI2["Short-term spectrum and spectrogram panels"]
    AS --> UI1["PianoRoll, PianoKeyboard + DualTuner"]
    VV["voiceView store<br/>showMultipleLines, mainVoice (second voice display)"] --> UI1

    TAKE["Saved take (sidecar analyze)"] --> TP["takePitch, takeDynamics, takeVibrato"]
    SONG["analysis.json (sidecar process)"] --> SPI["songPitch, songSpectrogram"]
    TP --> AU["analysisUtils.ts<br/>avgCentsDeviation, timing deviations"]
    SPI --> AU
    AU --> COACH["CoachPanel generateTips()<br/>rules over pitch, timing, vibrato, dynamics<br/>(no model call)"]
    AU --> UI3["TimingChart, VibratoCard, DynamicsCurve"]
```

## 8. Rust backend (class view)

`commands.rs` is the orchestration point (46 commands are registered in all, the rest in `pack_share.rs`, `windows.rs`, `youtube_signin.rs`); `sidecar.rs` and `windows.rs` are thin wrappers over core crates. `pitch.rs` only decides *which* algorithm the sidecar runs (default `srh`, override `VPS_PITCH_ALGORITHM`).

```mermaid
classDiagram
    direction TB
    class Commands {
        <<commands.rs>>
        process_song import_youtube pitch_shift_song
        save_take list_takes delete_take rename_take
        load_analysis sync_lyrics find_lyrics
        export_stem export_mix export_pack
        save_exercise_take import_exercise_file
        set_song_loops move_songs ...
    }
    class SidecarState {
        Mutex of Option of SidecarManager
    }
    class SidecarWrapper {
        <<sidecar.rs>>
        CONFIG
        Deref to mps_sidecar::SidecarManager
    }
    class Library {
        <<library.rs>>
        Song, Folder, NamedLoop
        library.json read and write
        migrations, ordering
    }
    class Storage {
        <<storage.rs>>
        app_data_dir library_dir song_dir
        exercises_dir
    }
    class LyricsMod {
        <<lyrics.rs>>
        Lyrics LyricLine LyricWord
        FoundLyrics LyricsCandidate
    }
    class Pitch {
        <<pitch.rs>>
        DEFAULT srh
        resolve(override) vocal() for_track()
    }
    class PackShare {
        <<pack_share.rs>>
        ShareState ShareServer
        one-time token, 600 s lifetime
    }
    class WindowsMod {
        <<windows.rs>>
        PANELS PanelSpec table
        detach_panel dock_panel
    }
    class YoutubeSigninMod {
        <<youtube_signin.rs>>
        sign_in_youtube sign_out_youtube
    }
    class CoreCrates {
        <<mps-core Rust>>
        mps-sidecar
        mps-detached-windows
        mps-youtube-signin
    }
    Commands --> SidecarState : locks
    SidecarState o-- SidecarWrapper
    SidecarWrapper ..> CoreCrates
    Commands --> Library
    Commands --> Storage
    Commands --> LyricsMod
    Commands --> Pitch
    PackShare ..> Commands : build_pack_file, SidecarState
    WindowsMod ..> CoreCrates
    YoutubeSigninMod ..> CoreCrates
    Library --> Storage
```

## 9. Python sidecar (component view)

`main.py` reads one JSON line at a time and dispatches on `cmd`. It is deliberately single-threaded. `pitch_lab/` is a research bench (A/B of algorithms), not shipped code.

```mermaid
flowchart TB
    MAIN["main.py<br/>loop: read line, dispatch cmd, send result / progress"]
    MAIN -- "process" --> PROC["processor.py<br/>Demucs separation, pitch (SRH default),<br/>key + BPM, spectrogram, second voice"]
    MAIN -- "pitch_shift" --> PROC
    MAIN -- "compute_st_spectrum<br/>compute_second_voice" --> PROC
    MAIN -- "analyze<br/>convert_take<br/>mix_export" --> AN["analysis.py<br/>take pitch, vibrato, dynamics, onsets,<br/>RMS normalise vs vocals.wav, mix"]
    MAIN -- "build_pack" --> PK["pack_export.py<br/>practice pack for VPP"]
    MAIN -- "import_yt" --> YT["yt_importer.py<br/>yt-dlp, cookie cascade"]
    MAIN -- "align_lyrics<br/>find_lyrics<br/>search_lyrics" --> ML["mps_core.lyrics (core)"]
    MAIN -- "ping / quit" --> CTL["liveness + clean exit"]
    MAIN --> ID["mps_core.app.AppIdentity<br/>mps_core.version_check (yt-dlp floor)"]
    PROC --> VEND["vendor/ (bundled models)"]
    LAB["pitch_lab/<br/>algorithm benchmarks, not shipped"] -.-> PROC
```

## 10. Process a song (sequence view)

```mermaid
sequenceDiagram
    actor U as User
    participant UP as DropZone / YouTubeImport
    participant LS as library store
    participant I as ipc.generated
    participant R as commands.rs
    participant P as processor.py
    participant FS as ~/.vps

    U->>UP: drop file or paste link
    UP->>LS: process(file, kind: vocal or instrument)
    LS->>I: processSong(...)
    I->>R: invoke("process_song")
    R->>R: pitch::for_track(skip_separation)
    R->>P: {"cmd":"process", file, algorithm, ...}
    loop stages
        P-->>R: progress (separate, pitch, key, spectrogram)
        R-->>LS: event "processing-progress"
    end
    P->>FS: vocals.wav, instrumental.wav
    P-->>R: result (pitch, key, bpm, spectrogram)
    R->>FS: analysis.json
    R->>FS: library.json (new Song)
    R-->>LS: Song
    LS-->>U: song appears in the library
```

## 11. Record a take (sequence view)

```mermaid
sequenceDiagram
    actor U as User
    participant RB as RecordButton
    participant RS as RecordingSlice
    participant E as AudioEngine
    participant REC as VocalRecorder (core)
    participant R as save_take (Rust)
    participant P as analysis.py
    participant TS as TakesSlice

    U->>RB: click Record
    RB->>RS: startRecording()
    RS->>REC: init(mic), pin hardware output
    opt count-in bars > 0
        RS->>RS: isCountingIn, metronome clicks
    end
    RS->>E: play from position
    RS->>REC: start()
    Note over RS: isRecording = true, isPlaying = true
    U->>RB: click Stop
    RB->>RS: stopRecording()
    RS->>REC: stop() returns audio bytes
    Note over RS: isRecording = false, isSavingTake = true
    RS->>R: invoke("save_take", bytes, startPosition, audioOffset)
    R->>R: write takes/ID.webm
    R->>P: {"cmd":"analyze", take, vocals.wav as reference}
    P-->>R: pitch, onsets, dynamics, vibrato, spectrum, normalised wav
    R->>R: append Take to takes.json
    R-->>RS: Take
    RS->>TS: take appended, shown and selected
    Note over RS: isSavingTake = false
```

## 12. Recording states (state view)

The four booleans of the recording slice (`isMonitoring`, `isCountingIn`, `isRecording`, `isSavingTake`) behave as one machine; a take is never recorded while another is being saved.

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Monitoring : startMonitoring (mic on, no recording)
    Monitoring --> Idle : stopMonitoring, or startRecording (stops monitoring first)
    Idle --> CountingIn : startRecording, countInBars > 0
    CountingIn --> Idle : cancelCountIn
    CountingIn --> Recording : count-in finished
    Idle --> Recording : startRecording, no count-in
    Recording --> Saving : stopRecording
    Saving --> Idle : take stored, list refreshed
    Saving --> Idle : error reported
```

## 13. Send to phone (sequence view)

```mermaid
sequenceDiagram
    actor U as User
    participant D as SendToPhoneDialog
    participant R as Rust (export_pack, pack_share)
    participant P as pack_export.py
    participant S as ShareServer (LAN)
    actor PH as VPP on the phone

    U->>D: Send to phone
    D->>R: invoke("start_pack_share", songId, address)
    R->>R: choose a private LAN address
    R->>P: {"cmd":"build_pack"} (a pack already built for this dialog is reused)
    P-->>R: pack file (audio variants + reference pitch)
    R->>S: bind that address, make the one-time token
    R-->>D: URL with token
    D-->>U: QR code
    PH->>S: GET /pack/TOKEN
    S-->>PH: pack bytes
    S-->>D: event "pack-share" (sent)
    Note over S: token spent when the transfer completes, server stops after 600 s at most
    Note over D,R: saving the pack as a file uses export_pack instead (native Save As)
```

---

## Keeping this current

- Change the matching diagram in the same commit as a structural change (new slice, command, sidecar `cmd`, module, or on-disk file).
- Names in diagrams are searchable in the code. Drift risks: the slice list (5), the registered-command count (1, 8; `generate_handler!` in `lib.rs`), the sidecar command table (9), `PRACTICE_PANELS` ids (2).
- Every diagram was parsed with Mermaid 11.4.1 (`mermaid.parse`) on 2026-10-18; layout was not viewed. There is no CI check, so re-preview after editing.
