import base64

import numpy as np
import pytest
from scipy.signal.windows import blackman

import processor
from helpers import sine, white_noise, write_wav

SR = 44100
N_BINS = 1280
F_MIN, F_MAX = 30.0, 20000.0


def decode(result):
    raw = np.frombuffer(base64.b64decode(result["stSpectrumB64"]), dtype=np.uint8)
    return raw.reshape(result["stSpectrumFrames"], result["stSpectrumBins"])


def bin_of(freq, sr=SR):
    lo, hi = np.log(F_MIN), np.log(min(F_MAX, sr / 2))
    return int((np.log(freq) - lo) / (hi - lo) * N_BINS)


def db_of(u8):
    return u8 / 255.0 * 100.0 - 100.0


class TestShortTermSpectrum:
    def test_shape_and_metadata(self):
        r = processor.compute_short_term_spectrum(sine(1000, SR, 2.0), SR)
        frames = r["stSpectrumFrames"]
        assert r["stSpectrumBins"] == N_BINS
        assert (r["stSpectrumMinDb"], r["stSpectrumMaxDb"]) == (-100.0, 0.0)
        assert len(r["stSpectrumTimes"]) == frames
        assert decode(r).shape == (frames, N_BINS)

    def test_frame_times_advance_by_the_2048_sample_hop(self):
        r = processor.compute_short_term_spectrum(sine(1000, SR, 2.0), SR)
        t = np.array(r["stSpectrumTimes"])
        assert t[0] == 0
        assert np.allclose(np.diff(t), 2048 / SR)

    def test_a_full_scale_tone_reads_about_zero_dbfs(self):
        """Blackman coherent-gain normalisation: amplitude 1.0 -> 0 dBFS (not hundreds of dB)."""
        r = processor.compute_short_term_spectrum(sine(1000.0, SR, 2.0, amp=1.0), SR)
        frame = decode(r)[r["stSpectrumFrames"] // 2]
        assert 250 <= frame.max() <= 255

    @pytest.mark.parametrize("amp,expected_db", [(1.0, 0.0), (0.5, -6.02), (0.1, -20.0), (0.01, -40.0)])
    def test_level_scales_with_amplitude(self, amp, expected_db):
        r = processor.compute_short_term_spectrum(sine(1000.0, SR, 2.0, amp=amp), SR)
        frame = decode(r)[r["stSpectrumFrames"] // 2]
        assert db_of(float(frame.max())) == pytest.approx(expected_db, abs=2.0)

    @pytest.mark.parametrize("freq", [100.0, 440.0, 1000.0, 4000.0, 12000.0])
    def test_the_peak_lands_in_the_bin_for_its_frequency(self, freq):
        r = processor.compute_short_term_spectrum(sine(freq, SR, 2.0, amp=0.5), SR)
        frame = decode(r)[r["stSpectrumFrames"] // 2]
        assert abs(int(np.argmax(frame)) - bin_of(freq)) <= 6

    def test_bins_far_from_a_tone_stay_near_the_floor(self):
        r = processor.compute_short_term_spectrum(sine(1000.0, SR, 2.0), SR)
        frame = decode(r)[r["stSpectrumFrames"] // 2]
        assert frame[bin_of(10000)] < 5
        assert frame[bin_of(60)] < 5

    def test_the_floor_is_absolute_not_relative_to_the_loudest_part_of_the_file(self):
        quiet = sine(1000.0, SR, 1.0, amp=1e-4)
        loud = sine(1000.0, SR, 1.0, amp=0.9)
        alone = decode(processor.compute_short_term_spectrum(quiet, SR))
        mixed = decode(processor.compute_short_term_spectrum(np.concatenate([quiet, loud]), SR))
        b = bin_of(1000.0)
        assert int(mixed[3, b]) == pytest.approx(int(alone[3, b]), abs=3)

    def test_matches_a_direct_fft_of_the_same_frame(self):
        x = sine(1000.0, SR, 2.0, amp=0.5)
        r = processor.compute_short_term_spectrum(x, SR)
        k = r["stSpectrumFrames"] // 2
        centre = k * 2048
        frame = np.pad(x, 4096, mode="reflect")[centre : centre + 8192] * blackman(8192)
        mag = np.abs(np.fft.rfft(frame)) / (blackman(8192).sum() / 2)
        freqs = np.fft.rfftfreq(8192, 1 / SR)
        in_bin = (freqs >= 900) & (freqs < 1100)
        expected_db = 20 * np.log10(mag[in_bin].max())
        got = db_of(float(decode(r)[k].max()))
        assert got == pytest.approx(expected_db, abs=1.0)

    def test_no_picket_fence_in_the_low_bins(self):
        """Narrow log bins below ~950 Hz hold no FFT bin; they must borrow the nearest one, not read as -100 dB."""
        r = processor.compute_short_term_spectrum(white_noise(SR, 3.0, amp=0.5), SR)
        frame = decode(r)[r["stSpectrumFrames"] // 2]
        low = frame[: bin_of(300)]
        assert (low == 0).mean() < 0.02
        assert low.min() > 0

    def test_a_flat_noise_floor_is_flat_across_the_axis(self):
        r = processor.compute_short_term_spectrum(white_noise(SR, 3.0, amp=0.5), SR)
        frame = decode(r)[r["stSpectrumFrames"] // 2].astype(float)
        smooth = np.convolve(frame, np.ones(25) / 25, mode="valid")
        assert np.ptp(smooth[200:]) < 40

    def test_silence_is_the_minimum_everywhere(self):
        r = processor.compute_short_term_spectrum(np.zeros(SR, dtype=np.float32), SR)
        assert decode(r).max() == 0

    def test_low_sample_rate_caps_the_axis_at_nyquist_but_keeps_the_bin_count(self):
        sr = 16000
        r = processor.compute_short_term_spectrum(sine(2000.0, sr, 2.0), sr)
        assert r["stSpectrumBins"] == N_BINS
        frame = decode(r)[r["stSpectrumFrames"] // 2]
        assert abs(int(np.argmax(frame)) - bin_of(2000.0, sr)) <= 6

    def test_blob_decodes_to_exactly_frames_times_bins_bytes(self):
        r = processor.compute_short_term_spectrum(sine(500.0, SR, 1.0), SR)
        assert len(base64.b64decode(r["stSpectrumB64"])) == r["stSpectrumFrames"] * r["stSpectrumBins"]

    def test_bin_count_is_the_cache_marker_the_rust_side_expects(self):
        src = (__import__("pathlib").Path(__file__).resolve().parents[2] / "src-tauri" / "src" / "commands.rs").read_text(encoding="utf-8")
        marker = int(src.split("const ST_SPECTRUM_MIN_BINS: i64 =")[1].split(";")[0])
        assert marker == N_BINS == processor.compute_short_term_spectrum(sine(500.0, SR, 0.5), SR)["stSpectrumBins"]


class TestFileBackfill:
    def test_loads_at_44100_mono_and_matches_direct_computation(self, tmp_path):
        x = sine(440.0, 22050, 2.0)
        path = write_wav(tmp_path / "t.wav", x, 22050)
        r = processor.compute_st_spectrum_from_file(path)
        assert r["stSpectrumBins"] == N_BINS
        frame = decode(r)[r["stSpectrumFrames"] // 2]
        assert abs(int(np.argmax(frame)) - bin_of(440.0)) <= 6

    def test_offset_skips_the_start_of_the_file(self, tmp_path):
        x = np.concatenate([np.zeros(SR, dtype=np.float32), sine(1000.0, SR, 2.0)])
        path = write_wav(tmp_path / "t.wav", x, SR)
        whole = processor.compute_st_spectrum_from_file(path)
        skipped = processor.compute_st_spectrum_from_file(path, offset_s=1.0)
        assert skipped["stSpectrumFrames"] < whole["stSpectrumFrames"]
        assert decode(whole)[1].max() == 0, "the first second is silent"
        assert decode(skipped)[1].max() > 200, "after the skip the tone is already there"

    def test_stereo_is_mixed_to_mono(self, tmp_path):
        left = sine(300.0, SR, 1.0)
        stereo = np.stack([left, left], axis=1)
        path = tmp_path / "s.wav"
        __import__("soundfile").write(str(path), stereo, SR)
        r = processor.compute_st_spectrum_from_file(str(path))
        assert abs(int(np.argmax(decode(r)[1])) - bin_of(300.0)) <= 6

    def test_missing_file_raises(self, tmp_path):
        with pytest.raises(Exception):
            processor.compute_st_spectrum_from_file(str(tmp_path / "nope.wav"))


class TestSpectrogram:
    def test_shape_and_encoding(self):
        r = processor.compute_spectrogram(sine(440.0, 22050, 2.0), 22050)
        raw = np.frombuffer(base64.b64decode(r["spectroB64"]), dtype=np.uint8)
        assert r["spectroRows"] == 160
        assert raw.size == r["spectroFrames"] * 160
        assert len(r["spectroTimes"]) == r["spectroFrames"]

    def test_the_brightest_row_is_the_notes_row_and_row_zero_is_the_top(self):
        r = processor.compute_spectrogram(sine(440.0, 22050, 2.0), 22050)
        frames = np.frombuffer(base64.b64decode(r["spectroB64"]), dtype=np.uint8).reshape(r["spectroFrames"], 160)
        row = int(np.argmax(frames[r["spectroFrames"] // 2]))
        midi = 84 - row / 159 * (84 - 45)
        assert abs(midi - 69) < 1.0

    def test_peak_maps_to_the_top_of_the_scale(self):
        r = processor.compute_spectrogram(sine(440.0, 22050, 1.0), 22050)
        frames = np.frombuffer(base64.b64decode(r["spectroB64"]), dtype=np.uint8)
        assert frames.max() == 255
