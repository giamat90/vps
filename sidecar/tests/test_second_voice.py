"""
Two singers on one stem: the second voice and a lead line that does not hop between them.

The single-F0 SRH line follows whichever voice is louder in each frame, so two sustained notes of
similar strength make it jump back and forth. `detect_second_voice` finds the other voice by
cancelling the first one's harmonics, then holds one voice as the lead for the whole stretch.
"""

import numpy as np
import pytest

import processor
from helpers import cents, vibrato_tone, white_noise

SR = 22050
A3 = 220.0
FOURTH = A3 * 2 ** (5 / 12)


def mix(*parts):
    x = np.sum(parts, axis=0)
    return (0.4 * x / np.max(np.abs(x))).astype(np.float32)


def steady_voice(f0, seconds, rate_hz, amp=0.4):
    return vibrato_tone(f0, SR, seconds, rate_hz=rate_hz, depth_cents=20, amp=amp)


def analyse(audio):
    base = processor.detect_pitch_srh(audio, SR)
    f0 = np.array(base["f0"])
    voiced = np.array(base["voiced"], dtype=bool)
    lead, alt = processor.detect_second_voice(audio, SR, f0, voiced)
    times = np.array(base["times"])
    inside = (times > 0.3) & (times < times[-1] - 0.3)
    return base, f0, voiced, lead, alt, inside


def big_jumps(f0, voiced, semitones=3.0):
    both = voiced[1:] & voiced[:-1] & (f0[1:] > 0) & (f0[:-1] > 0)
    d = np.abs(12 * np.log2(f0[1:][both] / f0[:-1][both]))
    return int((d >= semitones).sum())


class TestDetectSecondVoice:
    def test_two_steady_voices_are_both_found(self):
        audio = mix(steady_voice(A3, 3.0, 5.3), 0.7 * steady_voice(FOURTH, 3.0, 6.1))
        _, f0, voiced, lead, alt, inside = analyse(audio)

        found = (alt > 0) & inside & voiced
        assert found.sum() > 0.8 * (voiced & inside).sum()
        lead_ok = np.abs(cents(lead[found], A3)) < 50
        alt_ok = np.abs(cents(alt[found], FOURTH)) < 50
        assert lead_ok.mean() > 0.95, "the louder voice is the lead"
        assert alt_ok.mean() > 0.95, "the quieter voice is the second line"

    def test_lead_does_not_hop_when_the_voices_take_turns_being_louder(self):
        seconds = 4.0
        t = np.arange(int(SR * seconds)) / SR
        a_gain = np.where((t // 0.6) % 2 == 0, 1.0, 0.45)
        b_gain = np.where((t // 0.6) % 2 == 0, 0.45, 1.0)
        audio = mix(a_gain * steady_voice(A3, seconds, 5.3), b_gain * steady_voice(FOURTH, seconds, 6.1))
        _, f0, voiced, lead, alt, inside = analyse(audio)

        assert big_jumps(f0, voiced) >= 2, "precondition: the plain SRH line does hop"
        assert big_jumps(lead, voiced) == 0
        found = (alt > 0) & inside & voiced
        assert found.sum() > 0.7 * (voiced & inside).sum()
        pitches = {round(float(np.median(lead[found]))), round(float(np.median(alt[found])))}
        assert min(pitches) == pytest.approx(A3, abs=A3 * 0.03)
        assert max(pitches) == pytest.approx(FOURTH, abs=FOURTH * 0.03)

    def test_a_single_voice_has_no_second_line_and_keeps_its_f0(self):
        audio = steady_voice(A3, 3.0, 5.3)
        _, f0, voiced, lead, alt, _ = analyse(audio)
        assert not np.any(alt)
        assert np.array_equal(lead, f0)

    def test_a_single_voice_with_noise_has_no_second_line(self):
        audio = mix(steady_voice(A3, 3.0, 5.3), 0.05 * white_noise(SR, 3.0, amp=1.0))
        _, _, _, _, alt, inside = analyse(audio)
        assert np.count_nonzero(alt[inside]) < 0.03 * inside.sum()

    def test_an_octave_pair_is_not_split(self):
        # The upper voice is a harmonic of the lower one; nothing in the spectrum tells them apart.
        audio = mix(steady_voice(A3, 3.0, 5.3), 0.7 * steady_voice(2 * A3, 3.0, 6.1))
        _, _, _, _, alt, inside = analyse(audio)
        assert np.count_nonzero(alt[inside]) < 0.05 * inside.sum()

    def test_a_double_tracked_unison_is_not_split(self):
        audio = mix(steady_voice(A3, 3.0, 5.3), steady_voice(A3 * 2 ** (0.15 / 12), 3.0, 6.1))
        _, _, _, _, alt, inside = analyse(audio)
        assert np.count_nonzero(alt[inside]) < 0.05 * inside.sum()

    def test_a_voice_that_glides_is_not_reported_as_a_second_line(self):
        # Only held notes are trusted: a glide next to a held note could be a harmonic artefact.
        n = int(SR * 3.0)
        f = np.linspace(FOURTH, FOURTH * 2 ** (4 / 12), n)
        glide = sum((0.7 ** (k - 1)) * np.sin(k * 2 * np.pi * np.cumsum(f) / SR) for k in range(1, 6))
        audio = mix(steady_voice(A3, 3.0, 5.3), 0.7 * glide / np.max(np.abs(glide)))
        _, _, _, _, alt, inside = analyse(audio)
        assert np.count_nonzero(alt[inside]) < 0.2 * inside.sum()

    def test_silence_returns_empty_arrays(self):
        base = processor.detect_pitch_srh(np.zeros(SR, dtype=np.float32), SR)
        lead, alt = processor.detect_second_voice(
            np.zeros(SR, dtype=np.float32), SR, np.array(base["f0"]), np.array(base["voiced"], dtype=bool)
        )
        assert len(lead) == len(alt) == len(base["f0"])
        assert not np.any(alt)

    def test_frames_that_do_not_match_the_srh_grid_are_left_alone(self):
        audio = mix(steady_voice(A3, 2.0, 5.3), 0.7 * steady_voice(FOURTH, 2.0, 6.1))
        f0 = np.full(10, A3)
        lead, alt = processor.detect_second_voice(audio, SR, f0, np.ones(10, dtype=bool))
        assert np.array_equal(lead, f0)
        assert not np.any(alt)


class TestAddSecondVoice:
    def test_adds_f0_alt_and_keeps_the_other_arrays(self):
        audio = mix(steady_voice(A3, 3.0, 5.3), 0.7 * steady_voice(FOURTH, 3.0, 6.1))
        base = processor.detect_pitch_srh(audio, SR)
        out = processor.add_second_voice(base, audio, SR)

        n = len(base["times"])
        assert len(out["f0Alt"]) == n and len(out["f0"]) == n
        assert out["times"] == base["times"]
        assert out["voiced"] == base["voiced"]
        assert out["confidence"] == base["confidence"]
        assert any(v > 0 for v in out["f0Alt"])

    def test_unvoiced_frames_carry_zero_in_both_lines(self):
        audio = np.concatenate([
            mix(steady_voice(A3, 1.5, 5.3), 0.7 * steady_voice(FOURTH, 1.5, 6.1)),
            np.zeros(SR, dtype=np.float32),
        ])
        out = processor.add_second_voice(processor.detect_pitch_srh(audio, SR), audio, SR)
        voiced = np.array(out["voiced"], dtype=bool)
        assert np.all(np.array(out["f0"])[~voiced] == 0)
        assert np.all(np.array(out["f0Alt"])[~voiced] == 0)

    def test_does_not_mutate_its_input(self):
        audio = steady_voice(A3, 1.0, 5.3)
        base = processor.detect_pitch_srh(audio, SR)
        snapshot = {k: list(v) for k, v in base.items()}
        processor.add_second_voice(base, audio, SR)
        assert base == snapshot

    def test_the_second_voice_is_never_reported_without_a_voiced_lead(self):
        audio = mix(steady_voice(A3, 3.0, 5.3), 0.7 * steady_voice(FOURTH, 3.0, 6.1))
        out = processor.add_second_voice(processor.detect_pitch_srh(audio, SR), audio, SR)
        voiced = np.array(out["voiced"], dtype=bool)
        assert not np.any((np.array(out["f0Alt"]) > 0) & ~voiced)
