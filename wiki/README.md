# VPS Wiki

**Vocal Practice Studio** — Tauri v2 desktop app for singers to practice against separated instrumental tracks, record takes, and analyze their performance.

## Pages

| Page | Description |
|------|-------------|
| [Architecture](architecture.md) | 3-tier system overview: React → Tauri → Python sidecar |
| [Audio Engine](audio-engine.md) | Three-instance WaveSurfer playback (vocals/instrumental/take), sync, looping, device routing, timeline zoom/pan |
| [Recording Flow](recording-flow.md) | Recording lifecycle and Windows WASAPI audio routing quirks |
| [Data Model](data-model.md) | TypeScript interfaces, Rust structs, and library storage layout |
| [Python Sidecar](python-sidecar.md) | JSON-lines IPC, stem separation, pitch detection, pitch shifting |
| [Components](components.md) | Frontend component reference and Zustand store |
| [Detachable panels](detachable-panels.md) | Spike: drag Piano roll / Lyrics into their own window; the main-window bridge, the remote clock, what was not obvious |
| [YouTube sign-in](youtube-signin.md) | In-app Google sign-in that produces the cookies file for YouTube import: flow, security (no IPC for the remote window), hand-test checklist |
| [Dev Setup](dev-setup.md) | Prerequisites, build commands, and local development notes |
| [Testing](testing.md) | The three test suites (vitest, cargo, pytest), CI, fixtures, cross-language contract tests |
| [Lyrics Sync](lyrics.md) | Forced alignment of lyrics to the vocals stem: design, wire protocol, accuracy measurements, tests |
| [Shared code](shared-core.md) | What comes from `@giamat90/mps-core`, the wiring in this repo, how to change or bump it |
| [UI Polish](ui-polish.md) | Design tokens, `polish.css` layer, accessibility conventions |
