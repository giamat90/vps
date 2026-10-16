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
  `srh_variant`/`srh_legacy`/`praat_variant` for parameter sweeps), `visualize.py`, `spectrogram_mpl.py` /
  `spectrogram_interactive.py`, `waveform_mpl.py` (native-window waveform), `short_term_spectrum_mpl.py`
  (the app's Short-Term Spectrum panel at a slider-chosen time, with per-algorithm F0 + harmonics overlay
  to eyeball octave errors), `sonify.py`, `compare.py`, `preprocess.py` / `preprocess_compare.py`,
  `postprocess.py` / `postprocess_compare.py`, `batch_report.py`, `benchmark_vocadito.py` (all six detectors
  scored against the public vocadito ground truth).
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
- **Ported 2026-10-08:** SRH `n_harmonics` 5 → 7 and `voicing_threshold` 0.25 → 0.22 in
  `processor.py:detect_pitch_srh` (`srh_variant()` defaults updated to match). Basis: sweep on a fixed
  frame set scored against the Praat/pYIN/CREPE consensus — "Them Bones" 49.0% → 58.6% within 50 cents,
  "Like a Stone" 88.6% → 89.1%; 8+ harmonics swaps too-high for too-low errors; a "prefer sub-multiple
  candidate" rule was disastrous (octave-down on 30–97% of frames). Still provisional: only two male
  rock tracks, reference is other detectors (not ground truth). Not fixed: SRH still reports pitch on
  noise/consonants (~630 / ~456 loud frames where Praat+CREPE say unvoiced) — needs a
  harmonicity/periodicity check, and Them Bones ~67.0 s (true ~138 Hz, SRH 240 Hz) is still wrong.
  Songs already analyzed keep their old `analysis.json` pitch until re-processed.
- **Ported 2026-10-11:** Viterbi over the top-5 SRH peaks, voicing by harmonic contrast
  `(H-I)/(H+I) > 0.6` (was score/track-max > 0.22), median-5 inside voiced runs (was median-6 + Gaussian
  over gap-joined frames). Three Demucs tracks (Black Hole Sun held out): correct <50c 56→68 / 88→93 /
  84→94%, false-voiced -63–69%; 44 real mic takes: 85.0→94.2% (none worse), false-voiced -54%. The smoothing fix is
  the biggest single win. Full table in README ("SRH on separated stems"); regression tests in
  `sidecar/tests/test_pitch.py` (`TestSRHOnSeparatedStems` etc.). `srh_variant()` defaults == production
  (verified frame by frame), `srh_legacy()` is the pre-port behaviour, `--algo srh-legacy` overlays it.
  Still open: female/soft voices untested; HPS/CREPE still use the Gaussian `_smooth_voiced`; a sustained
  wrong octave (not an isolated frame) is not fixed by the Viterbi cost.
- **Ported 2026-10-11 (second voice):** two singers on one stem (Them Bones 11-14 s, C#4 + G#3). Harmonic
  cancellation of the first voice + SRH/Viterbi on the residual, steady stretches only, lead held per stretch
  -> `processor.detect_second_voice` / `add_second_voice`, output `pitchData.f0Alt`. Prototype scripts were
  scratch-only; the production function is the reference. See `wiki/python-sidecar.md` "Second voice".
- Everything else above is still lab-only/provisional.
- Only two real tracks tested so far. Treat the HPSS/denoise verdicts as directional, not universal,
  until validated against more voice types/timbres (the existing rejections were specific to Layne
  Staley's raspy texture and Demucs' apparent lack of stationary noise floor — a different singer or a
  noisier source recording could change the answer).

- **Ground truth exists (2026-10-16):** `benchmark_vocadito.py`, 40 clean solo excerpts. SRH 93.6% within 50 c
  (pYIN 97.9%, Praat 93.4%, CREPE 81.1%, First-Peak 86.2%, HPS 6.9% because of its voicing gate); SRH has
  no bias but only 84% within 25 c (pYIN 94%) and 2% octave errors concentrated on a few tracks (29, 6, 34,
  33). Untested: Demucs stems. Table and caveats in README ("Ground truth: vocadito benchmark").

## Gotchas

- Both sidecar venvs (`VPS/sidecar/.venv/`, also `SPS/sidecar/.venv/`) were rebuilt from scratch on
  2026-07-05 after moving the project folders broke every console-script launcher (`pip.exe` etc. embed
  an absolute path at creation time). If `pip.exe` ever breaks again with a "Fatal error in launcher"
  pointing at a stale path, use `python -m pip` to bypass it rather than `venv --upgrade` (which only
  rewrites `python.exe`/`activate`, not pip's own generated launcher scripts).
- Run lab scripts with the sidecar venv's Python (`..\.venv\Scripts\python.exe` from `pitch_lab/`, or
  activate it). Launching a script by bare filename uses the global Python, which lacks
  `praat-parselmouth` (`short_term_spectrum_mpl.py` skips such algorithms with a warning; the others
  crash).
- `matplotlib` and `plotly` are lab-only dependencies (`pitch_lab/requirements-lab.txt`), not part of
  the shipped sidecar's `requirements.txt` — don't let production code start depending on them.
