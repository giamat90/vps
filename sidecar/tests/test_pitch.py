import re
from pathlib import Path

import numpy as np
import pytest

import processor
from helpers import cents, glide, harmonic_tone, sine, vibrato_tone, voiced_median, white_noise

SR = 22050


def check_schema(result):
    n = len(result["times"])
    assert n > 0
    assert len(result["f0"]) == len(result["voiced"]) == len(result["confidence"]) == n
    f0 = np.array(result["f0"])
    voiced = np.array(result["voiced"], dtype=bool)
    assert np.all(f0[~voiced] == 0), "unvoiced frames carry f0 = 0"
    assert np.all(np.diff(result["times"]) > 0), "time axis is strictly increasing"
    assert np.all(np.isfinite(f0))


class TestRegistry:
    def test_known_names_resolve_to_their_functions(self):
        assert processor.get_pitch_fn("srh") is processor.detect_pitch_srh
        assert processor.get_pitch_fn("pyin") is processor.detect_pitch
        assert processor.get_pitch_fn("hps") is processor.detect_pitch_hps
        assert processor.get_pitch_fn("praat") is processor.detect_pitch_praat
        assert processor.get_pitch_fn("crepe") is processor.detect_pitch_crepe
        assert processor.get_pitch_fn("piano") is processor.detect_pitch_piano

    @pytest.mark.parametrize("value", [None, "", "SRH", "nonsense", "yin"])
    def test_unknown_or_missing_falls_back_to_srh(self, value):
        assert processor.get_pitch_fn(value) is processor.detect_pitch_srh

    @staticmethod
    def _rust_pitch_module():
        return (Path(__file__).resolve().parents[2] / "src-tauri" / "src" / "pitch.rs").read_text(encoding="utf-8")

    def test_rust_algorithm_list_matches_the_backend(self):
        rs = self._rust_pitch_module()
        listed = re.search(r"EXPERIMENTAL: \[&str; \d+\] = \[(.*?)\]", rs, re.S).group(1)
        rust = set(re.findall(r'"(\w+)"', listed))
        backend = set(processor.PITCH_ALGORITHMS) - {"piano"}
        assert rust == backend, "piano is backend-only (forced for instrument imports)"

    def test_the_shipped_default_is_what_the_sidecar_falls_back_to(self):
        rs = self._rust_pitch_module()
        default = re.search(r'pub const DEFAULT: &str = "(\w+)"', rs).group(1)
        assert processor.get_pitch_fn(default) is processor.get_pitch_fn(None)
        assert processor.get_pitch_fn(None) is processor.detect_pitch_srh


class TestSRH:
    @pytest.mark.parametrize("f0", [110.0, 196.0, 261.63, 440.0, 659.25])
    def test_tracks_a_steady_voice_like_tone_within_a_few_cents(self, f0):
        r = processor.detect_pitch_srh(harmonic_tone(f0, SR, 2.0), SR)
        check_schema(r)
        assert np.mean(r["voiced"]) > 0.7
        assert abs(cents(voiced_median(r), f0)) < 25

    def test_a_noisy_voice_is_still_called_voiced(self):
        x = harmonic_tone(220.0, SR, 2.0) + white_noise(SR, 2.0, amp=0.12, seed=4)
        r = processor.detect_pitch_srh(x.astype(np.float32), SR)
        assert np.mean(r["voiced"]) > 0.6
        assert abs(cents(voiced_median(r), 220.0)) < 40

    def test_resamples_other_input_rates(self):
        r = processor.detect_pitch_srh(harmonic_tone(220.0, 44100, 2.0), 44100)
        assert abs(cents(voiced_median(r), 220.0)) < 25

    def test_prefers_the_fundamental_when_the_second_harmonic_dominates(self):
        sr = SR
        t = np.arange(sr * 2) / sr
        x = 0.25 * np.sin(2 * np.pi * 200 * t) + 0.5 * np.sin(2 * np.pi * 400 * t) + 0.3 * np.sin(2 * np.pi * 600 * t) + 0.2 * np.sin(2 * np.pi * 800 * t)
        r = processor.detect_pitch_srh(x.astype(np.float32), sr)
        assert abs(cents(voiced_median(r), 200.0)) < 50, "must not lock onto the strong 2nd harmonic"

    def test_follows_a_glide(self):
        x = glide(200.0, 300.0, SR, 3.0)
        r = processor.detect_pitch_srh(x, SR)
        times = np.array(r["times"])
        f0 = np.array(r["f0"])
        voiced = np.array(r["voiced"], dtype=bool)
        idx = np.where(voiced & (times > 0.3) & (times < 2.7))[0]
        expected = 200.0 + 100.0 * times[idx] / 3.0
        assert np.median(np.abs(cents(f0[idx], expected))) < 60

    def test_silence_is_entirely_unvoiced(self):
        r = processor.detect_pitch_srh(np.zeros(SR * 2, dtype=np.float32), SR)
        check_schema(r)
        assert not any(r["voiced"])
        assert max(r["confidence"]) == 0

    def test_a_quiet_signal_below_minus_50_dbfs_is_skipped(self):
        r = processor.detect_pitch_srh(harmonic_tone(220.0, SR, 1.0, amp=1e-4), SR)
        assert not any(r["voiced"])

    def test_confidence_is_normalised_to_the_unit_interval(self):
        r = processor.detect_pitch_srh(harmonic_tone(220.0, SR, 1.5), SR)
        c = np.array(r["confidence"])
        assert c.min() >= 0 and c.max() == pytest.approx(1.0)

    def test_frame_hop_is_512_samples(self):
        r = processor.detect_pitch_srh(harmonic_tone(220.0, SR, 1.0), SR)
        assert r["times"][1] - r["times"][0] == pytest.approx(512 / SR)

    def test_deterministic(self):
        x = harmonic_tone(220.0, SR, 1.0)
        a, b = processor.detect_pitch_srh(x, SR), processor.detect_pitch_srh(x, SR)
        assert a == b


def candidate_table(rows):
    """rows: per frame a list of (freq, score) pairs, or None for a frame with no candidate.
    Returns the (n, k) cand_f / cand_s arrays _viterbi_pick expects: best-first, NaN-padded."""
    k = max((len(r) for r in rows if r), default=1)
    f = np.full((len(rows), k), np.nan)
    s = np.zeros((len(rows), k))
    for i, row in enumerate(rows):
        for j, (freq, score) in enumerate(sorted(row or [], key=lambda p: -p[1])):
            f[i, j], s[i, j] = freq, score
    return f, s


def chosen_freqs(rows, beta=0.1):
    f, s = candidate_table(rows)
    idx = processor._viterbi_pick(f, s, beta)
    return np.array([f[i, j] if j >= 0 else np.nan for i, j in enumerate(idx)]), idx


class TestSRHCandidates:
    GRID = np.arange(65.0, 1400.0, 0.5)

    def curve(self, peaks, width=2.0):
        return sum(h * np.exp(-0.5 * ((self.GRID - f) / width) ** 2) for f, h in peaks)

    def test_returns_the_peaks_best_first(self):
        freq, score = processor._srh_candidates(self.curve([(330.0, 0.3), (220.0, 1.0), (440.0, 0.6)]), self.GRID, 5, 10)
        assert np.allclose(freq, [220.0, 440.0, 330.0], atol=0.3)
        assert list(score) == sorted(score, reverse=True)

    def test_is_limited_to_the_requested_number(self):
        peaks = [(100.0 * k, 1.0 / k) for k in range(1, 9)]
        freq, _ = processor._srh_candidates(self.curve(peaks), self.GRID, 3, 10)
        assert len(freq) == 3

    def test_peaks_closer_than_the_gap_collapse_into_the_stronger(self):
        freq, _ = processor._srh_candidates(self.curve([(220.0, 1.0), (223.0, 0.8)], width=0.8), self.GRID, 5, 10)
        assert len(freq) == 1
        assert abs(freq[0] - 220.0) < 0.5

    def test_interpolates_between_grid_points(self):
        freq, _ = processor._srh_candidates(self.curve([(220.2, 1.0)]), self.GRID, 5, 10)
        assert abs(freq[0] - 220.2) < 0.15

    def test_an_argmax_on_the_grid_edge_is_still_a_candidate(self):
        decaying = np.exp(-(self.GRID - 65.0) / 40.0)
        freq, _ = processor._srh_candidates(decaying, self.GRID, 5, 10)
        assert freq[0] == pytest.approx(65.0)

    def test_scores_that_are_not_positive_give_no_candidates(self):
        freq, score = processor._srh_candidates(-np.abs(self.curve([(220.0, 1.0)])) - 0.1, self.GRID, 5, 10)
        assert len(freq) == 0 and len(score) == 0


class TestViterbiPick:
    def test_without_competition_it_is_the_per_frame_best(self):
        out, idx = chosen_freqs([[(220.0, 1.0), (330.0, 0.4)], [(240.0, 0.9), (480.0, 0.8)], [(260.0, 1.0)]])
        assert list(out) == [220.0, 240.0, 260.0]
        assert list(idx) == [0, 0, 0]

    def test_a_lone_stronger_octave_is_overruled_by_its_neighbours(self):
        rows = [[(220.0, 1.0), (440.0, 0.5)]] * 10
        rows[5] = [(440.0, 1.0), (220.0, 0.9)]
        out, _ = chosen_freqs(rows)
        assert np.all(out == 220.0)

    def test_a_sustained_stronger_octave_still_wins(self):
        rows = [[(220.0, 1.0), (440.0, 0.5)]] * 5 + [[(440.0, 1.0), (220.0, 0.3)]] * 10
        out, _ = chosen_freqs(rows)
        assert np.all(out[:5] == 220.0)
        assert np.all(out[5:] == 440.0)

    def test_a_frame_without_candidates_is_minus_one_and_resets_the_path(self):
        rows = [[(220.0, 1.0), (440.0, 0.95)]] * 5 + [None] + [[(440.0, 1.0), (220.0, 0.95)]] * 5
        out, idx = chosen_freqs(rows)
        assert idx[5] == -1
        assert np.all(out[:5] == 220.0)
        assert np.all(out[6:] == 440.0), "a run after a gap starts fresh instead of inheriting the old octave"

    def test_never_picks_a_padding_candidate(self):
        f, s = candidate_table([[(200.0, 1.0)], [(210.0, 1.0), (420.0, 0.9), (105.0, 0.8)], [(205.0, 1.0)]])
        idx = processor._viterbi_pick(f, s, 0.1)
        assert all(not np.isnan(f[i, j]) for i, j in enumerate(idx))

    def test_an_empty_table_returns_an_empty_choice(self):
        assert len(processor._viterbi_pick(np.empty((0, 5)), np.empty((0, 5)), 0.1)) == 0


class TestSmoothVoicedRuns:
    def test_removes_an_isolated_blip_inside_a_run(self):
        f0 = np.full(40, 220.0)
        f0[20] = 440.0
        out = processor._smooth_voiced_runs(f0, np.ones(40, dtype=bool))
        assert np.all(out == 220.0)

    def test_does_not_blend_across_an_unvoiced_gap(self):
        f0 = np.zeros(60)
        f0[:25] = 200.0
        f0[35:] = 400.0
        out = processor._smooth_voiced_runs(f0, f0 > 0)
        assert np.all(out[:25] == 200.0)
        assert np.all(out[35:] == 400.0)
        assert np.all(out[25:35] == 0.0)

    def test_a_note_step_inside_a_run_is_not_blurred(self):
        f0 = np.concatenate([np.full(20, 200.0), np.full(20, 300.0)])
        out = processor._smooth_voiced_runs(f0, np.ones(40, dtype=bool))
        assert set(np.unique(out)) <= {200.0, 300.0}

    def test_runs_shorter_than_three_frames_pass_through(self):
        f0 = np.array([0.0, 200.0, 210.0, 0.0, 0.0, 300.0, 0.0])
        assert np.array_equal(processor._smooth_voiced_runs(f0, f0 > 0), f0)

    def test_does_not_modify_its_input_and_keeps_unvoiced_zero(self):
        f0 = np.zeros(30)
        f0[5:25] = 200.0
        f0[10] = 400.0
        before = f0.copy()
        out = processor._smooth_voiced_runs(f0, f0 > 0)
        assert np.array_equal(f0, before)
        assert np.all(out[f0 == 0] == 0)

    def test_keeps_clearly_more_of_a_vibrato_contour_than_the_gaussian_smoother(self):
        t = np.arange(200) * 512 / SR
        f0 = 220 * 2 ** (30 * np.sin(2 * np.pi * 5.5 * t) / 1200)
        voiced = np.ones(200, dtype=bool)

        def depth(x):
            return np.ptp(1200 * np.log2(x / 220))

        kept = depth(processor._smooth_voiced_runs(f0, voiced)) / depth(f0)
        legacy = depth(processor._smooth_voiced(f0, voiced)) / depth(f0)
        assert kept > 0.6, f"a 5-frame median keeps ~68% of a 5.5 Hz vibrato, got {kept:.0%}"
        assert kept > legacy + 0.15


class TestHarmonicContrast:
    BIN = SR / 4096

    def spectrum_with_partials(self, f0, level=1.0, floor=0.0, n=7):
        s = np.full(2049, floor)
        for k in range(1, n + 1):
            s[int(round(k * f0 / self.BIN))] = level
        return s

    def test_a_clean_harmonic_series_scores_near_one(self):
        c = processor._harmonic_contrast(self.spectrum_with_partials(220.0), np.array([220.0]), self.BIN, 7)
        assert c[0] > 0.95

    def test_a_flat_spectrum_scores_near_zero(self):
        c = processor._harmonic_contrast(np.full(2049, 0.3), np.array([220.0]), self.BIN, 7)
        assert abs(c[0]) < 0.05

    def test_energy_between_the_partials_lowers_it(self):
        clean = processor._harmonic_contrast(self.spectrum_with_partials(220.0), np.array([220.0]), self.BIN, 7)[0]
        dirty = processor._harmonic_contrast(self.spectrum_with_partials(220.0, floor=0.2), np.array([220.0]), self.BIN, 7)[0]
        assert dirty < clean

    def test_scores_each_candidate_separately(self):
        spec = self.spectrum_with_partials(220.0)
        c = processor._harmonic_contrast(spec, np.array([220.0, 300.0]), self.BIN, 7)
        assert c[0] > 0.9 > c[1]


class TestSRHOnSeparatedStems:
    """Regressions from the 2026-10-11 pitch_lab study on Demucs-separated vocals."""

    @staticmethod
    def voiced_runs(r):
        v = np.array(r["voiced"], dtype=bool)
        idx = np.where(v)[0]
        return np.split(idx, np.where(np.diff(idx) > 1)[0] + 1) if len(idx) else []

    def test_the_first_frames_after_a_gap_are_not_dragged_toward_the_previous_note(self):
        x = np.concatenate([harmonic_tone(200.0, SR, 0.8), np.zeros(int(SR * 0.3), np.float32), harmonic_tone(300.0, SR, 0.8)])
        r = processor.detect_pitch_srh(x, SR)
        runs = [run for run in self.voiced_runs(r) if len(run) > 10]
        assert len(runs) == 2
        f0 = np.array(r["f0"])
        assert np.all(np.abs(cents(f0[runs[0][-3:]], 200.0)) < 40)
        assert np.all(np.abs(cents(f0[runs[1][:3]], 300.0)) < 40)

    def test_a_note_change_is_a_step_not_a_ramp(self):
        x = np.concatenate([harmonic_tone(200.0, SR, 0.8), harmonic_tone(300.0, SR, 0.8)])
        f0 = np.array(processor.detect_pitch_srh(x, SR)["f0"])
        mid = f0[(np.arange(len(f0)) * 512 / SR > 0.3) & (np.arange(len(f0)) * 512 / SR < 1.3)]
        between = (mid > 215) & (mid < 285)
        assert between.sum() <= 6, "at most the frames whose analysis window straddles the change"

    def test_pure_noise_is_unvoiced(self):
        r = processor.detect_pitch_srh(white_noise(SR, 2.0, amp=0.3, seed=3), SR)
        check_schema(r)
        assert np.mean(r["voiced"]) < 0.1

    def test_a_loud_noise_burst_between_notes_is_unvoiced(self):
        x = np.concatenate([harmonic_tone(220.0, SR, 1.0), white_noise(SR, 1.0, amp=0.3, seed=5), harmonic_tone(220.0, SR, 1.0)])
        r = processor.detect_pitch_srh(x, SR)
        t = np.array(r["times"])
        v = np.array(r["voiced"], dtype=bool)
        assert v[(t > 0.2) & (t < 0.9)].mean() > 0.9
        assert v[(t > 1.2) & (t < 1.8)].mean() < 0.15
        assert v[(t > 2.2) & (t < 2.8)].mean() > 0.9

    def test_vibrato_depth_survives_detection(self):
        x = vibrato_tone(220.0, SR, 3.0, rate_hz=5.5, depth_cents=50)
        r = processor.detect_pitch_srh(x, SR)
        t = np.array(r["times"])
        f0 = np.array(r["f0"])
        sel = (np.array(r["voiced"], dtype=bool)) & (t > 0.4) & (t < 2.6)
        depth = np.ptp(cents(f0[sel], 220.0))
        assert depth > 55, f"a +-50 cent vibrato is 100 cents peak to peak (71 now, 32 with the Gaussian smoother), got {depth:.0f}"

    def test_confidence_keeps_the_track_max_normalised_meaning(self):
        # DualTuner/PianoRoll/key and vibrato detection threshold this field (0.3 / 0.5)
        x = np.concatenate([harmonic_tone(220.0, SR, 1.0, amp=0.4), harmonic_tone(220.0, SR, 1.0, amp=0.05)])
        c = np.array(processor.detect_pitch_srh(x, SR)["confidence"])
        assert c.max() == pytest.approx(1.0)
        assert np.mean(c[c > 0]) > 0.3


class TestOtherAlgorithms:
    def test_hps_finds_the_fundamental(self):
        r = processor.detect_pitch_hps(harmonic_tone(220.0, SR, 2.0), SR)
        check_schema(r)
        assert abs(cents(voiced_median(r), 220.0)) < 60

    def test_pyin_finds_the_fundamental(self):
        r = processor.detect_pitch(harmonic_tone(220.0, SR, 2.0), SR)
        check_schema(r)
        assert abs(cents(voiced_median(r), 220.0)) < 40

    def test_praat_finds_the_fundamental(self):
        pytest.importorskip("parselmouth")
        r = processor.detect_pitch_praat(harmonic_tone(220.0, SR, 2.0), SR)
        check_schema(r)
        assert abs(cents(voiced_median(r), 220.0)) < 40

    def test_piano_reaches_the_low_register_a_voice_detector_cannot(self):
        r = processor.detect_pitch_piano(harmonic_tone(55.0, SR, 3.0), SR)
        check_schema(r)
        assert abs(cents(voiced_median(r), 55.0)) < 60

    def test_piano_reaches_the_top_octaves(self):
        r = processor.detect_pitch_piano(sine(1760.0, SR, 2.0, amp=0.5), SR)
        assert abs(cents(voiced_median(r), 1760.0)) < 60

    @pytest.mark.slow
    def test_crepe_finds_the_fundamental(self):
        pytest.importorskip("torchcrepe")
        r = processor.detect_pitch_crepe(harmonic_tone(220.0, SR, 1.5), SR)
        check_schema(r)
        assert abs(cents(voiced_median(r), 220.0)) < 60


class TestSmoothing:
    def test_removes_an_isolated_octave_blip_but_keeps_the_contour(self):
        f0 = np.full(60, 220.0)
        f0[30] = 440.0
        voiced = np.ones(60, dtype=bool)
        out = processor._smooth_voiced(f0, voiced)
        assert out[30] < 235
        assert np.all(np.abs(out - 220) < 20)

    def test_leaves_unvoiced_frames_untouched(self):
        f0 = np.zeros(40)
        f0[10:30] = 200.0
        voiced = f0 > 0
        out = processor._smooth_voiced(f0, voiced)
        assert np.all(out[~voiced] == 0)

    def test_too_few_voiced_frames_pass_through_unchanged(self):
        f0 = np.array([0.0, 200.0, 0.0, 210.0, 0.0, 220.0, 0.0])
        voiced = f0 > 0
        assert np.array_equal(processor._smooth_voiced(f0, voiced), f0)

    def test_does_not_modify_its_input(self):
        f0 = np.full(30, 200.0)
        f0[5] = 400.0
        before = f0.copy()
        processor._smooth_voiced(f0, np.ones(30, dtype=bool))
        assert np.array_equal(f0, before)

    @pytest.mark.xfail(
        reason="Known: median(6)+gaussian(1.5) keeps only ~40% of a 5.5 Hz vibrato's depth, "
        "so the reported vibrato depth is under-stated. The docstring claims the shape is preserved.",
        strict=False,
    )
    def test_preserves_a_vibrato_shaped_contour(self):
        t = np.arange(200) * 512 / SR
        f0 = 220 * 2 ** (30 * np.sin(2 * np.pi * 5.5 * t) / 1200)
        out = processor._smooth_voiced(f0, np.ones(200, dtype=bool))
        depth_in = np.ptp(1200 * np.log2(f0 / 220))
        depth_out = np.ptp(1200 * np.log2(out / 220))
        assert depth_out > 0.6 * depth_in, "smoothing must not flatten real vibrato"


    def test_attenuates_but_does_not_erase_vibrato(self):
        t = np.arange(200) * 512 / SR
        f0 = 220 * 2 ** (30 * np.sin(2 * np.pi * 5.5 * t) / 1200)
        out = processor._smooth_voiced(f0, np.ones(200, dtype=bool))
        ratio = np.ptp(1200 * np.log2(out / 220)) / np.ptp(1200 * np.log2(f0 / 220))
        assert 0.2 < ratio < 1.0


class TestKeyDetection:
    def pitches(self, notes_midi, repeats=20):
        midi = np.array(notes_midi * repeats, dtype=float)
        return 440.0 * 2 ** ((midi - 69) / 12), np.ones(len(midi))

    def test_c_major_scale(self):
        f, c = self.pitches([60, 62, 64, 65, 67, 69, 71, 72, 60, 64, 67])
        assert processor._detect_key(f, c) == "C major"

    def test_a_minor_scale(self):
        f, c = self.pitches([57, 59, 60, 62, 64, 65, 68, 69, 57, 60, 64])
        assert processor._detect_key(f, c) == "A minor"

    def test_transposition_follows(self):
        f, c = self.pitches([n + 2 for n in [60, 62, 64, 65, 67, 69, 71, 72, 60, 64, 67]])
        assert processor._detect_key(f, c) == "D major"

    def test_octave_does_not_matter(self):
        f, c = self.pitches([48, 50, 52, 53, 55, 57, 59, 72, 60, 64, 67, 79])
        assert processor._detect_key(f, c) == "C major"

    def test_too_few_confident_frames_is_unknown(self):
        f, c = self.pitches([60, 62, 64], repeats=10)
        assert processor._detect_key(f, c) == "Unknown"

    def test_low_confidence_and_unvoiced_frames_are_ignored(self):
        f, c = self.pitches([60, 62, 64, 65, 67, 69, 71, 72, 60, 64, 67])
        noise_f = np.full(500, 466.16)
        f2 = np.concatenate([f, noise_f])
        c2 = np.concatenate([c, np.full(500, 0.1)])
        assert processor._detect_key(f2, c2) == "C major"
        f3 = np.concatenate([f, np.zeros(500)])
        c3 = np.concatenate([c, np.ones(500)])
        assert processor._detect_key(f3, c3) == "C major"

    def test_returns_a_valid_label(self):
        rng = np.random.default_rng(1)
        f = 440 * 2 ** ((rng.integers(48, 80, 300) - 69) / 12)
        label = processor._detect_key(f, np.ones(300))
        assert re.fullmatch(r"[A-G]#? (major|minor)", label)

