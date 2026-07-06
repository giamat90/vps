"""
Post-detection cleanup of a pitch curve: reject frame-to-frame jumps no
human voice can physically produce (e.g. 200Hz -> 1000Hz within one ~23ms
frame is roughly +2 octaves — vocal folds can't retune that fast), and
interpolate across short outlier gaps in log-frequency (cents) space so the
curve reads as a continuous glide instead of a spurious spike.

Long unvoiced gaps (real pauses/silence between phrases) are deliberately
left alone — only short excursions flagged as physically implausible get
bridged. Filling in a multi-second silence with fabricated pitch would be
worse than the spike it's trying to fix.

Works on the {times, f0, voiced, confidence} dict any algorithm in
algorithms.py returns, so it's detector-agnostic (SRH, pYIN, first-peak all
produce this same shape) — a generic cleanup pass, not a per-algorithm fix.
"""
import numpy as np


def smooth_pitch(
    pitch: dict, *,
    window_frames: int = 7,             # local neighborhood (~160ms at 512-hop/22050Hz) used to judge what's "expected" nearby
    n_sigmas: float = 3.0,               # how many robust std-devs (MAD-based) a frame must deviate to be flagged
    min_deviation_cents: float = 150.0,  # floor so near-constant windows (MAD~0) don't trigger false positives
    max_gap_frames: int = 8,             # only bridge short excursions (~185ms at 512-hop/22050Hz), not real silence
) -> dict:
    times = np.array(pitch["times"])
    f0 = np.array(pitch["f0"], dtype=float)
    voiced = np.array(pitch["voiced"], dtype=bool)
    confidence = np.array(pitch["confidence"], dtype=float)

    n = len(f0)
    valid = voiced & (f0 > 0)
    cents = np.full(n, np.nan)
    cents[valid] = 1200 * np.log2(f0[valid])

    # Hampel filter (local median + MAD) rather than a running "last good
    # anchor": a directional anchor gets permanently stuck once it flags a
    # frame during a genuine sustained glide (every later frame keeps
    # failing against the same stale reference, so a real multi-second
    # declining phrase gets thrown out wholesale instead of just the actual
    # glitches). A local window's median moves WITH a real trend, so a
    # true spike still stands out against its immediate neighbors while a
    # slow real glide doesn't get flagged at all.
    flagged = np.zeros(n, dtype=bool)
    valid_idx = np.where(valid)[0]
    for pos, i in enumerate(valid_idx):
        lo = max(0, pos - window_frames)
        hi = min(len(valid_idx), pos + window_frames + 1)
        neighborhood = cents[valid_idx[lo:hi]]
        med = np.median(neighborhood)
        mad = np.median(np.abs(neighborhood - med)) * 1.4826  # scaled MAD ~ std for normally-distributed data
        threshold = max(n_sigmas * mad, min_deviation_cents)
        if abs(cents[i] - med) > threshold:
            flagged[i] = True

    good = valid & ~flagged

    cents_filled = cents.copy()
    voiced_filled = good.copy()

    good_idx = np.where(good)[0]
    n_bridged = 0
    for a, b in zip(good_idx[:-1], good_idx[1:]):
        gap = b - a
        if 1 < gap <= max_gap_frames:
            cents_filled[a + 1:b] = np.interp(np.arange(a + 1, b), [a, b], [cents[a], cents[b]])
            voiced_filled[a + 1:b] = True
            n_bridged += gap - 1

    f0_filled = np.zeros(n)
    f0_filled[voiced_filled] = 2 ** (cents_filled[voiced_filled] / 1200)

    return {
        "times": times.tolist(),
        "f0": f0_filled.tolist(),
        "voiced": voiced_filled.tolist(),
        "confidence": confidence.tolist(),
        "n_flagged": int(flagged.sum()),
        "n_bridged": n_bridged,
    }
