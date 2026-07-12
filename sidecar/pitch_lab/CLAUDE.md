# Pitch Lab — Claude Code Context

Algorithm validation workspace for VPS's pitch detection, living inside VPS's own repo at
`sidecar/pitch_lab/`. **Read `README.md` in this folder first** — it's the authoritative workflow doc
(setup, all tools, full findings tables). This file is a fast-orientation layer for picking up
mid-investigation without re-reading git history.

## Rule that always applies

This lab never modifies `processor.py` or any shipped pitch detection automatically. Every finding
here is provisional until validated across multiple real tracks and manually ported back — see
README's "Port confirmed fixes back manually" step. Don't skip straight to editing `processor.py`
from something found only in one track's plot.

## Current state (as of 2026-07-12)

- **Tools built:** `algorithms.py` (SRH/pYIN/HPS/CREPE/Praat production wrappers — all five are
  shipped, user-selectable in the app's Settings panel — + `firstpeak` naive baseline +
  `srh_variant`/`praat_variant` for parameter sweeps), `visualize.py`, `spectrogram_mpl.py` /
  `spectrogram_interactive.py`, `sonify.py`, `compare.py`, `preprocess.py` / `preprocess_compare.py`,
  `postprocess.py` / `postprocess_compare.py`, `batch_report.py`.
- **Real tracks in `tracks/`** (gitignored, not in this listing but present on disk): "Alice In Chains
  – Them Bones – Vocals.wav" (66.6% SRH/pYIN disagreement — pYIN fails badly on this raspy vocal) and
  "like a stone voice.mp3" (21.7% — comparatively mild, cleaner Chris Cornell vocal).
- **Convention:** always run/plot all six algorithms (SRH, pYIN, First-Peak, HPS, CREPE, Praat), not
  just SRH/pYIN — don't silently drop First-Peak (the zero-harmonic-logic floor) or any newer
  algorithm from new tools for convenience.
- **SRH (`detect_pitch_srh`) — the production default again as of 2026-07-12.** Praat
  (`detect_pitch_praat`, added 2026-07-11 via `praat-parselmouth`) briefly held the default slot after
  winning the two-track pitch_lab A/B and an in-app listening test on those two tracks; a broader
  in-app A/B across all five algorithms on 2026-07-12 rated SRH clearly best (CREPE second), reverting
  the default back to SRH. Praat remains a selectable alternative — its documented VoceVista-parity
  rationale (octave-cost = "prefer harmonic fundamental" + Viterbi path finding) still stands, it just
  isn't the default. Praat defaults kept as-is; sweeps go through `praat_variant()` (`octave_cost` and
  `voicing_threshold` are the interesting knobs). Praat output skips `_smooth_voiced` — its path finding
  is the smoothing pass (same reasoning as pYIN's HMM).

## Key findings so far (see README for full tables/detail)

1. **Preprocessing:** `trim+highpass+normalize` is the validated `DEFAULT_PIPELINE` (neutral-to-positive
   on both tracks). HPSS and spectral denoise were tested and deliberately excluded from the default —
   HPSS actively hurts raspy vocal texture (reads it as "percussive" like drum bleed), denoise is a
   measurable no-op (Demucs output has no stationary noise floor to subtract).
2. **Strongest lead for an actual `processor.py` fix:** SRH's `amplitude_threshold=-50dBFS` is an
   absolute constant, so quieter source tracks lose more legitimately-voiced-but-quiet frames to the
   gate than louder ones. Loudness normalization alone recovered +6 points of voiced% on "Like a Stone."
   Worth considering a loudness-relative threshold in production rather than a fixed dB constant.
3. **Postprocessing:** `smooth_pitch()` uses a Hampel filter (local median + MAD), NOT a running-anchor
   approach — the anchor design got permanently stuck across a real sustained glide (see README's
   postmortem on this). Dramatically cleans pYIN's octave-jump spikes (1376→277 flagged frames on "Them
   Bones") while leaving SRH's already-clean output almost untouched (1481→39 after the fix) and
   correctly preserving genuine sustained glides instead of rejecting them.
4. `analysis.py` (take/recording analysis) already calls `detect_pitch_srh`, not pYIN — the doc drift in
   `VPS/CLAUDE.md` claiming otherwise was found and fixed while building this lab.

## Pending / not yet done

- `preprocess_compare.py` / `postprocess_compare.py` aren't wired into `batch_report.py`'s automatic
  bulk pass yet — still manual, per-track, opt-in tools you run explicitly.
- Nothing from this lab has been ported back to `processor.py` yet — every finding above is still
  lab-only/provisional.
- Only two real tracks tested so far. Treat the HPSS/denoise verdicts as directional, not universal,
  until validated against more voice types/timbres (the existing rejections were specific to Layne
  Staley's raspy texture and Demucs' apparent lack of stationary noise floor — a different singer or a
  noisier source recording could change the answer).

## Gotchas

- Both sidecar venvs (`VPS/sidecar/.venv/`, also `SPS/sidecar/.venv/`) were rebuilt from scratch on
  2026-07-05 after moving the project folders broke every console-script launcher (`pip.exe` etc. embed
  an absolute path at creation time). If `pip.exe` ever breaks again with a "Fatal error in launcher"
  pointing at a stale path, use `python -m pip` to bypass it rather than `venv --upgrade` (which only
  rewrites `python.exe`/`activate`, not pip's own generated launcher scripts).
- `matplotlib` and `plotly` are lab-only dependencies (`pitch_lab/requirements-lab.txt`), not part of
  the shipped sidecar's `requirements.txt` — don't let production code start depending on them.
