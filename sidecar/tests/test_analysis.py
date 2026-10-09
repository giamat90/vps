import os
import shutil
import subprocess

import numpy as np
import pytest
import soundfile as sf

import analysis
from helpers import cents, harmonic_tone, rms_db, sine, vibrato_tone, voiced_median, write_wav

STEP_MS = 512 / 22050 * 1000


class TestRms:
    def test_silence_is_the_floor_value(self):
        assert analysis._rms_dbfs(np.zeros(100, dtype=np.float32)) == -120.0

    def test_full_scale_sine(self):
        assert analysis._rms_dbfs(sine(1000, 44100, 1.0, amp=1.0)) == pytest.approx(-3.01, abs=0.02)

    @pytest.mark.parametrize("amp,db", [(0.5, -9.03), (0.1, -23.01), (0.01, -43.01)])
    def test_scales_with_amplitude(self, amp, db):
        assert analysis._rms_dbfs(sine(1000, 44100, 1.0, amp=amp)) == pytest.approx(db, abs=0.02)

    def test_accepts_integer_samples_without_overflow(self):
        x = (np.sin(np.arange(1000) / 10) * 30000).astype(np.int16)
        assert np.isfinite(analysis._rms_dbfs(x))


class TestVibrato:
    def contour(self, rate, depth_cents, seconds=3.0, f0=220.0, step_ms=STEP_MS):
        t = np.arange(int(seconds * 1000 / step_ms)) * step_ms / 1000
        freq = f0 * 2 ** (depth_cents * np.sin(2 * np.pi * rate * t) / 1200)
        return freq, np.ones_like(freq)

    @pytest.mark.parametrize("rate", [4.5, 5.5, 6.5])
    def test_recovers_the_rate_of_a_regular_vibrato(self, rate):
        f, c = self.contour(rate, 60)
        v = analysis._detect_vibrato(f, c, STEP_MS)
        assert v["rate"] == pytest.approx(rate, abs=0.6)

    def test_depth_is_twice_the_standard_deviation_in_cents(self):
        f, c = self.contour(5.5, 60)
        v = analysis._detect_vibrato(f, c, STEP_MS)
        assert v["depth"] == pytest.approx(60 / np.sqrt(2) * 2, rel=0.2)

    def test_a_regular_vibrato_scores_high_regularity(self):
        f, c = self.contour(5.5, 60)
        assert analysis._detect_vibrato(f, c, STEP_MS)["regularity"] > 0.6

    def test_a_steady_note_has_no_vibrato(self):
        f = np.full(200, 220.0)
        assert analysis._detect_vibrato(f, np.ones(200), STEP_MS) == {"rate": 0.0, "depth": 0.0, "regularity": 0.0}

    def test_a_shallow_wobble_below_10_cents_is_rejected(self):
        f, c = self.contour(5.5, 4)
        assert analysis._detect_vibrato(f, c, STEP_MS)["rate"] == 0.0

    def test_too_few_confident_frames_gives_zeros(self):
        f, c = self.contour(5.5, 60, seconds=3.0)
        c[:] = 0.1
        c[:50] = 1.0
        assert analysis._detect_vibrato(f, c, STEP_MS)["rate"] == 0.0

    def test_unvoiced_gaps_are_bridged_by_interpolation(self):
        f, c = self.contour(5.5, 60, seconds=4.0)
        f[40:46] = 0.0
        v = analysis._detect_vibrato(f, c, STEP_MS)
        assert v["rate"] == pytest.approx(5.5, abs=0.7)

    def test_a_contour_too_short_to_cover_two_periods_gives_zeros(self):
        f, c = self.contour(5.5, 60, seconds=1.0)
        assert analysis._detect_vibrato(f, c, STEP_MS)["rate"] == 0.0

    def test_values_are_rounded_for_the_wire_format(self):
        f, c = self.contour(5.5, 60)
        v = analysis._detect_vibrato(f, c, STEP_MS)
        assert v["rate"] == round(v["rate"], 2)
        assert v["depth"] == round(v["depth"], 1)
        assert v["regularity"] == round(v["regularity"], 3)

    def test_does_not_modify_its_input(self):
        f, c = self.contour(5.5, 60)
        f[10] = 0.0
        before = f.copy()
        analysis._detect_vibrato(f, c, STEP_MS)
        assert np.array_equal(f, before)


class TestConvertTake:
    def test_writes_a_wav_with_the_native_rate_and_channels(self, tmp_path):
        stereo = np.stack([sine(300, 32000, 1.0), sine(500, 32000, 1.0)], axis=1)
        src = tmp_path / "in.wav"
        sf.write(str(src), stereo, 32000)
        out = tmp_path / "out.wav"
        assert analysis.convert_take_to_wav(str(src), str(out)) == {"path": str(out)}
        data, sr = sf.read(str(out))
        assert sr == 32000 and data.shape == stereo.shape

    def test_mono_stays_mono(self, tmp_path):
        src = write_wav(tmp_path / "in.wav", sine(300, 22050, 0.5), 22050)
        out = tmp_path / "out.wav"
        analysis.convert_take_to_wav(src, str(out))
        data, _ = sf.read(str(out))
        assert data.ndim == 1

    def test_missing_input_raises(self, tmp_path):
        with pytest.raises(Exception):
            analysis.convert_take_to_wav(str(tmp_path / "missing.webm"), str(tmp_path / "o.wav"))

    @pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg to author a webm/opus take")
    def test_decodes_a_real_webm_opus_take(self, tmp_path):
        wav = write_wav(tmp_path / "src.wav", sine(440, 48000, 1.0), 48000)
        webm = tmp_path / "take.webm"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-c:a", "libopus", str(webm)], check=True)
        out = tmp_path / "out.wav"
        analysis.convert_take_to_wav(str(webm), str(out))
        data, sr = sf.read(str(out))
        assert sr == 48000 and abs(len(data) / sr - 1.0) < 0.1


def const_wav(path, value, seconds, sr, channels=1):
    x = np.full((int(seconds * sr), channels) if channels > 1 else int(seconds * sr), value, dtype=np.float32)
    sf.write(str(path), x, sr, subtype="FLOAT")
    return str(path)


def ramp_wav(path, seconds, sr):
    """Sample value = file time / 10, so any output sample reveals which file time landed there."""
    t = np.arange(int(seconds * sr)) / sr
    sf.write(str(path), (t / 10).astype(np.float32), sr, subtype="FLOAT")
    return str(path)


def read(path):
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return data, sr


def at(data, sr, project_seconds, window_start):
    return float(data[int(round((project_seconds - window_start) * sr)), 0])


class TestMixExport:
    SR = 8000

    def test_requires_at_least_one_source(self, tmp_path):
        with pytest.raises(ValueError):
            analysis.mix_export([], 0, 1, str(tmp_path / "o.wav"))

    def test_a_plain_stem_is_trimmed_to_the_window_and_made_stereo(self, tmp_path):
        p = const_wav(tmp_path / "a.wav", 0.3, 10, self.SR)
        out = tmp_path / "o.wav"
        analysis.mix_export([{"path": p, "gain": 1.0, "isTake": False}], 2.0, 6.0, str(out))
        data, sr = read(out)
        assert sr == self.SR
        assert data.shape == (4 * self.SR, 2)
        assert np.allclose(data, 0.3, atol=1e-4)

    def test_applies_each_sources_gain_and_sums(self, tmp_path):
        a = const_wav(tmp_path / "a.wav", 0.2, 3, self.SR)
        b = const_wav(tmp_path / "b.wav", 0.4, 3, self.SR)
        out = tmp_path / "o.wav"
        analysis.mix_export(
            [{"path": a, "gain": 0.5, "isTake": False}, {"path": b, "gain": 1.0, "isTake": False}], 0, 2, str(out)
        )
        data, _ = read(out)
        assert np.allclose(data, 0.5, atol=1e-4)

    def test_scales_down_instead_of_clipping(self, tmp_path):
        """Clipping would flatten the 1.5 peaks to 1.0; scaling keeps the 1.5 : 1.0 relationship."""
        loud = np.tile(np.array([1.0, 0.5], dtype=np.float32), self.SR)
        a = tmp_path / "a.wav"
        sf.write(str(a), loud, self.SR, subtype="FLOAT")
        b = const_wav(tmp_path / "b.wav", 0.5, 2, self.SR)
        out = tmp_path / "o.wav"
        analysis.mix_export([{"path": str(a), "gain": 1.0, "isTake": False}, {"path": b, "gain": 1.0, "isTake": False}], 0, 1, str(out))
        data, _ = read(out)
        hi, lo = float(data[0, 0]), float(data[1, 0])
        assert hi == pytest.approx(1.0, abs=2e-3)
        assert lo == pytest.approx(1.0 / 1.5, abs=2e-3)

    def test_leaves_a_quiet_mix_untouched(self, tmp_path):
        a = const_wav(tmp_path / "a.wav", 0.1, 2, self.SR)
        out = tmp_path / "o.wav"
        analysis.mix_export([{"path": a, "gain": 1.0, "isTake": False}], 0, 1, str(out))
        assert np.allclose(read(out)[0], 0.1, atol=1e-4)

    def test_a_stereo_source_keeps_its_channels(self, tmp_path):
        x = np.stack([np.full(2 * self.SR, 0.1), np.full(2 * self.SR, 0.6)], axis=1).astype(np.float32)
        p = tmp_path / "s.wav"
        sf.write(str(p), x, self.SR, subtype="FLOAT")
        out = tmp_path / "o.wav"
        analysis.mix_export([{"path": str(p), "gain": 1.0, "isTake": False}], 0, 1, str(out))
        data, _ = read(out)
        assert np.allclose(data[:, 0], 0.1, atol=1e-4) and np.allclose(data[:, 1], 0.6, atol=1e-4)

    def test_resamples_a_source_with_a_different_rate_to_the_first_sources_rate(self, tmp_path):
        a = const_wav(tmp_path / "a.wav", 0.2, 3, 8000)
        b = const_wav(tmp_path / "b.wav", 0.3, 3, 16000)
        out = tmp_path / "o.wav"
        analysis.mix_export([{"path": a, "gain": 1.0, "isTake": False}, {"path": b, "gain": 1.0, "isTake": False}], 0, 2, str(out))
        data, sr = read(out)
        assert sr == 8000
        assert abs(len(data) - 2 * 8000) <= 8
        assert np.allclose(data[200:-200], 0.5, atol=0.02)

    def test_a_window_with_no_overlap_renders_silence_of_the_requested_length(self, tmp_path):
        a = const_wav(tmp_path / "a.wav", 0.5, 2, self.SR)
        out = tmp_path / "o.wav"
        analysis.mix_export([{"path": a, "gain": 1.0, "isTake": False}], 5, 7, str(out))
        data, sr = read(out)
        assert sr == 44100 and data.shape == (2 * 44100, 2)
        assert not data.any()

    def test_a_window_running_past_the_end_is_padded_with_silence(self, tmp_path):
        a = const_wav(tmp_path / "a.wav", 0.5, 2, self.SR)
        out = tmp_path / "o.wav"
        analysis.mix_export([{"path": a, "gain": 1.0, "isTake": False}], 1, 4, str(out))
        data, _ = read(out)
        assert data.shape[0] == 3 * self.SR
        assert np.allclose(data[: self.SR], 0.5, atol=1e-4)
        assert not data[self.SR + 100 :].any()

    # ── take alignment ────────────────────────────────────────────────────

    def take(self, path, **kw):
        return {"path": path, "gain": 1.0, "isTake": True, **kw}

    def test_a_take_starting_inside_the_window_is_preceded_by_silence(self, tmp_path):
        """Project time 4 s is where the take begins; the export must not slide it to the window start."""
        p = const_wav(tmp_path / "t.wav", 0.5, 3, self.SR)
        out = tmp_path / "o.wav"
        analysis.mix_export([self.take(p, startPosition=4.0)], 2.0, 8.0, str(out))
        data, sr = read(out)
        assert data.shape[0] == 6 * sr
        assert not data[: 2 * sr - 50].any(), "silence from 2 s to 4 s"
        assert np.allclose(data[2 * sr + 50 : 5 * sr - 50], 0.5, atol=1e-4), "take plays 4 s - 7 s"
        assert not data[5 * sr + 50 :].any(), "silence from 7 s to 8 s"

    def test_a_take_content_lands_at_the_matching_project_time(self, tmp_path):
        p = ramp_wav(tmp_path / "t.wav", 5, self.SR)
        out = tmp_path / "o.wav"
        analysis.mix_export([self.take(p, startPosition=3.0)], 0.0, 10.0, str(out))
        data, sr = read(out)
        for project_t in (3.5, 4.0, 6.0):
            assert at(data, sr, project_t, 0.0) == pytest.approx((project_t - 3.0) / 10, abs=2e-3)

    def test_a_take_that_began_before_the_window_is_cut_into(self, tmp_path):
        p = ramp_wav(tmp_path / "t.wav", 8, self.SR)
        out = tmp_path / "o.wav"
        analysis.mix_export([self.take(p, startPosition=1.0)], 4.0, 6.0, str(out))
        data, sr = read(out)
        assert at(data, sr, 4.5, 4.0) == pytest.approx((4.5 - 1.0) / 10, abs=2e-3)

    def test_audio_offset_skips_the_start_of_the_file_and_never_plays_it_early(self, tmp_path):
        """Latency compensation: file time `audioOffset` is what plays at `startPosition`."""
        p = ramp_wav(tmp_path / "t.wav", 5, self.SR)
        out = tmp_path / "o.wav"
        analysis.mix_export([self.take(p, startPosition=4.0, audioOffset=0.5)], 2.0, 8.0, str(out))
        data, sr = read(out)
        assert at(data, sr, 4.5, 2.0) == pytest.approx((4.5 - 4.0 + 0.5) / 10, abs=2e-3)
        assert not data[: 2 * sr - 50].any()
        assert abs(at(data, sr, 3.9, 2.0)) < 1e-6, "the skipped first 0.5 s of the file must not leak before the take starts"

    def test_manual_offset_shifts_the_take(self, tmp_path):
        p = ramp_wav(tmp_path / "t.wav", 5, self.SR)
        out = tmp_path / "o.wav"
        analysis.mix_export([self.take(p, startPosition=3.0, manualOffset=1.5)], 0.0, 10.0, str(out))
        data, sr = read(out)
        assert at(data, sr, 5.0, 0.0) == pytest.approx((5.0 - 4.5) / 10, abs=2e-3)
        assert abs(at(data, sr, 4.0, 0.0)) < 1e-6

    def test_a_negative_manual_offset_may_push_the_start_before_zero(self, tmp_path):
        p = ramp_wav(tmp_path / "t.wav", 5, self.SR)
        out = tmp_path / "o.wav"
        analysis.mix_export([self.take(p, startPosition=1.0, manualOffset=-2.0)], 0.0, 3.0, str(out))
        data, sr = read(out)
        assert at(data, sr, 0.5, 0.0) == pytest.approx((0.5 + 1.0) / 10, abs=2e-3)

    def test_a_take_is_mixed_over_the_stems_at_the_right_place(self, tmp_path):
        stem = const_wav(tmp_path / "s.wav", 0.2, 10, self.SR)
        t = const_wav(tmp_path / "t.wav", 0.3, 2, self.SR)
        out = tmp_path / "o.wav"
        analysis.mix_export([{"path": stem, "gain": 1.0, "isTake": False}, self.take(t, startPosition=5.0)], 4.0, 8.0, str(out))
        data, sr = read(out)
        assert at(data, sr, 4.5, 4.0) == pytest.approx(0.2, abs=1e-3)
        assert at(data, sr, 5.5, 4.0) == pytest.approx(0.5, abs=1e-3)
        assert at(data, sr, 7.5, 4.0) == pytest.approx(0.2, abs=1e-3)

    def test_a_take_entirely_after_the_window_contributes_nothing(self, tmp_path):
        stem = const_wav(tmp_path / "s.wav", 0.2, 10, self.SR)
        t = const_wav(tmp_path / "t.wav", 0.3, 2, self.SR)
        out = tmp_path / "o.wav"
        analysis.mix_export([{"path": stem, "gain": 1.0, "isTake": False}, self.take(t, startPosition=9.0)], 0.0, 4.0, str(out))
        assert np.allclose(read(out)[0], 0.2, atol=1e-3)


class TestProbeSource:
    def test_wav_durations_are_read_without_decoding(self, tmp_path):
        p = const_wav(tmp_path / "a.wav", 0.1, 2.5, 8000)
        duration, sr, samples = analysis._probe_source(p)
        assert (duration, sr, samples) == (2.5, 8000, None)

    @pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg to author a webm/opus take")
    def test_webm_is_decoded_up_front_because_its_duration_metadata_is_unreliable(self, tmp_path):
        wav = write_wav(tmp_path / "src.wav", sine(440, 48000, 1.0), 48000)
        webm = tmp_path / "take.webm"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-c:a", "libopus", str(webm)], check=True)
        duration, sr, samples = analysis._probe_source(str(webm))
        assert samples is not None and samples.ndim == 2
        assert duration == pytest.approx(1.0, abs=0.1) and sr == 48000


class TestAnalyzeRecording:
    SR = 44100

    def run(self, tmp_path, audio, sr=None, before=None, **kw):
        sr = sr or self.SR
        # A real take is a .webm; this one holds WAV bytes so the normalised copy gets a distinct name.
        path = write_wav(tmp_path / "take.webm", audio, sr)
        if before is not None:
            before()
        events = []
        result = analysis.analyze_recording(path, str(tmp_path), on_progress=lambda v, s: events.append((v, s)), **kw)
        return path, result, events

    def test_returns_the_documented_shape(self, tmp_path):
        _, r, _ = self.run(tmp_path, harmonic_tone(220, self.SR, 3.0))
        for key in ("pitchData", "onsets", "dynamics", "vibrato", "normalizedPath", "appliedGainDb",
                    "stSpectrumTimes", "stSpectrumB64", "stSpectrumFrames", "stSpectrumBins", "stSpectrumMinDb", "stSpectrumMaxDb"):
            assert key in r, key
        assert set(r["pitchData"]) == {"times", "f0", "voiced", "confidence"}
        assert set(r["vibrato"]) == {"rate", "depth", "regularity"}
        assert r["dynamics"] and set(r["dynamics"][0]) == {"time", "rms"}

    def test_finds_the_pitch_of_the_recording(self, tmp_path):
        _, r, _ = self.run(tmp_path, harmonic_tone(220, self.SR, 3.0))
        assert abs(cents(voiced_median(r["pitchData"]), 220.0)) < 30

    def test_the_selected_algorithm_is_used(self, tmp_path):
        _, srh, _ = self.run(tmp_path, harmonic_tone(220, self.SR, 2.0), pitch_algorithm="srh")
        _, pyin, _ = self.run(tmp_path, harmonic_tone(220, self.SR, 2.0), pitch_algorithm="pyin")
        assert srh["pitchData"]["confidence"] != pyin["pitchData"]["confidence"]

    def test_normalises_loudness_to_the_reference_stem(self, tmp_path):
        ref = write_wav(tmp_path / "vocals.wav", harmonic_tone(300, self.SR, 2.0, amp=0.05), self.SR)
        path, r, _ = self.run(tmp_path, harmonic_tone(220, self.SR, 3.0, amp=0.5), reference_path=ref)
        out, _ = sf.read(r["normalizedPath"])
        ref_audio, _ = sf.read(ref)
        assert rms_db(out) == pytest.approx(rms_db(ref_audio), abs=0.5)

    def test_without_a_reference_it_targets_minus_18_dbfs(self, tmp_path):
        _, r, _ = self.run(tmp_path, harmonic_tone(220, self.SR, 3.0, amp=0.9))
        out, _ = sf.read(r["normalizedPath"])
        assert rms_db(out) == pytest.approx(analysis.TARGET_RMS_DBFS_FALLBACK, abs=0.5)

    def test_a_missing_reference_file_falls_back_rather_than_failing(self, tmp_path):
        _, r, _ = self.run(tmp_path, harmonic_tone(220, self.SR, 2.0), reference_path=str(tmp_path / "gone.wav"))
        assert r["normalizedPath"] is not None

    def test_never_amplifies_past_the_peak_ceiling(self, tmp_path):
        x = np.zeros(self.SR * 3, dtype=np.float32)
        x[::4410] = 0.9
        x += white_noise_small(len(x))
        _, r, _ = self.run(tmp_path, x)
        out, _ = sf.read(r["normalizedPath"])
        assert np.max(np.abs(out)) <= 10 ** (analysis.PEAK_CEILING_DBFS / 20) + 1e-3

    def test_reported_gain_matches_the_applied_gain(self, tmp_path):
        x = harmonic_tone(220, self.SR, 3.0, amp=0.2)
        path, r, _ = self.run(tmp_path, x)
        out, _ = sf.read(r["normalizedPath"])
        orig, _ = sf.read(path)
        assert r["appliedGainDb"] == pytest.approx(rms_db(out) - rms_db(orig), abs=0.2)

    def test_the_normalised_file_replaces_the_extension_with_wav(self, tmp_path):
        path, r, _ = self.run(tmp_path, harmonic_tone(220, self.SR, 2.0))
        assert r["normalizedPath"] == os.path.splitext(path)[0] + ".wav" != path
        assert os.path.getsize(r["normalizedPath"]) > 0

    def test_audio_offset_skips_the_leading_audio_and_times_restart_at_zero(self, tmp_path):
        lead = np.zeros(self.SR, dtype=np.float32)
        x = np.concatenate([lead, harmonic_tone(220, self.SR, 2.0)])
        _, with_skip, _ = self.run(tmp_path, x, audio_offset_s=1.0)
        _, without, _ = self.run(tmp_path, x)
        assert with_skip["pitchData"]["times"][0] == 0
        first_voiced_skip = next(t for t, v in zip(with_skip["pitchData"]["times"], with_skip["pitchData"]["voiced"]) if v)
        first_voiced_full = next(t for t, v in zip(without["pitchData"]["times"], without["pitchData"]["voiced"]) if v)
        assert first_voiced_skip < 0.3
        assert first_voiced_full > 0.9

    def test_progress_runs_from_zero_to_one_and_never_goes_backwards(self, tmp_path):
        _, _, events = self.run(tmp_path, harmonic_tone(220, self.SR, 2.0))
        values = [v for v, _ in events]
        assert values[0] == 0.0 and values[-1] == 1.0
        assert values == sorted(values)
        assert [s for _, s in events][-1] == "complete"

    def test_a_failed_loudness_step_degrades_to_no_normalised_file(self, tmp_path, monkeypatch):
        def fail_writes():
            monkeypatch.setattr(analysis.sf, "write", lambda *a, **k: (_ for _ in ()).throw(OSError("disk full")))

        _, r, _ = self.run(tmp_path, harmonic_tone(220, self.SR, 2.0), before=fail_writes)
        assert r["normalizedPath"] is None
        assert not (tmp_path / "take.wav").exists()
        assert r["pitchData"]["times"], "the rest of the analysis still returns"

    def test_a_failed_spectrum_step_leaves_empty_spectrum_fields(self, tmp_path, monkeypatch):
        monkeypatch.setattr(analysis, "compute_short_term_spectrum", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("fft")))
        _, r, _ = self.run(tmp_path, harmonic_tone(220, self.SR, 2.0))
        assert r["stSpectrumB64"] == "" and r["stSpectrumFrames"] == 0
        assert r["normalizedPath"] is not None

    def test_a_missing_recording_raises(self, tmp_path):
        with pytest.raises(Exception):
            analysis.analyze_recording(str(tmp_path / "missing.webm"), str(tmp_path))


def white_noise_small(n, amp=0.002):
    rng = np.random.default_rng(3)
    return (amp * (rng.random(n) * 2 - 1)).astype(np.float32)
