# UI Polish Layer

Branch `ui/polish`. Visual/UX refinement without layout changes.

## Structure

- `src/styles/global.css` — layout and component styles. `:root` now also carries design tokens: `--border`, `--border-strong`, `--bg-raised`, `--accent-soft`, `--accent-ring`, `--info`, `--record` / `--record-soft` / `--record-glow`, `--radius-*`, `--shadow-*`, `--ease`, `--dur*`. (`--border` was previously referenced by `.count-in-btn` but never defined.) The record tokens are the one red of the Record button, kept apart from `--accent` so it stays red in an app whose accent is not (SPS's is amber); `polish.css` takes its glow from them.
- `src/styles/polish.css` — loaded after `global.css` from `main.tsx`. Pure refinement: focus rings, press feedback, scrollbars, slider styling, card elevation, hover-reveal of rename/delete actions, empty states, entrance animations, `prefers-reduced-motion`. Deleting the file reverts to the previous look.
- All new dimensions are relative units. The 22 remaining layout `px` values in `global.css` were converted to `rem`.

## Accessibility

- Global `:focus-visible` ring (mouse clicks stay clean).
- Icon-only buttons have `aria-label`s; toggles use `aria-pressed` / `aria-expanded`; error/status text uses `role="alert"` / `role="status"`.
- Song cards are keyboard-operable (Enter / Space opens, only when the card itself is focused).
- Rename/delete controls on song cards and takes are revealed on hover **and** `:focus-within`, never hidden from keyboard users.

## Not touched

`MonitorButton`, `DualTuner` and the short-term-spectrum panels were mid-edit on `master` when this branch was cut, so they are styled through CSS only.

## App icon

VPS's icon (`src-tauri/icons/`) is a dark navy rounded square with five waveform bars, the centre bar in the coral accent (2026-10-12). It is a sibling of SPS's icon (stem bars in amber): same base, only the accent differs. Designed in Claude Design, exported at 1024 px and expanded with `npx tauri icon <png> -o src-tauri/icons`; delete the generated `android/`, `ios/` and `64x64.png` (the bundle config lists only `32x32`, `128x128`, `128x128@2x`, `icon.icns`, `icon.ico`). Before this both apps shipped the identical default Tauri logo.
