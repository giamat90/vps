//! Rust <-> Python integration: the real command bodies driving the real
//! sidecar over its JSON-lines protocol, against a throwaway data directory.
//! Skipped (loudly) when the sidecar's Python environment is not installed;
//! set VPS_REQUIRE_SIDECAR=1 to make that a failure instead.

use crate::commands::{
    import_exercise_file_impl as import_exercise_file, list_exercise_takes, list_takes_impl as list_takes,
    load_analysis_impl as load_analysis, save_exercise_take_impl as save_exercise_take, save_take_impl as save_take,
    SidecarState,
};
use crate::library;
use crate::lyrics;
use crate::sidecar::SidecarManager;
use crate::storage::{self, test_support::TestHome};
use crate::test_util::{base64_decode, read_wav, rms_dbfs, sidecar_unavailable, tones, write_wav};
use serde_json::{json, Value};
use std::sync::Mutex;

const MIN_BINS: i64 = 1280;

fn decode_blob(v: &Value) -> Vec<u8> {
    base64_decode(v["stSpectrumB64"].as_str().expect("stSpectrumB64"))
}

/// Index of the log-spaced bin (30 Hz .. min(20 kHz, sr/2)) that holds `hz`.
fn bin_of(hz: f64, sr: f64) -> usize {
    let (lo, hi) = (30f64.ln(), (20000f64).min(sr / 2.0).ln());
    (((hz.ln() - lo) / (hi - lo)) * MIN_BINS as f64) as usize
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

#[test]
fn the_rust_commands_and_the_python_sidecar_work_together() {
    let home = TestHome::new();
    std::env::set_var("USERPROFILE", home.path());
    std::env::set_var("HOME", home.path());

    let state = SidecarState(Mutex::new(None));
    match SidecarManager::spawn() {
        Ok(m) => *state.0.lock().unwrap() = Some(m),
        Err(e) => return sidecar_unavailable(&e),
    }

    let sr = 44100u32;
    let song_dir = storage::song_dir("song-1");

    // 1 ─ Short-term-spectrum backfill for a song analysed before the feature existed.
    let vocals = song_dir.join("vocals.wav");
    write_wav(&vocals, &tones(&[(440.0, 0.5)], sr, 2.0), sr);
    let analysis_path = song_dir.join("analysis.json");
    let legacy = json!({"pitchData": {"times": [], "f0": [], "voiced": [], "confidence": []}, "onsets": [], "dynamics": [],
                        "stSpectrumB64": "AAAA", "stSpectrumMinDb": -100.0, "stSpectrumMaxDb": 0.0, "stSpectrumBins": 1152});
    std::fs::write(&analysis_path, legacy.to_string()).unwrap();

    let filled = load_analysis(&state, "song-1").expect("load_analysis");
    assert_eq!(filled["stSpectrumBins"], MIN_BINS, "stale 1152-bin blob must be recomputed at the current resolution");
    assert_eq!(filled["stSpectrumMinDb"], -100.0);
    assert_eq!(filled["stSpectrumMaxDb"], 0.0);
    let frames = filled["stSpectrumFrames"].as_i64().unwrap() as usize;
    assert_eq!(filled["stSpectrumTimes"].as_array().unwrap().len(), frames);
    let blob = decode_blob(&filled);
    assert_eq!(blob.len(), frames * MIN_BINS as usize, "blob is frames x bins bytes");

    // A 440 Hz tone at amplitude 0.5 (-6 dBFS) peaks in the 440 Hz bin, near 94 % of the -100..0 range.
    let mid = &blob[(frames / 2) * MIN_BINS as usize..(frames / 2 + 1) * MIN_BINS as usize];
    let peak_bin = mid.iter().enumerate().max_by_key(|(_, v)| **v).unwrap().0;
    assert!((peak_bin as i64 - bin_of(440.0, sr as f64) as i64).abs() <= 6, "peak at bin {peak_bin}");
    assert!(mid[peak_bin] >= 225 && mid[peak_bin] <= 245, "peak level {} should be about -6 dBFS", mid[peak_bin]);
    assert!(mid[bin_of(8000.0, sr as f64)] < 40, "a pure tone leaves the spectrum far from it near the floor");
    assert!(mid[bin_of(440.0, sr as f64)] > mid[bin_of(60.0, sr as f64)] + 100, "the absolute floor leaves the tone standing well clear of the quiet bins");

    // ...and the result was persisted, so the next open is served from the cache.
    let persisted: Value = serde_json::from_str(&std::fs::read_to_string(&analysis_path).unwrap()).unwrap();
    assert_eq!(persisted["stSpectrumBins"], MIN_BINS);
    assert_eq!(load_analysis(&state, "song-1").unwrap(), persisted, "second open is a cache hit");

    // 2 ─ A song whose vocals cannot be decoded still loads (without a spectrum).
    let bad_dir = storage::song_dir("song-bad");
    std::fs::write(bad_dir.join("vocals.wav"), b"not audio").unwrap();
    std::fs::write(bad_dir.join("analysis.json"), json!({"pitchData": {}, "onsets": [], "dynamics": []}).to_string()).unwrap();
    let degraded = load_analysis(&state, "song-bad").expect("backfill failure must not fail the load");
    assert!(degraded.get("stSpectrumB64").is_none());

    // 3 ─ Recording a take: analysis, loudness normalisation against vocals.wav, persistence.
    let ref_wav = song_dir.join("vocals.wav");
    write_wav(&ref_wav, &tones(&[(300.0, 0.1)], sr, 2.0), sr);
    let ref_rms = rms_dbfs(&read_wav(&ref_wav).samples);

    let raw = crate::test_util::wav_bytes(&tones(&[(220.0, 0.4), (440.0, 0.2), (660.0, 0.1)], sr, 3.0), sr);
    let take = save_take(&state, "song-1".into(), raw, 12.5, 0.25).expect("save_take");

    assert_eq!(take.song_id, "song-1");
    assert_eq!((take.start_position, take.audio_offset), (12.5, 0.25));
    assert!(take.filepath.ends_with(".wav"), "the normalised WAV replaces the raw recording: {}", take.filepath);
    assert!(std::path::Path::new(&take.filepath).exists());
    assert!(!song_dir.join("takes").read_dir().unwrap().any(|e| e.unwrap().path().extension().is_some_and(|x| x == "webm")),
        "raw recording is removed once the normalised file exists");

    let pitch = take.pitch_data.as_ref().expect("pitch data");
    let f0s: Vec<f64> = pitch["f0"].as_array().unwrap().iter().zip(pitch["voiced"].as_array().unwrap())
        .filter(|(_, v)| v.as_bool() == Some(true)).map(|(f, _)| f.as_f64().unwrap()).collect();
    assert!(f0s.len() > 20, "a steady tone is voiced ({} frames)", f0s.len());
    assert!((median(f0s) - 220.0).abs() < 6.0, "SRH should find the 220 Hz fundamental, not a harmonic");
    assert_eq!(take.st_spectrum_bins.as_ref().unwrap(), MIN_BINS);
    assert!(take.vibrato.is_some() && take.dynamics.is_some() && take.onsets.is_some());

    let normalised = read_wav(std::path::Path::new(&take.filepath));
    assert!((rms_dbfs(&normalised.samples) - ref_rms).abs() < 1.5, "take loudness matches the reference stem");
    assert!(normalised.samples.iter().all(|s| s.abs() < 0.9), "never pushed past the peak ceiling");

    let listed = list_takes(&state, "song-1").unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, take.id);

    // 4 ─ list_takes backfills a take stored before the cache marker was bumped, and persists it.
    let mut old = listed[0].clone();
    old.st_spectrum_bins = Some(json!(1152));
    old.st_spectrum_b64 = Some(json!("AAAA"));
    let takes_json = song_dir.join("takes.json");
    std::fs::write(&takes_json, serde_json::to_string(&vec![old]).unwrap()).unwrap();
    let refreshed = list_takes(&state, "song-1").unwrap();
    assert_eq!(refreshed[0].st_spectrum_bins.as_ref().unwrap(), MIN_BINS);
    assert!(std::fs::read_to_string(&takes_json).unwrap().contains(&MIN_BINS.to_string()));

    // 5 ─ Free Exercise: recording and importing a file.
    let ex_audio = crate::test_util::wav_bytes(&tones(&[(330.0, 0.3)], sr, 2.0), sr);
    let ex = save_exercise_take(&state, ex_audio, 2.0).expect("save_exercise_take");
    assert!(ex.filepath.ends_with(".wav") && std::path::Path::new(&ex.filepath).exists());
    assert_eq!(ex.duration, 2.0);
    assert!(ex.pitch_data.is_some());
    let ex_rms = rms_dbfs(&read_wav(std::path::Path::new(&ex.filepath)).samples);
    assert!((ex_rms + 18.0).abs() < 1.5, "no reference stem: normalised to the -18 dBFS fallback, got {ex_rms}");

    let external = home.path().join("my song.wav");
    write_wav(&external, &tones(&[(262.0, 0.2)], sr, 2.0), sr);
    // The experiment override must reach the real sidecar: pyin is a different
    // detector from the shipped default, and an invalid name must fail the command.
    std::env::set_var(crate::pitch::OVERRIDE_ENV, "pyin");
    let imported = import_exercise_file(&state, external.to_string_lossy().to_string(), 2.0);
    let files_before = storage::exercises_takes_dir().read_dir().unwrap().count();
    std::env::set_var(crate::pitch::OVERRIDE_ENV, "not-an-algorithm");
    let rejected = import_exercise_file(&state, external.to_string_lossy().to_string(), 2.0).unwrap_err();
    let rejected_recording = save_exercise_take(&state, vec![1, 2, 3], 1.0).unwrap_err();
    std::env::remove_var(crate::pitch::OVERRIDE_ENV);
    assert!(rejected.contains(crate::pitch::OVERRIDE_ENV), "{rejected}");
    assert!(rejected_recording.contains(crate::pitch::OVERRIDE_ENV), "{rejected_recording}");
    assert_eq!(
        storage::exercises_takes_dir().read_dir().unwrap().count(),
        files_before,
        "a rejected override must not leave a copied or written file behind"
    );
    let imported = imported.expect("import");
    assert!(std::path::Path::new(&imported.filepath).exists(), "importing a .wav must not delete its only copy");
    assert_ne!(imported.filepath, external.to_string_lossy(), "the import is a copy inside the library");
    assert!(external.exists(), "the user's original is untouched");
    assert!(imported.pitch_data.is_some());

    let missing = import_exercise_file(&state, "/no/such/file.wav".into(), 1.0).unwrap_err();
    assert!(missing.contains("File not found"), "{missing}");

    let all = tauri::async_runtime::block_on(list_exercise_takes()).unwrap();
    assert_eq!(all.len(), 2);
}

#[test]
fn lyrics_sync_goes_through_the_real_sidecar_and_is_persisted() {
    let home = TestHome::new();
    std::env::set_var("USERPROFILE", home.path());
    std::env::set_var("HOME", home.path());
    // Test-only sidecar engine: places the letters evenly over the sung part of the
    // file, so this exercises the wire path without the 360 MB acoustic model.
    std::env::set_var("VPS_LYRICS_ENGINE", "uniform");

    let state = SidecarState(Mutex::new(None));
    match SidecarManager::spawn() {
        Ok(m) => *state.0.lock().unwrap() = Some(m),
        Err(e) => return sidecar_unavailable(&e),
    }

    let sr = 16000u32;
    let song_dir = storage::song_dir("song-ly");
    let mut samples = vec![0.0f32; sr as usize / 2];
    samples.extend(tones(&[(220.0, 0.3)], sr, 4.0));
    samples.extend(vec![0.0f32; sr as usize / 2]);
    write_wav(&song_dir.join("vocals.wav"), &samples, sr);
    library::add(library::Song {
        id: "song-ly".into(),
        title: "Lyrics Song".into(),
        artist: None,
        duration: 5.0,
        detected_key: None,
        detected_bpm: None,
        processed_at: "2026-01-01T00:00:00Z".into(),
        directory: song_dir.to_string_lossy().to_string(),
        kind: "vocal".into(),
        metronome_offset: None,
        folder_id: None,
        sort_index: 0,
    })
    .unwrap();

    let mut seen: Vec<(f32, String)> = Vec::new();
    let text = "[Verse]
hello there my friend
sing it out loud";
    let result = lyrics::sync_impl(&state, "song-ly", text, "paste", &mut |p, s| seen.push((p, s.to_string())))
        .expect("sync_lyrics");

    assert_eq!(result.lines.len(), 2, "the [Verse] marker is not a lyric line");
    assert_eq!(result.lines[0].text, "hello there my friend");
    assert_eq!(result.text, text, "the user's text is kept verbatim for re-syncing");
    assert_eq!(result.source, "paste");
    assert_eq!(result.aligner, "uniform-test-engine");
    let (a, b) = (&result.lines[0], &result.lines[1]);
    assert!(a.start >= 0.4 && a.start < a.end && a.end <= b.start && b.end <= 5.0, "{a:?} {b:?}");
    assert_eq!(a.words.len(), 4);
    assert!(a.words.windows(2).all(|w| w[0].start <= w[1].start));

    assert!(!seen.is_empty(), "progress is streamed");
    assert!(seen.windows(2).all(|w| w[0].0 <= w[1].0), "progress never goes backwards");
    assert_eq!(seen.last().unwrap().0, 1.0);

    assert_eq!(lyrics::load("song-ly").unwrap(), Some(result.clone()), "persisted to lyrics.json");
    assert!(song_dir.join("lyrics.json").exists());

    // A failure inside the sidecar surfaces as its own message and leaves the saved lyrics alone.
    std::fs::write(song_dir.join("vocals.wav"), vec![0u8; 16]).unwrap();
    let err = lyrics::sync_impl(&state, "song-ly", "la la la", "paste", &mut |_, _| {}).unwrap_err();
    assert!(err.to_lowercase().contains("read"), "{err}");
    assert_eq!(lyrics::load("song-ly").unwrap(), Some(result));

    // The sidecar is still healthy afterwards.
    write_wav(&song_dir.join("vocals.wav"), &samples, sr);
    lyrics::sync_impl(&state, "song-ly", "la la la", "paste", &mut |_, _| {}).expect("sync after a failure");

    std::env::remove_var("VPS_LYRICS_ENGINE");
}
