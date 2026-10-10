import re
from pathlib import Path

import numpy as np
import pytest

import processor
from helpers import cents, glide, harmonic_tone, sine, voiced_median, white_noise

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

    def test_a_frame_is_voiced_exactly_when_its_confidence_clears_the_022_threshold(self):
        x = np.concatenate([harmonic_tone(220.0, SR, 1.0), harmonic_tone(220.0, SR, 1.0) + white_noise(SR, 1.0, amp=0.5, seed=1)])
        r = processor.detect_pitch_srh(x.astype(np.float32), SR)
        conf = np.array(r["confidence"])
        assert np.array_equal(np.array(r["voiced"]), conf > 0.22)
        assert ((conf > 0.22) & (conf < 0.9)).any(), "the noisy half sits between the two thresholds"

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

