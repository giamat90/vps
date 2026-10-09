"""processor.process() / pitch_shift_song() end to end, without Demucs (skip_separation / plain stems)."""

import filecmp

import numpy as np
import pytest
import soundfile as sf

import processor
from helpers import cents, harmonic_tone, sine, voiced_median, write_wav

SR = 44100


def click_track(sr, seconds, bpm):
    x = np.zeros(int(sr * seconds), dtype=np.float32)
    step = int(sr * 60 / bpm)
    for i in range(0, len(x) - 400, step):
        x[i : i + 400] = 0.8 * np.hanning(400)
    return x


class TestProcessInstrumentTrack:
    @pytest.fixture
    def processed(self, tmp_path):
        src = write_wav(tmp_path / "scale.wav", harmonic_tone(261.63, SR, 4.0), SR)
        out = tmp_path / "out"
        events = []
        result = processor.process(src, str(out), on_progress=lambda v, s: events.append((v, s)), skip_separation=True, pitch_algorithm="piano")
        return result, out, events

    def test_returns_every_field_the_rust_side_persists(self, processed):
        result, _, _ = processed
        for key in ("vocals", "instrumental", "duration", "pitchData", "onsets", "dynamics", "detectedBpm", "detectedKey",
                    "spectroTimes", "spectroB64", "spectroFrames", "spectroRows",
                    "stSpectrumTimes", "stSpectrumB64", "stSpectrumFrames", "stSpectrumBins", "stSpectrumMinDb", "stSpectrumMaxDb"):
            assert key in result, key

    def test_vocals_and_instrumental_are_identical_copies_of_the_input(self, processed):
        result, out, _ = processed
        assert result["vocals"] == str(out / "vocals.wav") and result["instrumental"] == str(out / "instrumental.wav")
        assert filecmp.cmp(result["vocals"], result["instrumental"], shallow=False)
        data, sr = sf.read(result["vocals"])
        assert sr == SR and abs(len(data) / sr - 4.0) < 0.01

    def test_duration_pitch_and_dynamics(self, processed):
        result, _, _ = processed
        assert result["duration"] == pytest.approx(4.0, abs=0.01)
        assert abs(cents(voiced_median(result["pitchData"]), 261.63)) < 60
        assert len(result["dynamics"]) > 100

    def test_progress_is_monotonic_and_finishes_at_one(self, processed):
        _, _, events = processed
        values = [v for v, _ in events]
        assert values == sorted(values), f"progress went backwards: {values}"
        assert values[-1] == 1.0

    def test_creates_the_output_directory(self, tmp_path):
        src = write_wav(tmp_path / "a.wav", sine(220, SR, 2.0), SR)
        out = tmp_path / "does" / "not" / "exist"
        processor.process(src, str(out), skip_separation=True)
        assert (out / "vocals.wav").exists()

    def test_stereo_input_is_preserved_in_the_stems(self, tmp_path):
        left = harmonic_tone(220, SR, 2.0)
        sf.write(str(tmp_path / "s.wav"), np.stack([left, left * 0.5], axis=1), SR)
        out = tmp_path / "out"
        processor.process(str(tmp_path / "s.wav"), str(out), skip_separation=True)
        data, _ = sf.read(str(out / "vocals.wav"))
        assert data.ndim == 2 and data.shape[1] == 2

    def test_an_unknown_algorithm_name_falls_back_to_srh(self, tmp_path):
        src = write_wav(tmp_path / "a.wav", harmonic_tone(220, SR, 2.0), SR)
        a = processor.process(src, str(tmp_path / "a"), skip_separation=True, pitch_algorithm="nonsense")
        b = processor.process(src, str(tmp_path / "b"), skip_separation=True, pitch_algorithm="srh")
        assert a["pitchData"] == b["pitchData"]

    def test_silence_has_no_key(self, tmp_path):
        src = write_wav(tmp_path / "z.wav", np.zeros(SR * 2, dtype=np.float32), SR)
        result = processor.process(src, str(tmp_path / "o"), skip_separation=True)
        assert result["detectedKey"] == "Unknown"
        assert not any(result["pitchData"]["voiced"])

    def test_a_missing_input_raises(self, tmp_path):
        with pytest.raises(Exception):
            processor.process(str(tmp_path / "missing.wav"), str(tmp_path / "o"), skip_separation=True)

    def test_detects_the_tempo_of_a_click_track(self, tmp_path):
        src = write_wav(tmp_path / "clicks.wav", click_track(SR, 12.0, 120), SR)
        result = processor.process(src, str(tmp_path / "o"), skip_separation=True)
        bpm = result["detectedBpm"]
        assert any(abs(bpm - target) < 6 for target in (60, 120, 240)), f"tempo {bpm} is not a multiple of the click rate"

    def test_detects_the_key_of_a_melody(self, tmp_path):
        notes = [60, 62, 64, 65, 67, 69, 71, 72, 67, 64, 60, 64, 67, 72]
        audio = np.concatenate([harmonic_tone(440 * 2 ** ((n - 69) / 12), SR, 0.5) for n in notes * 2])
        src = write_wav(tmp_path / "melody.wav", audio, SR)
        result = processor.process(src, str(tmp_path / "o"), skip_separation=True, pitch_algorithm="pyin")
        assert result["detectedKey"] in ("C major", "A minor")


class TestPitchShift:
    def make_song(self, tmp_path, channels=1):
        song = tmp_path / "song"
        song.mkdir()
        vocal = harmonic_tone(220.0, SR, 2.0)
        inst = sine(110.0, SR, 2.0, amp=0.3)
        for name, x in (("vocals.wav", vocal), ("instrumental.wav", inst)):
            data = np.stack([x, x], axis=1) if channels == 2 else x
            sf.write(str(song / name), data, SR)
        cache = tmp_path / "cache"
        cache.mkdir()
        return str(song), str(cache)

    @pytest.mark.parametrize("steps", [2, -3])
    def test_shifts_the_vocals_by_the_requested_semitones(self, tmp_path, steps):
        song, cache = self.make_song(tmp_path)
        result = processor.pitch_shift_song(song, cache, steps)
        shifted, sr = sf.read(result["vocalsPath"])
        r = processor.detect_pitch_srh(shifted.astype(np.float32), sr)
        assert abs(cents(voiced_median(r), 220.0 * 2 ** (steps / 12))) < 60

    def test_keeps_the_duration_and_sample_rate(self, tmp_path):
        song, cache = self.make_song(tmp_path)
        result = processor.pitch_shift_song(song, cache, 4)
        for path in (result["vocalsPath"], result["instrumentalPath"]):
            data, sr = sf.read(path)
            assert sr == SR and abs(len(data) - 2 * SR) < 50

    def test_shifts_stereo_files_per_channel(self, tmp_path):
        song, cache = self.make_song(tmp_path, channels=2)
        result = processor.pitch_shift_song(song, cache, 1)
        data, _ = sf.read(result["vocalsPath"])
        assert data.ndim == 2 and data.shape[1] == 2

    def test_writes_into_the_cache_directory_and_leaves_the_originals(self, tmp_path):
        song, cache = self.make_song(tmp_path)
        before = (tmp_path / "song" / "vocals.wav").read_bytes()
        result = processor.pitch_shift_song(song, cache, 2)
        assert result["vocalsPath"].startswith(cache) and result["instrumentalPath"].startswith(cache)
        assert (tmp_path / "song" / "vocals.wav").read_bytes() == before

    def test_reports_progress_to_completion(self, tmp_path):
        song, cache = self.make_song(tmp_path)
        events = []
        processor.pitch_shift_song(song, cache, 1, on_progress=lambda v, s: events.append(v))
        assert events[0] == 0.0 and events[-1] == 1.0 and events == sorted(events)

    def test_a_missing_stem_raises(self, tmp_path):
        song, cache = self.make_song(tmp_path)
        (tmp_path / "song" / "instrumental.wav").unlink()
        with pytest.raises(Exception):
            processor.pitch_shift_song(song, cache, 1)
