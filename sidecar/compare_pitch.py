#!/usr/bin/env python3
"""
Debug/evaluation CLI: compares detect_pitch_srh vs detect_pitch_autocorr on the
same vocals stem, frame-for-frame. Not used by process_song() or the app —
run manually against problem songs to evaluate the autocorrelation detector
as a candidate replacement/supplement for SRH.

Usage:
    python compare_pitch.py <vocals.wav> [--out out.csv] [--octave-tol 50] [--viterbi] [--debug]
"""

import argparse
import csv
import sys

import numpy as np
import librosa

from processor import detect_pitch_srh, detect_pitch_srh_viterbi, detect_pitch_autocorr, _log


def cents_diff(f_a: float, f_b: float) -> float:
    return 1200.0 * float(np.log2(f_a / f_b))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("vocals_path", help="Path to a vocals.wav stem")
    parser.add_argument("--out", default=None, help="CSV output path (default: <vocals>.compare.csv)")
    parser.add_argument("--octave-tol", type=float, default=50.0,
                         help="Cents tolerance around 1200 for classifying octave errors (default 50)")
    parser.add_argument("--viterbi", action="store_true",
                         help="Use detect_pitch_srh_viterbi (track-level DP) instead of plain "
                              "detect_pitch_srh for the SRH column")
    parser.add_argument("--debug", action="store_true",
                         help="Pass debug=True through to the SRH detector (margin-bias / Viterbi logs)")
    parser.add_argument("--weighting", choices=["none", "1/n"], default="none",
                         help="SRH harmonic-term weighting scheme (see SRH_HARMONIC_WEIGHTING in processor.py)")
    args = parser.parse_args()

    out_path = args.out or (args.vocals_path.rsplit(".", 1)[0] + ".compare.csv")

    _log(f"Loading {args.vocals_path}...")
    audio, sr = librosa.load(args.vocals_path, sr=22050, mono=True)

    if args.viterbi:
        _log(f"Running SRH + Viterbi (weighting={args.weighting})...")
        srh = detect_pitch_srh_viterbi(audio, sr, debug=args.debug, weighting=args.weighting)
    else:
        _log(f"Running SRH (weighting={args.weighting})...")
        srh = detect_pitch_srh(audio, sr, debug=args.debug, weighting=args.weighting)

    _log("Running autocorrelation port...")
    ac = detect_pitch_autocorr(audio, sr)

    n = min(len(srh["times"]), len(ac["times"]))
    if len(srh["times"]) != len(ac["times"]):
        _log(f"WARNING: frame count mismatch (srh={len(srh['times'])}, autocorr={len(ac['times'])}); "
             f"truncating to {n} for comparison")

    rows = []
    both_voiced_diffs = []   # (cents_diff, is_octave_error)
    n_voiced_srh = 0
    n_voiced_ac = 0

    for i in range(n):
        t = srh["times"][i]
        f0_srh = srh["f0"][i]
        conf_srh = srh["confidence"][i]
        v_srh = bool(srh["voiced"][i])

        f0_ac = ac["f0"][i]
        clarity_ac = ac["confidence"][i]
        v_ac = bool(ac["voiced"][i])

        n_voiced_srh += v_srh
        n_voiced_ac += v_ac

        diff = None
        if v_srh and v_ac and f0_srh > 0 and f0_ac > 0:
            diff = cents_diff(f0_ac, f0_srh)
            is_octave = abs(abs(diff) - 1200.0) <= args.octave_tol
            both_voiced_diffs.append((diff, is_octave))

        rows.append({
            "time": round(t, 4),
            "f0_srh": round(f0_srh, 3),
            "confidence_srh": round(conf_srh, 4),
            "voiced_srh": v_srh,
            "f0_autocorr": round(f0_ac, 3),
            "clarity_autocorr": round(clarity_ac, 4),
            "voiced_autocorr": v_ac,
            "cents_diff": round(diff, 2) if diff is not None else "",
        })

    with open(out_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "time", "f0_srh", "confidence_srh", "voiced_srh",
            "f0_autocorr", "clarity_autocorr", "voiced_autocorr", "cents_diff",
        ])
        writer.writeheader()
        writer.writerows(rows)

    # ---- Console diagnostics ----
    octave_diffs = [d for d, is_oct in both_voiced_diffs if is_oct]
    disagree_diffs = [d for d, is_oct in both_voiced_diffs if not is_oct and abs(d) > 50.0]
    agree_diffs = [abs(d) for d, is_oct in both_voiced_diffs if not is_oct]

    n_both_voiced = len(both_voiced_diffs)

    print(f"\n=== Pitch comparison: {args.vocals_path} ===")
    print(f"Output CSV: {out_path}")
    print(f"Total frames: {n}")
    print(f"Voiced (SRH):        {n_voiced_srh} ({100.0 * n_voiced_srh / n:.1f}%)")
    print(f"Voiced (autocorr):   {n_voiced_ac} ({100.0 * n_voiced_ac / n:.1f}%)")
    print(f"Both voiced:         {n_both_voiced} ({100.0 * n_both_voiced / n:.1f}%)")

    if n_both_voiced > 0:
        print(f"Disagree >50 cents (non-octave): {len(disagree_diffs)} "
              f"({100.0 * len(disagree_diffs) / n_both_voiced:.1f}% of both-voiced)")
        print(f"Octave errors (~1200c +/- {args.octave_tol:.0f}c): {len(octave_diffs)} "
              f"({100.0 * len(octave_diffs) / n_both_voiced:.1f}% of both-voiced)")

        if agree_diffs:
            print(f"Mean |cents diff| (excl. octave errors):   {np.mean(agree_diffs):.2f}")
            print(f"Median |cents diff| (excl. octave errors): {np.median(agree_diffs):.2f}")
        else:
            print("No non-octave both-voiced frames to compute central tendency.")
    else:
        print("No frames where both detectors agree on voicing.")


if __name__ == "__main__":
    sys.exit(main())
