# Pitch Lab

Algorithm validation workspace for VPS's pitch detection. Some Demucs-split
vocal tracks track pitch cleanly; others don't (wrong octave, jumping to a
harmonic, jittering through unvoiced-but-loud sections). This folder is
where that's diagnosed — outside the app, against real split tracks, without
touching `processor.py` until a fix is actually confirmed.

## Setup

Reuses the sidecar's existing venv, plus `matplotlib` for plotting:

```powershell
cd VPS\sidecar
.\.venv\Scripts\activate
pip install -r pitch_lab\requirements-lab.txt
```

## Getting tracks to analyze

Split tracks live in `~/.vps/library/{songId}/vocals.wav` after `process_song`
runs. Copy the ones you want to investigate into `pitch_lab/tracks/` — rename
them to something identifiable (e.g. `chris_cornell_black_hole_sun_vocals.wav`)
since the songId directory name alone isn't meaningful.

```powershell
Copy-Item "$env:USERPROFILE\.vps\library\<songId>\vocals.wav" `
  "pitch_lab\tracks\<descriptive-name>_vocals.wav"
```

`tracks/` and `results/` are gitignored (audio samples and generated plots
don't belong in VPS's repo) — only `.gitkeep` is tracked.

## Workflow

1. **Triage in bulk first:**
   ```powershell
   python pitch_lab\batch_report.py
   ```
   Runs SRH + pYIN + First-Peak + HPS + CREPE + Praat on every track in `tracks/`, writes plots and
   sonified audio to `results/`, and ranks tracks in `results/index.md` by how
   often SRH and pYIN disagree. High disagreement is a pointer to look
   closer, not a verdict — SRH was adopted specifically because pYIN loses
   the fundamental on strong chest-voice singers, so pYIN disagreeing with
   SRH is sometimes pYIN being wrong, not SRH.

2. **Look at the worst offenders individually:**
   ```powershell
   python pitch_lab\visualize.py pitch_lab\tracks\<name>.wav              # spectrogram + F0, one plot per algorithm
   python pitch_lab\visualize.py pitch_lab\tracks\<name>.wav --algo srh   # SRH only
   python pitch_lab\sonify.py pitch_lab\tracks\<name>.wav                 # audible check, one file per algorithm
   python pitch_lab\sonify.py pitch_lab\tracks\<name>.wav --algo pyin     # pYIN only
   python pitch_lab\compare.py pitch_lab\tracks\<name>.wav                # SRH vs pYIN overlaid on one axis
   ```
   `visualize.py` writes `<name>-spectrum-srh.png`, `<name>-spectrum-pyin.png`,
   `<name>-spectrum-firstpeak.png`, `<name>-spectrum-hps.png`, `<name>-spectrum-crepe.png`, and
   `<name>-spectrum-praat.png` — each shows that algorithm's F0 curve against the actual spectrogram,
   so you can see directly whether it's sitting on the sung harmonic or has drifted onto a neighbor.
   `compare.py`'s `_compare.png` overlays all six (SRH, pYIN, First-Peak, HPS, CREPE, Praat) on one
   axis, better for spotting *where* they diverge rather than *why* — though its disagreement metric
   stays SRH-vs-pYIN specifically, since those two were the original production candidates the metric
   was built to compare.

   `sonify.py` writes `<name>-srh.wav`, `<name>-pyin.wav`, `<name>-firstpeak.wav`, `<name>-hps.wav`,
   `<name>-crepe.wav`, `<name>-praat.wav`: original vocals in the left channel, a sine tone following
   that algorithm's detected F0 in the right channel. Pan hard to compare — an octave error, a jump to the wrong
   harmonic, or pitch tracking through a breath/consonant will all be audible as the tone visibly
   disagreeing with what you hear.

   **Available algorithms — all six are now user-selectable in the shipped app's Settings panel
   (SRH/pYIN/HPS/CREPE/Praat) except First-Peak:** `srh` (default), `praat` (briefly the default,
   2026-07-11 to 2026-07-12), `pyin`,
   `hps`, `crepe` (all production — see `processor.py`'s `PITCH_ALGORITHMS` registry), plus `firstpeak` — a deliberately naive baseline
   that picks the first spectral peak above a threshold scanning up from `fmin`, with no harmonic
   reasoning at all. It's not a real candidate, but it's cheap to include everywhere and gives a "zero
   harmonic logic" floor to judge the others against, so every comparison tool in this lab
   (`compare.py`, `postprocess_compare.py`, `batch_report.py`, and manual `visualize.py`/`sonify.py`
   runs) should include it rather than skip it for convenience.

3. **Experiment with parameters without touching `processor.py`:**
   `algorithms.py`'s `srh_variant()` is a full reimplementation of
   `detect_pitch_srh` with every constant (frame length, harmonics count,
   voicing threshold, smoothing) exposed as a keyword argument. Write a
   throwaway script that calls `srh_variant(audio, sr, voicing_threshold=0.35)`
   etc. and re-run `visualize.py`-style plotting against it to see the effect
   before committing to a change. `praat_variant()` is the same idea for the
   Praat detector, exposing parselmouth's full Boersma signature — the two
   knobs most relevant to the VoceVista comparison are `octave_cost` (higher =
   stronger "prefer harmonic fundamental" pull toward lower candidates) and
   `voicing_threshold`.

4. **Try cleaning the track before detection (`preprocess.py` / `preprocess_compare.py`).**
   Aimed at Demucs separation artifacts (instrument/drum bleed), not generic denoising — see
   "Preprocessing findings" below before assuming a step helps.
   ```powershell
   python pitch_lab\preprocess_compare.py pitch_lab\tracks\<name>.wav                          # default pipeline
   python pitch_lab\preprocess_compare.py pitch_lab\tracks\<name>.wav --steps highpass,hpss     # custom subset
   ```
   Writes `<name>-cleaned.wav` (run it through `visualize.py`/`sonify.py` like any other track for a
   full look) and `<name>-preprocess-<algo>.png` (raw vs. cleaned F0 overlaid on the raw spectrogram,
   with voiced%/confidence in the title).

5. **Clean up the detected pitch curve itself (`postprocess.py` / `postprocess_compare.py`).**
   This operates on the {times, f0, voiced, confidence} output, not the audio — detector-agnostic,
   works the same on SRH/pYIN/First-Peak/Praat output.
   ```powershell
   python pitch_lab\postprocess_compare.py pitch_lab\tracks\<name>.wav --algo pyin
   ```
   Flags frames that deviate from their **local** neighborhood (Hampel filter: median + MAD in a
   moving window, not a fixed physical rate limit — see "Postprocessing findings" below for why) and
   linearly interpolates across short flagged/unvoiced runs in log-frequency (cents) space, leaving
   long real gaps (actual pauses) alone. Writes `<name>-postprocess-<algo>.png` (raw vs. smoothed
   overlaid on the spectrogram, with flagged/bridged frame counts in the title).

6. **Port confirmed fixes back manually.** Once a parameter change or
   correction pass is validated against several tracks, apply it directly to
   `processor.py:detect_pitch_srh` (the production function) — this lab
   never modifies it automatically. Update `VPS/CLAUDE.md`'s "Pitch detection
   choices" section and `VPS/wiki/python-sidecar.md` to match.

## Preprocessing findings (2026-07-05)

Tested `preprocess.py`'s steps against SRH on two real split vocal tracks:

| Track | Raw | `trim+highpass+normalize` | `+hpss` (old default) |
|---|---|---|---|
| Alice In Chains – Them Bones | 75.6% voiced, conf 0.44 | 76.3% voiced, conf 0.44 (neutral) | 61.6% voiced, conf 0.41 (worse) |
| Chris Cornell – Like a Stone | 74.2% voiced, conf 0.47 | **80.1% voiced, conf 0.47 (improved)** | 73.0% voiced, conf 0.43 (worse) |

**HPSS (`harmonic_only`) is not in the default pipeline** — swept margins 1.5–8 on "Them Bones" and it
never beat the raw baseline, only got worse as margin increased. Layne Staley's raspy/gritty vocal
texture reads partly as "percussive" to librosa's HPSS and gets suppressed like drum bleed, even
though it's legitimate vocal color. Pass `--steps highpass,hpss,normalize` explicitly if a specific
track is suspected to have real instrument/drum bleed (visually confirmed in the spectrogram first).

**`trim+highpass+normalize` is neutral-to-positive** and is the new `DEFAULT_PIPELINE`. The "Like a
Stone" improvement (74.2% → 80.1% voiced, confidence unchanged) came specifically from loudness
normalization: that source file was quieter, so more legitimately-voiced-but-quiet frames were
previously sitting below SRH's absolute `amplitude_threshold=-50dBFS` gate in `processor.py`. This is
the strongest lead so far for a real `processor.py` fix — an absolute dB threshold is inherently
inconsistent across tracks mixed/mastered at different loudness; consider whether SRH's threshold
should be relative to the track's own measured loudness instead of a fixed constant, before or
instead of normalizing every track's audio.

**`denoise` (conservative spectral-gating subtraction) is a measurable no-op** on both tracks — adding
it to the default pipeline changed voiced%/confidence by less than 0.2 points either way, and running
it alone (no other steps) was equally flat vs. raw. This reconfirms rather than contradicts
`VPS/CLAUDE.md`'s existing finding that Demucs output doesn't have much of a stationary broadband
noise floor to begin with: classical spectral subtraction targets steady-state hiss, but the actual
artifact here (bleed from other instruments) is itself harmonically structured and time-varying, so a
static per-track noise profile has little to catch. Kept as an opt-in step (`--steps
highpass,denoise,normalize`) for a track that visibly shows broadband hiss in its spectrogram, but not
added to `DEFAULT_PIPELINE` — no benefit means no reason to pay for it.

## Postprocessing findings (2026-07-05)

`postprocess.py`'s `smooth_pitch()` went through two designs on real data, worth recording so the
mistake isn't repeated:

**v1 (rejected): running "last accepted anchor" + a physical max-glide-rate limit (cents/sec).**
Sounds right ("a voice can't retune faster than X octaves/sec") but has a fatal bug: once a frame
gets flagged relative to the anchor, the anchor never advances, so *every subsequent frame* keeps
getting compared to the same stale reference point. For a brief spike this is fine (the curve returns
to near the anchor and matches again). But for a **genuine sustained glide** — SRH's raw output on
"Them Bones" has a real ~15-second decline from ~350Hz to ~80Hz around 1:47–2:00, clearly visible as a
diagonal harmonic trace in the spectrogram — the pitch keeps moving further from the frozen anchor
forever, so the entire real glide got flagged and thrown out (1481 frames flagged on SRH, more than
pYIN's 1376, despite SRH's curve being visibly much cleaner — a sign something was wrong with the
detector, not the algorithm).

**v2 (current): Hampel filter — local median + MAD (median absolute deviation) in a moving window.**
Compares each frame to its *local* neighborhood rather than a fixed-in-time anchor. A real glide's
local median moves with the trend, so it's not flagged at all; a true single/few-frame spike stands
out against its immediate neighbors regardless of any longer-term trend. Re-running on the same two
algorithms: SRH flagged dropped from 1481 → 39 (the real glide is now fully preserved), pYIN flagged
dropped from 1376 → 277 while still removing effectively all of the wild octave-scale spikes visible
in the raw curve (see `<name>-postprocess-pyin.png`) — pYIN's smoothed curve now tracks the harmonic
bands about as well as SRH's does.

**Caveat:** when a flagged/bridged region coincides with a spectrogram feature that looks structured
(a visible diagonal or harmonic trace, not noise), don't trust the "smoothed" curve blindly over the
raw one, or vice versa — listen with `sonify.py` first. The tool corrects statistical outliers; it
can't tell a wrong-but-structured detection from a real one on its own.

## Files

| File | Purpose |
|---|---|
| `algorithms.py` | Imports the real `detect_pitch_srh`/`detect_pitch`/`detect_pitch_hps`/`detect_pitch_crepe`/`detect_pitch_praat` from `processor.py`, plus `srh_variant()`/`praat_variant()` for parameter experiments and the `firstpeak` naive baseline |
| `preprocess.py` | Composable pre-detection cleaning steps (`trim`, `highpass`, `hpss`, `denoise`, `normalize`) aimed at Demucs bleed artifacts |
| `preprocess_compare.py` | A/B: runs an algorithm before/after the cleaning pipeline, writes the cleaned wav + a comparison plot |
| `postprocess.py` | Detector-agnostic pitch-curve cleanup: Hampel-filter outlier rejection + short-gap interpolation in cents space |
| `postprocess_compare.py` | A/B: runs an algorithm, then compares its raw output against `smooth_pitch()`'s output, writes a comparison plot |
| `visualize.py` | Spectrogram + F0 overlay, one plot per algorithm (`<name>-spectrum-<algo>.png`) — static PNG |
| `spectrogram_mpl.py` | Spectrogram only (no F0 overlay), opened as a native matplotlib window — run as a script, zoom/pan with matplotlib's own toolbar, nothing written to disk |
| `spectrogram_interactive.py` | Spectrogram only, written to a standalone zoomable HTML file (`<name>-spectrogram.html`, Plotly) — for when you want to reopen it later without re-running Python |
| `sonify.py` | Renders detected F0 as an audible sine tone alongside the original, one file per algorithm (`<name>-<algo>.wav`) |
| `compare.py` | SRH vs pYIN overlay + per-frame disagreement in cents |
| `batch_report.py` | Runs all of the above over every track in `tracks/`, ranks by disagreement |
| `tracks/` | Drop split `vocals.wav` files here (gitignored) |
| `results/` | Generated plots, sonified audio, and `index.md` report (gitignored) |

## Known context (see `VPS/wiki/python-sidecar.md` and `VPS/CLAUDE.md`)

- SRH was adopted over pYIN/CREPE because both lock onto upper harmonics
  instead of the fundamental on strong chest-voice singers.
- HPS was tried and rejected for jitter; an LPC/LP-residual approach was
  tried and reverted because Demucs output is "too clean" and distorts the
  spectral envelope.
- Only informal validation exists so far (VoceVista comparison on one
  Chris Cornell track) — there's no accuracy dataset. This lab is meant to
  start closing that gap across a wider range of voice types/timbres.
- **Praat provenance (2026-07-11):** `praat` (`detect_pitch_praat`, via
  `praat-parselmouth`) was added after concluding VoceVista tracks split
  vocals better than our detectors. VoceVista's algorithm is unpublished, but
  its documented behavior (time-domain detector separate from the FFT, a
  "prefer harmonic fundamental" option, pitch floor/ceiling, averaging
  window) matches Praat's autocorrelation method (Boersma 1993) — octave-cost
  candidate weighting + Viterbi path finding — and `Researches/1912.12609v1`
  found Praat gives the best voicing determination on singing voice. Praat
  output is NOT run through `_smooth_voiced` (its path finding is already the
  smoothing pass, same reasoning as pYIN's HMM).
- An unmerged branch `feature/algorithm-improvements` has a pending
  `preferHarmonicFundamental` evaluation — check whether findings from this
  lab overlap with it before starting from scratch. The unmerged
  `feature/pitch-autocorr-ab` branch holds earlier SRH candidate-selection /
  Viterbi experiments on the same problem — related prior art, different
  approach from the Praat port.
- `analysis.py` (take/recording analysis) actually calls `detect_pitch_srh`
  too, not pYIN — `VPS/CLAUDE.md`'s tech-stack table saying "Take pitch
  detection: pYIN" is stale. `detect_pitch` (pYIN) exists in `processor.py`
  but nothing in the app currently calls it; it's kept here as a comparison
  baseline via `pyin_production()`.
