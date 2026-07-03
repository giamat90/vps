"""
Core processing pipeline for uploaded songs.
Demucs stem separation → pyin pitch → librosa onsets/dynamics/BPM → key detection.
"""

import base64
import os
import sys
import gc
import time
import traceback
from typing import TypedDict
import numpy as np
import soundfile as sf
import librosa
from scipy.signal import butter, sosfilt, resample_poly, correlate
from scipy.signal.windows import chebwin
from scipy.ndimage import median_filter, gaussian_filter1d

SAMPLE_RATE = 44100
CONFIDENCE_THRESHOLD = 0.5

# SRH candidate selection: among local maxima on the SRH score curve within
# this fraction of the top score, prefer the lowest-frequency one. Fixes
# formant-driven lock-on to a harmonic instead of a weaker true fundamental.
SRH_LOW_FREQ_MARGIN = 0.90

# MPM (McLeod & Wyvill 2005) key-maximum cutoff — matches Tartini's default.
MPM_CUTOFF_K = 0.93

# SRH harmonic-term weighting scheme: "none" = original equal-weight SRH
# (w(n)=1 for all n=1..5). "1/n" = decaying weight on both the harmonic and
# inter-harmonic terms, favoring the fundamental's own (n=1) term — tests
# whether a candidate at n*F0 (whose apparent harmonics are really the true
# fundamental's higher harmonics) can be stopped from out-scoring the true
# fundamental on belted/formant-heavy passages where upper-harmonic energy
# dominates. Kept as a toggle so unweighted behavior stays directly comparable.
SRH_HARMONIC_WEIGHTING = "none"


def _srh_weight_vector(n_harmonics: int, scheme: str) -> np.ndarray:
    """Per-harmonic weight w(n) for n=1..n_harmonics. See SRH_HARMONIC_WEIGHTING."""
    if scheme == "none":
        return np.ones(n_harmonics)
    if scheme == "1/n":
        return 1.0 / np.arange(1, n_harmonics + 1)
    raise ValueError(f"Unknown SRH harmonic weighting scheme: {scheme!r}")


class PitchData(TypedDict):
    times: list
    f0: list
    voiced: list
    confidence: list

# Krumhansl-Kessler key profiles
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _log(msg: str):
    print(msg, file=sys.stderr, flush=True)


def _correct_octave_errors_spectral(
    y: np.ndarray,
    sr: int,
    f0: np.ndarray,
    voiced_flag: np.ndarray,
    hop_length: int = 512,
    n_fft: int = 2048,
    fmin_hz: float = 65.0,
) -> np.ndarray:
    """
    Spectral subharmonic check for octave errors.

    When pyin locks onto 2F0 instead of F0 (common on powerful high notes),
    the true fundamental F0 = detected/2 is still present in the spectrum,
    along with its 3rd harmonic at 3·F0/2.  A correctly detected F0 has no
    energy at F0/2 (singing voice has no subharmonics).

    This check is per-frame and independent of neighbours, so sustained
    octave errors (where the local median is also wrong) are caught.
    """
    D = np.abs(librosa.stft(y, n_fft=n_fft, hop_length=hop_length))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=n_fft)
    corrected = f0.copy()
    n = min(len(f0), D.shape[1])

    def energy_near(freq: float, frame: int) -> float:
        # Sum energy within ±1 semitone of freq
        lo = freq * 2 ** (-1 / 12)
        hi = freq * 2 ** (1 / 12)
        mask = (freqs >= lo) & (freqs <= hi)
        return float(D[mask, frame].sum()) if mask.any() else 0.0

    for i in range(n):
        if not voiced_flag[i] or np.isnan(f0[i]) or f0[i] <= 0:
            continue
        f_sub = f0[i] / 2.0
        if f_sub < fmin_hz:
            continue

        e_det  = energy_near(f0[i],         i)
        e_sub  = energy_near(f_sub,          i)   # candidate true F0
        e_3sub = energy_near(3.0 * f_sub,    i)   # 3rd harmonic of candidate F0

        # Subharmonic AND its odd harmonic present → detected pitch is 2F0, not F0
        if e_sub > 0.2 * e_det and e_3sub > 0.1 * e_det:
            corrected[i] = f_sub

    return corrected


def detect_pitch(audio: np.ndarray, sr: int) -> dict:
    """
    Deterministic pitch detection using pYIN + spectral subharmonic correction.
    pYIN is autocorrelation-based and robust to strong harmonics; the spectral
    correction adds a second-pass octave check for edge cases.
    """
    f0, voiced_flag, voiced_probs = librosa.pyin(
        audio,
        fmin=65.0,
        fmax=1400.0,
        sr=sr,
        frame_length=2048,
        hop_length=512,
        beta_parameters=(2, 6),
    )
    f0 = _correct_octave_errors_spectral(audio, sr, f0, voiced_flag)
    times = librosa.times_like(f0, sr=sr, hop_length=512)
    f0_clean = np.where(voiced_flag, f0, 0.0)
    return {
        "times": times.tolist(),
        "f0": f0_clean.tolist(),
        "voiced": voiced_flag.tolist(),
        "confidence": voiced_probs.tolist(),
    }


def _correct_srh_subharmonic(
    spectrum: np.ndarray,
    bin_width: float,
    max_bin: int,
    f_best: float,
    amplitude_threshold: float,
    fmin: float,
    debug: bool = False,
    frame_time: float = 0.0,
) -> tuple:
    """
    Subharmonic-multiple correction for SRH's winning candidate (post low-freq-
    margin). Targets the failure mode where the winner is really n*F0: every
    harmonic of n*F0 coincides with a harmonic of the true F0 (k*f_best) —
    "shared" evidence that would be present either way and so proves nothing.
    A magnitude-fraction test against f_best's own score can't discriminate on
    that shared evidence (this replaced an earlier version that tried exactly
    that and fired constantly on already-correct fundamentals).

    Instead this checks only the DISTINGUISHING harmonics of the f_best/n
    candidate: multiples m*(f_best/n) for m in 1..5 (matching SRH's own
    n_harmonics=5 range) where m is NOT a multiple of n — frequencies that
    would only carry energy if f_best/n were genuinely the fundamental.
    Sampled from the same normalized magnitude spectrum the SRH score itself
    sums over, at the same nearest-FFT-bin resolution the harmonic/inter-
    harmonic sums use (no separate computation, no semitone window).

    A correction is accepted only if at least 2 of the distinguishing
    multiples, and at least half of those checked, clear the pipeline's
    existing -50 dBFS noise floor (amplitude_threshold) — an absolute
    noise-floor test, not a relative-magnitude guess.

    Checks n = 2, 3, 4 independently and prefers the lowest qualifying
    frequency. Returns (f0_hz, corrected); f0_hz is f_best unchanged if no
    candidate n qualifies.
    """
    def bin_mag(freq: float) -> float:
        idx = int(np.clip(round(freq / bin_width), 0, max_bin))
        return float(spectrum[idx])

    qualifying = []
    for n in (2, 3, 4):
        f_sub = f_best / n
        if f_sub < fmin:
            continue
        distinguishing_m = [m for m in range(1, 6) if m % n != 0]
        hits = sum(1 for m in distinguishing_m if bin_mag(m * f_sub) > amplitude_threshold)
        total = len(distinguishing_m)
        if hits >= 2 and (hits / total) >= 0.5:
            qualifying.append((f_sub, n, hits, total))

    if not qualifying:
        return f_best, False

    f_sub, n, hits, total = min(qualifying, key=lambda item: item[0])

    if debug:
        _log(
            f"[SRH subharmonic correction] t={frame_time:.3f}s "
            f"f_best={f_best:.2f}Hz -> corrected f0={f_sub:.2f}Hz "
            f"(n={n}, {hits}/{total} distinguishing harmonics above noise floor)"
        )

    return f_sub, True


def detect_pitch_srh(
    audio: np.ndarray, sr: int, debug: bool = False, weighting: str = SRH_HARMONIC_WEIGHTING
) -> dict:
    """
    Summation of Residual Harmonics (SRH) pitch detection.

    For each candidate F0, SRH sums spectral energy at harmonics
    and subtracts energy at inter-harmonic frequencies:

        SRH(f) = sum_n [ w(n) * X(n*f) - w(n) * X((n+0.5)*f) ]  for n = 1..N

    w(n) is 1 for all n (original, unweighted SRH) unless weighting="1/n" is
    passed — see SRH_HARMONIC_WEIGHTING. The true F0 maximizes this score.
    More stable than HPS because:
    - Addition is robust to weak/missing harmonics (HPS multiplication is not)
    - Inter-harmonic subtraction actively suppresses non-fundamental candidates
    - Sub-bin precision via parabolic interpolation on the SRH score curve

    Candidate selection: among local maxima of the SRH score curve within
    SRH_LOW_FREQ_MARGIN of the top score, the LOWEST-frequency one is chosen
    (not just the global argmax). Strong vocal formants can make a harmonic's
    SRH peak edge out a weaker true-fundamental peak; when the two are close
    competitors this recovers the lower (true) fundamental instead. When there
    is only one dominant maximum, behavior is unchanged from a plain argmax.

    debug: if True, logs frames where the low-frequency pick differs from the
    raw global-max pick (time, chosen/rejected f0 and their scores).
    """

    # Resample to 22050 Hz for consistent bin resolution
    # Zero-padding to fft_size=4096 gives 5.4 Hz/bin with only 125 ms analysis window
    target_sr = 22050
    if sr != target_sr:
        audio = librosa.resample(audio, orig_sr=sr, target_sr=target_sr)
        sr = target_sr

    frame_length = 2756  # 125 ms at 22050 Hz — optimal for singing (Babacan et al. 2019)
    fft_size = 4096      # zero-pad to 4096: 5.4 Hz/bin with only 125 ms temporal blur
    hop_length = 512
    n_harmonics = 5
    fmin = 65.0    # C2 — lowest practical singing fundamental
    fmax = 1400.0  # above F#6 — matches VoceVista upper limit; no singer exceeds this
    voicing_threshold = 0.25  # matches VoceVista XML "minimumClarity" — rejects weakly-voiced frames
    amplitude_threshold = 10 ** (-50 / 20)  # −50 dBFS; silent frames skipped before SRH

    # Pad audio
    audio = np.pad(audio, frame_length // 2, mode='reflect')
    frames = librosa.util.frame(
        audio,
        frame_length=frame_length,
        hop_length=hop_length
    )
    n_frames = frames.shape[1]

    # Frequency axis based on zero-padded FFT size
    freqs = np.fft.rfftfreq(fft_size, d=1.0 / sr)
    bin_width = sr / fft_size  # Hz per bin

    # Candidate F0 range — evaluate SRH at each candidate
    # Use fine resolution: 0.5 Hz steps for sub-Hz precision
    f0_candidates = np.arange(fmin, fmax, 0.5)

    # Precompute candidate bin indices for harmonics and inter-harmonics
    # Shape: (n_candidates, n_harmonics)
    harmonic_bins = np.array([
        np.round(f0_candidates * n / bin_width).astype(int)
        for n in range(1, n_harmonics + 1)
    ]).T  # (n_candidates, n_harmonics)

    inter_bins = np.array([
        np.round(f0_candidates * (n + 0.5) / bin_width).astype(int)
        for n in range(1, n_harmonics + 1)
    ]).T  # (n_candidates, n_harmonics)

    # Clip to valid spectrum range
    max_bin = len(freqs) - 1
    harmonic_bins = np.clip(harmonic_bins, 0, max_bin)
    inter_bins = np.clip(inter_bins, 0, max_bin)

    harmonic_weights = _srh_weight_vector(n_harmonics, weighting)

    window = chebwin(frame_length, at=100)
    f0 = np.zeros(n_frames)
    confidence = np.zeros(n_frames)

    for i in range(n_frames):
        raw_frame = frames[:, i]
        if np.sqrt(np.mean(raw_frame ** 2)) < amplitude_threshold:
            continue  # silent frame — f0[i] and confidence[i] stay 0

        frame = raw_frame * window
        spectrum = np.abs(np.fft.rfft(frame, n=fft_size))

        # Normalize spectrum
        spectrum = spectrum / (spectrum.max() + 1e-8)

        # Compute SRH score for each candidate
        # SRH(f) = sum_n [ w(n)*X(n*f) - w(n)*X((n+0.5)*f) ]
        harmonic_energy = (spectrum[harmonic_bins] * harmonic_weights).sum(axis=1)
        inter_energy = (spectrum[inter_bins] * harmonic_weights).sum(axis=1)
        srh_scores = harmonic_energy - inter_energy

        # Global-max candidate (today's baseline choice)
        best_idx = np.argmax(srh_scores)
        best_score = srh_scores[best_idx]

        # Local maxima of the score curve — interior points plus the global
        # max itself (guards against the global max sitting on a plateau/edge
        # that the strict interior-maxima test would otherwise miss).
        score_diffs = np.diff(srh_scores)
        local_max_mask = np.zeros(len(srh_scores), dtype=bool)
        local_max_mask[1:-1] = (score_diffs[:-1] > 0) & (score_diffs[1:] < 0)
        local_max_mask[best_idx] = True

        candidate_idx = np.where(local_max_mask)[0]
        threshold = best_score * SRH_LOW_FREQ_MARGIN
        qualifying_idx = candidate_idx[srh_scores[candidate_idx] >= threshold]

        # Among competitors within the margin, prefer the lowest frequency.
        # (qualifying_idx always contains best_idx, so this never fails.)
        chosen_idx = qualifying_idx[np.argmin(f0_candidates[qualifying_idx])]

        frame_time = i * hop_length / sr

        if debug and chosen_idx != best_idx:
            _log(
                f"[SRH low-freq bias] t={frame_time:.3f}s "
                f"chosen f0={f0_candidates[chosen_idx]:.2f}Hz (score={srh_scores[chosen_idx]:.4f}) "
                f"rejected higher f0={f0_candidates[best_idx]:.2f}Hz (score={best_score:.4f})"
            )

        # NOTE: per-frame subharmonic correction (_correct_srh_subharmonic) was
        # tried here and reverted — 3 rounds of threshold tuning each traded
        # one false-positive pattern for another rather than eliminating it
        # (see git history / conversation log). Superseded by the Viterbi
        # track-level DP (_viterbi_track_pitch), which uses temporal
        # continuity instead of single-frame heuristics. The function is kept
        # in this file, unused, in case a future per-frame refinement proves
        # more selective.

        # Parabolic interpolation on SRH score curve for sub-Hz precision
        if 0 < chosen_idx < len(srh_scores) - 1:
            alpha = srh_scores[chosen_idx - 1]
            beta  = srh_scores[chosen_idx]
            gamma = srh_scores[chosen_idx + 1]
            denom = (alpha - 2 * beta + gamma)
            if denom != 0:
                p = 0.5 * (alpha - gamma) / denom
                p = np.clip(p, -1.0, 1.0)
            else:
                p = 0.0
        else:
            p = 0.0

        # Final F0: candidate frequency + sub-bin offset (0.5 Hz steps)
        f0[i] = f0_candidates[chosen_idx] + p * 0.5

        confidence[i] = srh_scores[chosen_idx]

    # Normalize confidence to 0-1
    if confidence.max() > 0:
        confidence = confidence / confidence.max()

    # Voicing detection
    voiced = confidence > voicing_threshold
    f0_clean = np.where(voiced, f0, 0.0)

    # Post-processing smoothing on voiced frames only
    f0_smooth = f0_clean.copy()
    voiced_indices = np.where(voiced)[0]

    if len(voiced_indices) > 3:
        f0_smooth[voiced_indices] = median_filter(
            f0_clean[voiced_indices],
            size=6  # ~140 ms at 43 fps — removes consecutive outlier pairs
        )
        f0_smooth[voiced_indices] = gaussian_filter1d(
            f0_smooth[voiced_indices],
            sigma=1.5  # FWHM ~82 ms — reduces jitter while preserving vibrato shape
        )

    f0_clean = f0_smooth

    # Time axis
    times = librosa.frames_to_time(
        np.arange(n_frames), sr=sr, hop_length=hop_length
    )

    return {
        "times": times.tolist(),
        "f0": f0_clean.tolist(),
        "voiced": voiced.tolist(),
        "confidence": confidence.tolist()
    }


# ---------------------------------------------------------------------------
# Viterbi track-level pitch correction (evaluation-only, not wired into
# process_song()). Supersedes the per-frame _correct_srh_subharmonic attempt
# above, which after 3 rounds of threshold tuning kept trading one
# false-positive harmonic multiple for another rather than eliminating it.
# Idea: expose SRH's top few per-frame candidates instead of collapsing to one
# winner immediately, then let a Viterbi DP pick the sequence that is both
# individually strong AND temporally smooth, with an extra penalty for jumps
# that look like the harmonic-multiple confusion SRH is known to make.
# ---------------------------------------------------------------------------

VITERBI_TOP_K = 5  # candidates kept per frame, matches SRH's own n_harmonics range

# The 0.5 Hz candidate grid means a single real spectral peak often produces
# several adjacent "local maxima" a few Hz apart (grid jitter, not distinct
# pitch hypotheses). Without deduping these, top-K can burn most of its slots
# on near-copies of the same false peak, crowding out the true fundamental
# entirely (confirmed on Them Bones @ 0:13.01: 4 of 5 slots were duplicates of
# one ~822Hz peak). Candidates within this many cents of an already-kept,
# higher-scoring candidate are treated as the same peak and dropped.
VITERBI_DEDUP_TOLERANCE_CENTS = 50.0

# Transition cost: smooth pitch movement should be near-free; a jump that
# looks like SRH's own harmonic-confusion pattern (2x/3x/4x, in cents) gets
# an extra penalty on top of the distance cost, so the DP actively avoids
# hopping onto a wrong-octave/wrong-harmonic candidate even if that
# candidate's own per-frame score is locally stronger.
VITERBI_BASE_COST_PER_CENT = 0.002
VITERBI_HARMONIC_JUMP_PENALTY = 2.0
VITERBI_HARMONIC_TOLERANCE_CENTS = 40.0
VITERBI_HARMONIC_BOUNDARIES_CENTS = (1200.0, 1200.0 * np.log2(3), 2400.0)  # 2x, 3x, 4x

# Silence as a distinct DP state, reusing detect_pitch_srh's own voicing_threshold
# (0.25) to decide, per frame, whether silence should be cheap (no candidate
# clears the threshold — this frame doesn't look voiced) or merely a
# discouraged fallback (a real candidate clears the threshold, so silence has
# to be justified by neighbouring frames via the transition cost instead).
VITERBI_SILENCE_TRANSITION_COST = 0.5
VITERBI_SILENCE_PENALTY_WHEN_VOICED_AVAILABLE = 0.05
VITERBI_SILENCE_PREFERRED_COST = -1.0  # more attractive than any sub-threshold candidate


def _dedupe_local_maxima(
    idx: np.ndarray, scores: np.ndarray, freqs: np.ndarray, tolerance_cents: float = VITERBI_DEDUP_TOLERANCE_CENTS
) -> np.ndarray:
    """
    Greedy non-max suppression over local maxima, in cents space: visiting
    candidates highest-score-first, drop any candidate within tolerance_cents
    of an already-kept (necessarily higher- or equal-scoring) candidate.
    Returns the surviving indices, still ordered by descending score.
    """
    order = idx[np.argsort(-scores[idx])]
    kept = []
    kept_freqs = []
    for i in order:
        f = freqs[i]
        if all(abs(1200.0 * np.log2(f / kf)) > tolerance_cents for kf in kept_freqs):
            kept.append(i)
            kept_freqs.append(f)
    return np.array(kept, dtype=int)


def _srh_frame_candidates(
    audio: np.ndarray, sr: int, top_k: int = VITERBI_TOP_K, weighting: str = SRH_HARMONIC_WEIGHTING
) -> dict:
    """
    Per-frame top-K SRH candidates (frequency, raw score), for the Viterbi DP.
    Same frame_length/hop_length/fft_size/candidate-grid/local-maxima logic as
    detect_pitch_srh (duplicated rather than shared, to keep this evaluation
    path fully isolated from the production function while it's unvalidated) —
    but instead of applying SRH_LOW_FREQ_MARGIN to collapse to one winner, it
    keeps the top-K local maxima by raw score so the DP can consider
    candidates the margin rule alone would have discarded (e.g. the true
    fundamental sitting well below the margin threshold).

    weighting: see SRH_HARMONIC_WEIGHTING — applies identically to the score
    curve here; doesn't touch local-maxima finding, dedup, or the DP itself.

    Returns {"times": [...], "candidates": [[(f0, score), ...], ...]} — one
    list per frame, empty for frames below the amplitude_threshold silence gate.
    """
    target_sr = 22050
    if sr != target_sr:
        audio = librosa.resample(audio, orig_sr=sr, target_sr=target_sr)
        sr = target_sr

    frame_length = 2756
    fft_size = 4096
    hop_length = 512
    n_harmonics = 5
    fmin = 65.0
    fmax = 1400.0
    amplitude_threshold = 10 ** (-50 / 20)

    audio = np.pad(audio, frame_length // 2, mode='reflect')
    frames = librosa.util.frame(audio, frame_length=frame_length, hop_length=hop_length)
    n_frames = frames.shape[1]

    freqs = np.fft.rfftfreq(fft_size, d=1.0 / sr)
    bin_width = sr / fft_size
    f0_candidates = np.arange(fmin, fmax, 0.5)

    harmonic_bins = np.array([
        np.round(f0_candidates * n / bin_width).astype(int)
        for n in range(1, n_harmonics + 1)
    ]).T
    inter_bins = np.array([
        np.round(f0_candidates * (n + 0.5) / bin_width).astype(int)
        for n in range(1, n_harmonics + 1)
    ]).T
    max_bin = len(freqs) - 1
    harmonic_bins = np.clip(harmonic_bins, 0, max_bin)
    inter_bins = np.clip(inter_bins, 0, max_bin)

    harmonic_weights = _srh_weight_vector(n_harmonics, weighting)

    window = chebwin(frame_length, at=100)
    candidates_per_frame = []

    for i in range(n_frames):
        raw_frame = frames[:, i]
        if np.sqrt(np.mean(raw_frame ** 2)) < amplitude_threshold:
            candidates_per_frame.append([])
            continue

        frame = raw_frame * window
        spectrum = np.abs(np.fft.rfft(frame, n=fft_size))
        spectrum = spectrum / (spectrum.max() + 1e-8)

        harmonic_energy = (spectrum[harmonic_bins] * harmonic_weights).sum(axis=1)
        inter_energy = (spectrum[inter_bins] * harmonic_weights).sum(axis=1)
        srh_scores = harmonic_energy - inter_energy

        best_idx = np.argmax(srh_scores)
        score_diffs = np.diff(srh_scores)
        local_max_mask = np.zeros(len(srh_scores), dtype=bool)
        local_max_mask[1:-1] = (score_diffs[:-1] > 0) & (score_diffs[1:] < 0)
        local_max_mask[best_idx] = True

        local_idx = np.where(local_max_mask)[0]
        deduped = _dedupe_local_maxima(local_idx, srh_scores, f0_candidates)
        ranked = deduped[:top_k]
        candidates_per_frame.append(
            [(float(f0_candidates[j]), float(srh_scores[j])) for j in ranked]
        )

    times = librosa.frames_to_time(np.arange(n_frames), sr=sr, hop_length=hop_length)
    return {"times": times.tolist(), "candidates": candidates_per_frame}


def _viterbi_transition_cost(prev: dict, cur: dict) -> float:
    """
    Cost of moving from one frame's chosen state to the next. Silence <-> pitch
    transitions cost a fixed onset/offset penalty; silence -> silence is free.
    Pitch -> pitch costs a small amount per cent of movement (smooth pitch is
    cheap), plus VITERBI_HARMONIC_JUMP_PENALTY when the jump size lands within
    VITERBI_HARMONIC_TOLERANCE_CENTS of an exact 2x/3x/4x ratio (or its
    downward equivalent — folded together since we compare abs(cents_diff)).
    """
    if prev["silence"] and cur["silence"]:
        return 0.0
    if prev["silence"] != cur["silence"]:
        return VITERBI_SILENCE_TRANSITION_COST

    cents_diff = abs(1200.0 * np.log2(cur["freq"] / prev["freq"]))
    cost = VITERBI_BASE_COST_PER_CENT * cents_diff
    for boundary in VITERBI_HARMONIC_BOUNDARIES_CENTS:
        if abs(cents_diff - boundary) <= VITERBI_HARMONIC_TOLERANCE_CENTS:
            cost += VITERBI_HARMONIC_JUMP_PENALTY
            break
    return cost


def _viterbi_track_pitch(times: list, candidates_per_frame: list, debug: bool = False) -> dict:
    """
    Standard Viterbi DP over the per-frame SRH candidate lists from
    _srh_frame_candidates: forward pass accumulating min cost per state with
    backpointers, then backtrack from the lowest-cost final state.

    Each frame's states = its candidates (emission cost = -normalized score,
    normalized by the track's global max score, mirroring detect_pitch_srh's
    own confidence normalization) plus one silence state (see module-level
    VITERBI_SILENCE_* constants for its cost, gated by the 0.25 voicing
    threshold — same threshold detect_pitch_srh uses).

    Returns {"times", "f0", "voiced", "confidence"} — same shape as
    detect_pitch_srh's output, so it's a drop-in comparison target.
    """
    n_frames = len(candidates_per_frame)
    all_scores = [s for cands in candidates_per_frame for _, s in cands]
    global_max = max(all_scores) if all_scores else 1.0
    if global_max <= 0:
        global_max = 1.0
    voicing_threshold = 0.25  # matches detect_pitch_srh's voicing_threshold

    states = []
    for cands in candidates_per_frame:
        frame_states = [
            {"freq": f, "raw_score": s, "cost": -(s / global_max), "silence": False}
            for f, s in cands
        ]
        any_voiced = any((s / global_max) > voicing_threshold for _, s in cands)
        silence_cost = VITERBI_SILENCE_PREFERRED_COST if not any_voiced else VITERBI_SILENCE_PENALTY_WHEN_VOICED_AVAILABLE
        frame_states.append({"freq": None, "raw_score": 0.0, "cost": silence_cost, "silence": True})
        states.append(frame_states)

    dp = [None] * n_frames
    backptr = [None] * n_frames
    dp[0] = [st["cost"] for st in states[0]]
    backptr[0] = [-1] * len(states[0])

    for t in range(1, n_frames):
        prev_states, cur_states = states[t - 1], states[t]
        dp[t] = [np.inf] * len(cur_states)
        backptr[t] = [0] * len(cur_states)
        for j, cur in enumerate(cur_states):
            best_cost, best_k = np.inf, 0
            for k, prev in enumerate(prev_states):
                cost = dp[t - 1][k] + _viterbi_transition_cost(prev, cur) + cur["cost"]
                if cost < best_cost:
                    best_cost, best_k = cost, k
            dp[t][j] = best_cost
            backptr[t][j] = best_k

    path = [0] * n_frames
    path[-1] = int(np.argmin(dp[-1]))
    for t in range(n_frames - 1, 0, -1):
        path[t - 1] = backptr[t][path[t]]

    f0_out = np.zeros(n_frames)
    confidence_out = np.zeros(n_frames)
    voiced_out = np.zeros(n_frames, dtype=bool)

    for t in range(n_frames):
        st = states[t][path[t]]
        if st["silence"]:
            continue
        f0_out[t] = st["freq"]
        confidence_out[t] = st["raw_score"] / global_max
        voiced_out[t] = True

        if debug and candidates_per_frame[t]:
            greedy_freq, greedy_score = max(candidates_per_frame[t], key=lambda pair: pair[1])
            if abs(greedy_freq - st["freq"]) > 1e-6:
                _log(
                    f"[Viterbi correction] t={times[t]:.3f}s "
                    f"greedy f0={greedy_freq:.2f}Hz (score={greedy_score:.4f}) -> "
                    f"viterbi f0={st['freq']:.2f}Hz (score={st['raw_score']:.4f})"
                )

    return {
        "times": times,
        "f0": f0_out.tolist(),
        "voiced": voiced_out.tolist(),
        "confidence": confidence_out.tolist(),
    }


def detect_pitch_srh_viterbi(
    audio: np.ndarray, sr: int, debug: bool = False, weighting: str = SRH_HARMONIC_WEIGHTING
) -> dict:
    """
    SRH + Viterbi track-level path selection, for offline A/B comparison
    against plain detect_pitch_srh. Not wired into process_song(). Runs
    _srh_frame_candidates then _viterbi_track_pitch, then applies the SAME
    median-filter + Gaussian smoothing detect_pitch_srh uses (the DP and the
    smoothing solve different problems — the DP is about disambiguating
    which candidate is right per frame, smoothing is about jitter within an
    already-correct contour — so both stay in the pipeline).

    weighting: see SRH_HARMONIC_WEIGHTING — passed through to the underlying
    score computation only; the DP/dedup/margin logic are untouched by it.
    """
    frame_data = _srh_frame_candidates(audio, sr, weighting=weighting)
    result = _viterbi_track_pitch(frame_data["times"], frame_data["candidates"], debug=debug)

    f0 = np.array(result["f0"])
    voiced = np.array(result["voiced"])
    f0_smooth = f0.copy()
    voiced_indices = np.where(voiced)[0]

    if len(voiced_indices) > 3:
        f0_smooth[voiced_indices] = median_filter(f0[voiced_indices], size=6)
        f0_smooth[voiced_indices] = gaussian_filter1d(f0_smooth[voiced_indices], sigma=1.5)

    return {
        "times": result["times"],
        "f0": f0_smooth.tolist(),
        "voiced": result["voiced"],
        "confidence": result["confidence"],
    }


def _autocorrelate_pitch(buf: np.ndarray, sr: int) -> tuple:
    """
    Port of PitchDetector._autocorrelate in src/audio/pitchDetector.ts (the
    live-mic detector), with one correctness fix: peak selection after the
    first dip now follows the McLeod Pitch Method's actual key-maximum rule
    (McLeod & Wyvill 2005) instead of the original's plain "take the single
    highest point from d to the end" — the latter is prone to locking onto a
    later, larger-lag peak (i.e. a lower false octave) when a strong formant
    or harmonic gives it a marginally higher score than the true fundamental's
    peak. Same RMS gate, silent-edge trim, VoceVista-matching clarity gate
    (0.25), and parabolic sub-sample interpolation as before.
    Returns (freq_hz, clarity); freq is -1 when the frame is judged unvoiced.
    """
    SIZE = len(buf)

    rms = np.sqrt(np.mean(buf ** 2))
    if rms < 0.01:
        return -1.0, 0.0

    r1, r2 = 0, SIZE - 1
    half = SIZE // 2
    for i in range(half):
        if abs(buf[i]) < 0.2:
            r1 = i
            break
    for i in range(1, half):
        if abs(buf[SIZE - i]) < 0.2:
            r2 = SIZE - i
            break
    trimmed = buf[r1:r2]
    length = len(trimmed)
    if length < 2:
        return -1.0, 0.0

    # c[i] = sum_j trimmed[j]*trimmed[j+i] for i = 0..length-1 — same
    # definition as the JS double loop, computed via FFT correlation.
    c_full = correlate(trimmed, trimmed, mode='full', method='fft')
    c = c_full[length - 1:]

    d = 0
    while d < len(c) - 1 and c[d] > c[d + 1]:
        d += 1

    # MPM key maxima: every local maximum of c from d to the end of the lag
    # range (the "key maxima" McLeod's paper defines between consecutive
    # positively-sloped zero crossings of the NSDF). We approximate that
    # directly as local maxima of c, and force in c's own max within this
    # range so it's always a candidate even if it sits on a plateau/edge.
    seg = c[d:]
    seg_diffs = np.diff(seg)
    key_mask = np.zeros(len(seg), dtype=bool)
    key_mask[1:-1] = (seg_diffs[:-1] > 0) & (seg_diffs[1:] < 0)
    key_mask[int(np.argmax(seg))] = True
    key_idx = np.where(key_mask)[0]  # ascending -> ascending lag

    if len(key_idx) == 0 or c[0] <= 0:
        return -1.0, 0.0

    nmax = seg[key_idx].max()
    threshold = nmax * MPM_CUTOFF_K
    qualifying = key_idx[seg[key_idx] >= threshold]
    # First (lowest-lag) key maximum clearing the cutoff, per MPM — not nmax's
    # own position, which is what a plain global-max search would pick.
    max_pos = d + qualifying[0]
    max_val = c[max_pos]

    clarity = max_val / c[0]
    if clarity < 0.25:
        return -1.0, clarity

    x1 = c[max_pos - 1] if max_pos - 1 >= 0 else 0.0
    x2 = c[max_pos]
    x3 = c[max_pos + 1] if max_pos + 1 < len(c) else 0.0
    a = (x1 + x3 - 2 * x2) / 2
    b = (x3 - x1) / 2
    shift = -b / (2 * a) if a != 0 else 0.0

    freq = sr / (max_pos + shift)
    if 65 <= freq <= 1400:
        return freq, clarity
    return -1.0, clarity


def detect_pitch_autocorr(y: np.ndarray, sr: int) -> PitchData:
    """
    Direct port of the live-mic autocorrelation detector (src/audio/pitchDetector.ts)
    for offline A/B comparison against detect_pitch_srh. Not an "improved" version —
    no low-pass filtering or other deviation from the frontend implementation.

    Uses the same frame_length/hop_length/target sample rate as detect_pitch_srh so
    the two outputs are frame-aligned and directly diffable index-for-index.
    Debug/evaluation only — not wired into process().
    """
    target_sr = 22050
    if sr != target_sr:
        y = librosa.resample(y, orig_sr=sr, target_sr=target_sr)
        sr = target_sr

    frame_length = 2756  # matches detect_pitch_srh, for frame-aligned comparison
    hop_length = 512     # matches detect_pitch_srh's explicit hop_length
    _log(f"detect_pitch_autocorr: frame_length={frame_length}, hop_length={hop_length}, sr={sr}")

    y_padded = np.pad(y, frame_length // 2, mode='reflect')
    frames = librosa.util.frame(y_padded, frame_length=frame_length, hop_length=hop_length)
    n_frames = frames.shape[1]

    f0 = np.zeros(n_frames)
    clarity = np.zeros(n_frames)
    voiced = np.zeros(n_frames, dtype=bool)

    for i in range(n_frames):
        freq, c = _autocorrelate_pitch(frames[:, i], sr)
        clarity[i] = c
        if freq > 0:
            f0[i] = freq
            voiced[i] = True

    times = librosa.frames_to_time(np.arange(n_frames), sr=sr, hop_length=hop_length)

    return {
        "times": times.tolist(),
        "f0": f0.tolist(),
        "voiced": voiced.tolist(),
        "confidence": clarity.tolist(),
    }


def _detect_key(pitch_hz: np.ndarray, confidence: np.ndarray) -> str:
    valid = (confidence >= CONFIDENCE_THRESHOLD) & (pitch_hz > 0)
    freqs = pitch_hz[valid]
    if len(freqs) < 50:
        return "Unknown"

    midi = 69 + 12 * np.log2(freqs / 440.0)
    pitch_classes = np.round(midi).astype(int) % 12
    histogram = np.bincount(pitch_classes, minlength=12).astype(float)
    histogram /= histogram.sum() + 1e-9

    best_score = -np.inf
    best_key = "C major"
    for shift in range(12):
        rotated = np.roll(histogram, -shift)
        maj_score = np.corrcoef(rotated, MAJOR_PROFILE)[0, 1]
        min_score = np.corrcoef(rotated, MINOR_PROFILE)[0, 1]
        if maj_score > best_score:
            best_score = maj_score
            best_key = f"{NOTE_NAMES[shift]} major"
        if min_score > best_score:
            best_score = min_score
            best_key = f"{NOTE_NAMES[shift]} minor"

    return best_key


def compute_spectrogram(audio: np.ndarray, sr: int) -> dict:
    """
    Sub-semitone energy spectrogram for piano roll display.

    N_SPECTRO_ROWS log-spaced rows covering MIDI 45–84 (A2–C6).
    Row 0 = top (MIDI 84, C6), row N-1 = bottom (MIDI 45, A2).
    Values 0–255 = normalised dB energy (0 = -80 dBFS, 255 = peak).
    Stored as base64-encoded uint8: n_frames × N_SPECTRO_ROWS bytes.
    """
    MIDI_MIN, MIDI_MAX = 45, 84
    N_SPECTRO_ROWS = 160  # 4 sub-rows per semitone → ~1.5 px per row at 240 px canvas

    fft_size = 4096
    hop_length = 512
    window = chebwin(fft_size, at=100)

    stft = np.abs(librosa.stft(
        audio,
        n_fft=fft_size,
        hop_length=hop_length,
        window=window,
        center=True,
    ))  # (fft_size//2+1, n_frames)

    freqs = librosa.fft_frequencies(sr=sr, n_fft=fft_size)
    n_frames = stft.shape[1]
    times = librosa.frames_to_time(np.arange(n_frames), sr=sr, hop_length=hop_length)

    row_width_semitones = (MIDI_MAX - MIDI_MIN) / (N_SPECTRO_ROWS - 1)

    result = np.zeros((n_frames, N_SPECTRO_ROWS), dtype=np.float32)
    for ri in range(N_SPECTRO_ROWS):
        midi_float = MIDI_MAX - (ri / (N_SPECTRO_ROWS - 1)) * (MIDI_MAX - MIDI_MIN)
        f_center = 440.0 * 2.0 ** ((midi_float - 69) / 12.0)
        f_lo = f_center * 2.0 ** (-row_width_semitones / 2.0 / 12.0)
        f_hi = f_center * 2.0 ** (row_width_semitones / 2.0 / 12.0)
        mask = (freqs >= f_lo) & (freqs < f_hi)
        if mask.any():
            result[:, ri] = stft[mask, :].mean(axis=0)

    ref_val = result.max() + 1e-8
    result_db = librosa.amplitude_to_db(result, ref=ref_val, top_db=80)
    result_u8 = np.clip((result_db + 80.0) / 80.0 * 255.0, 0, 255).astype(np.uint8)

    return {
        "spectroTimes": times.tolist(),
        "spectroB64": base64.b64encode(result_u8.tobytes()).decode("ascii"),
        "spectroFrames": n_frames,
        "spectroRows": N_SPECTRO_ROWS,
    }


def process(input_path: str, output_dir: str, on_progress=None, high_quality: bool = False) -> dict:
    """Full processing pipeline for an uploaded song.

    high_quality: use htdemucs_ft (fine-tuned, ~2-3x slower, better isolation)
      instead of htdemucs (fast, standard quality).
    """
    if on_progress is None:
        on_progress = lambda v, s: None

    os.makedirs(output_dir, exist_ok=True)

    # ===================================================================
    # Stage 1: Demucs stem separation (0.00 – 0.50)
    # ===================================================================
    on_progress(0.0, "stem-separation")
    _log("Loading Demucs model...")

    import torch
    from demucs.pretrained import get_model
    from demucs.apply import apply_model
    from demucs.audio import AudioFile

    model_name = "htdemucs_ft" if high_quality else "htdemucs"
    model = get_model(model_name)
    model.eval()
    on_progress(0.05, "stem-separation")

    wav = AudioFile(input_path).read(
        streams=0, samplerate=model.samplerate, channels=model.audio_channels
    )
    ref = wav.mean(0)
    wav = (wav - ref.mean()) / ref.std()
    on_progress(0.10, "stem-separation")

    _log("Running Demucs separation...")
    with torch.no_grad():
        sources = apply_model(model, wav[None], progress=False)[0]
    on_progress(0.45, "stem-separation")

    source_names = model.sources
    vocals_idx = source_names.index("vocals")
    vocals_tensor = sources[vocals_idx]
    instrumental_tensor = sum(
        sources[i] for i in range(len(source_names)) if i != vocals_idx
    )

    vocals_tensor = vocals_tensor * ref.std() + ref.mean()
    instrumental_tensor = instrumental_tensor * ref.std() + ref.mean()

    vocals_path = os.path.join(output_dir, "vocals.wav")
    instrumental_path = os.path.join(output_dir, "instrumental.wav")
    sf.write(vocals_path, vocals_tensor.numpy().T, model.samplerate)
    sf.write(instrumental_path, instrumental_tensor.numpy().T, model.samplerate)
    on_progress(0.50, "stem-separation")

    _log("Freeing Demucs from memory...")
    del model, sources, wav, ref, vocals_tensor, instrumental_tensor
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    # ===================================================================
    # Stage 2: pyin pitch extraction (0.50 – 0.70)
    # ===================================================================
    on_progress(0.50, "pitch-extraction")
    _log("Running pitch detection (SRH)...")

    pitch_result = {"times": [], "f0": [], "voiced": [], "confidence": []}
    spectro_result = {"spectroTimes": [], "spectroB64": "", "spectroFrames": 0}

    try:
        vocals_mono, sr_pyin = librosa.load(vocals_path, sr=22050, mono=True)
        pitch_result = detect_pitch_srh(vocals_mono, sr_pyin)
        n_voiced = sum(pitch_result["voiced"])
        _log(f"Pitch detection complete: {n_voiced} voiced frames")

    except Exception as e:
        _log(f"pyin error: {e}\n{traceback.format_exc()}")

    on_progress(0.68, "pitch-extraction")

    # ===================================================================
    # Stage 2b: Spectrogram (0.68 – 0.76)
    # ===================================================================
    on_progress(0.68, "spectrogram")
    _log("Computing spectrogram...")

    try:
        spectro_result = compute_spectrogram(vocals_mono, sr_pyin)
        _log(f"Spectrogram complete: {spectro_result['spectroFrames']} frames")
    except Exception as e:
        _log(f"Spectrogram error: {e}\n{traceback.format_exc()}")

    del vocals_mono
    on_progress(0.76, "spectrogram")
    gc.collect()

    # ===================================================================
    # Stage 3: Onset detection (0.76 – 0.84)
    # ===================================================================
    on_progress(0.76, "onset-detection")
    _log("Detecting onsets...")

    vocals_lr, sr_lr = librosa.load(vocals_path, sr=SAMPLE_RATE, mono=True)
    onset_frames = librosa.onset.onset_detect(y=vocals_lr, sr=sr_lr, units="frames")
    onsets = librosa.frames_to_time(onset_frames, sr=sr_lr).tolist()
    onsets = [round(t, 4) for t in onsets]
    on_progress(0.84, "onset-detection")

    # ===================================================================
    # Stage 4: Dynamics / RMS (0.84 – 0.90)
    # ===================================================================
    on_progress(0.84, "dynamics")
    _log("Computing dynamics...")

    rms = librosa.feature.rms(y=vocals_lr)[0]
    rms_times = librosa.frames_to_time(np.arange(len(rms)), sr=sr_lr)
    dynamics = [
        {"time": round(float(rms_times[i]), 4), "rms": round(float(rms[i]), 6)}
        for i in range(len(rms))
    ]
    on_progress(0.90, "dynamics")

    # ===================================================================
    # Stage 5: BPM detection (0.90 – 0.95)
    # ===================================================================
    on_progress(0.90, "bpm-detection")
    _log("Estimating BPM...")

    full_mix, sr_full = librosa.load(input_path, sr=SAMPLE_RATE, mono=True)
    tempo = librosa.beat.tempo(y=full_mix, sr=sr_full)
    detected_bpm = round(float(tempo[0]), 1) if len(tempo) > 0 else None
    on_progress(0.95, "bpm-detection")

    del full_mix, vocals_lr
    gc.collect()

    # ===================================================================
    # Stage 6: Key detection (0.95 – 1.0)
    # ===================================================================
    on_progress(0.95, "key-detection")
    _log("Detecting key...")

    if any(pitch_result["voiced"]):
        detected_key = _detect_key(
            np.array(pitch_result["f0"]),
            np.array(pitch_result["confidence"]),
        )
    else:
        detected_key = "Unknown"

    on_progress(1.0, "complete")
    _log("Processing complete.")

    return {
        "vocals": vocals_path,
        "instrumental": instrumental_path,
        "pitchData": pitch_result,
        "onsets": onsets,
        "dynamics": dynamics,
        "detectedBpm": detected_bpm,
        "detectedKey": detected_key,
        **spectro_result,
    }


def pitch_shift_song(song_dir: str, cache_dir: str, n_steps: float, on_progress=None):
    """Pitch-shift vocals.wav and instrumental.wav by n_steps semitones.

    Results are written to cache_dir/vocals.wav and cache_dir/instrumental.wav.
    Uses the phase vocoder so tempo is preserved.
    """
    if on_progress is None:
        on_progress = lambda v, s: None

    tracks = ["vocals.wav", "instrumental.wav"]
    paths = {}

    for i, name in enumerate(tracks):
        input_path = os.path.join(song_dir, name)
        output_path = os.path.join(cache_dir, name)

        on_progress(i / len(tracks), f"loading-{name}")
        audio, sr = librosa.load(input_path, sr=None, mono=False)

        on_progress((i + 0.5) / len(tracks), f"shifting-{name}")
        if audio.ndim == 1:
            shifted = librosa.effects.pitch_shift(
                audio, sr=sr, n_steps=n_steps, res_type="kaiser_fast"
            )
        else:
            shifted = np.stack([
                librosa.effects.pitch_shift(
                    audio[ch], sr=sr, n_steps=n_steps, res_type="kaiser_fast"
                )
                for ch in range(audio.shape[0])
            ])

        sf.write(output_path, shifted.T if shifted.ndim > 1 else shifted, sr)
        paths[name] = output_path
        del audio, shifted
        gc.collect()

    on_progress(1.0, "complete")
    return {
        "vocalsPath": paths["vocals.wav"],
        "instrumentalPath": paths["instrumental.wav"],
    }
