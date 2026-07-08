use crate::library::{self, Song};
use crate::sidecar::{SidecarManager, SidecarMessage};
use crate::storage;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// Shared sidecar state — lazy-initialized on first use.
pub struct SidecarState(pub std::sync::Mutex<Option<SidecarManager>>);

/// Processing progress event payload (emitted to frontend).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingStatus {
    pub song_id: String,
    pub progress: f32,
    pub stage: String,
    pub is_complete: bool,
    pub error: Option<String>,
}

/// Minimum stSpectrumBins for a cached blob to be considered current —
/// bumped from 128 to 1024 (sidecar's compute_short_term_spectrum) so a
/// precomputed frame looks as smooth as the live FFT panels. Acts as a
/// version marker like stSpectrumMinDb/MaxDb: any cached blob below this
/// predates the bump and gets transparently recomputed rather than left
/// stale at the old resolution.
const ST_SPECTRUM_MIN_BINS: i64 = 1024;

/// Ensure sidecar is running, spawning if needed. Returns a lock guard.
fn ensure_sidecar(
    state: &SidecarState,
) -> Result<std::sync::MutexGuard<'_, Option<SidecarManager>>, String> {
    let mut guard = state.0.lock().map_err(|e| format!("lock: {e}"))?;
    if guard.is_none() {
        log::info!("Spawning sidecar for first use");
        *guard = Some(SidecarManager::spawn()?);
    }
    Ok(guard)
}

/// Backfill helper: compute the Short-Term Spectrum dataset for an audio file
/// already on disk, for library entries that predate this feature. Returns
/// None (logged, non-fatal) on any failure — callers just skip the backfill.
fn compute_st_spectrum(
    state: &SidecarState,
    audio_path: &str,
    audio_offset: f64,
) -> Option<serde_json::Value> {
    let guard = ensure_sidecar(state).ok()?;
    let sidecar = guard.as_ref()?;
    let cmd = serde_json::json!({
        "cmd": "compute_st_spectrum",
        "audioPath": audio_path,
        "audioOffset": audio_offset,
    });
    sidecar.send_command(&cmd).ok()?;
    let timeout = Duration::from_secs(120);
    loop {
        match sidecar.recv_timeout(timeout) {
            Ok(SidecarMessage::Result { data, .. }) => return Some(data),
            Ok(SidecarMessage::Error { message, .. }) => {
                log::warn!("compute_st_spectrum backfill error: {message}");
                return None;
            }
            Ok(SidecarMessage::Progress { .. }) => continue,
            _ => return None,
        }
    }
}

#[tauri::command]
pub async fn process_song(
    app: AppHandle,
    state: State<'_, SidecarState>,
    file_path: String,
    high_quality: Option<bool>,
    track_kind: Option<String>,
    algorithm: Option<String>,
) -> Result<Song, String> {
    let track_kind = track_kind.unwrap_or_else(|| "vocal".to_string());
    let skip_separation = track_kind == "instrument";
    let song_id = uuid::Uuid::new_v4().to_string();
    let output_dir = storage::song_dir(&song_id);

    // Copy source file into the song directory
    let src = std::path::Path::new(&file_path);
    if !src.exists() {
        return Err(format!("File not found: {file_path}"));
    }
    let file_name = src
        .file_name()
        .ok_or("Invalid file name")?
        .to_string_lossy();
    let title = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Unknown".to_string());
    let dest = output_dir.join(file_name.as_ref());
    std::fs::copy(src, &dest).map_err(|e| format!("Copy failed: {e}"))?;

    let output_dir_str = output_dir.to_string_lossy().to_string();
    let dest_str = dest.to_string_lossy().to_string();

    // Send process command to sidecar
    let cmd = serde_json::json!({
        "cmd": "process",
        "filePath": dest_str,
        "outputDir": output_dir_str,
        "highQuality": high_quality.unwrap_or(false),
        "skipSeparation": skip_separation,
        "algorithm": algorithm.unwrap_or_else(|| "srh".to_string()),
    });

    // Hold the lock for the duration of the processing to prevent concurrent jobs
    let guard = ensure_sidecar(&state)?;
    let sidecar = guard.as_ref().ok_or("Sidecar not available")?;
    sidecar.send_command(&cmd)?;

    // Read messages until we get a result or error
    let timeout = Duration::from_secs(600); // 10 min max for long songs
    loop {
        let msg = sidecar.recv_timeout(timeout)?;
        match msg {
            SidecarMessage::Progress { value, stage, .. } => {
                let _ = app.emit(
                    "processing-progress",
                    ProcessingStatus {
                        song_id: song_id.clone(),
                        progress: value,
                        stage,
                        is_complete: false,
                        error: None,
                    },
                );
            }
            SidecarMessage::Result { data, .. } => {
                let _ = app.emit(
                    "processing-progress",
                    ProcessingStatus {
                        song_id: song_id.clone(),
                        progress: 1.0,
                        stage: "complete".to_string(),
                        is_complete: true,
                        error: None,
                    },
                );

                // Extract metadata from result
                let detected_bpm = data.get("detectedBpm").and_then(|v| v.as_f64());
                let detected_key = data
                    .get("detectedKey")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                let duration = data
                    .get("pitchData")
                    .and_then(|v| v.as_array())
                    .and_then(|arr| arr.last())
                    .and_then(|p| p.get("time"))
                    .and_then(|t| t.as_f64())
                    .unwrap_or(0.0);

                let now = chrono::Utc::now().to_rfc3339();

                let song = Song {
                    id: song_id,
                    title,
                    artist: None,
                    duration,
                    detected_key,
                    detected_bpm,
                    processed_at: now,
                    directory: output_dir_str,
                    kind: track_kind.clone(),
                };

                // Save analysis data to analysis.json
                let analysis = serde_json::json!({
                    "pitchData":    data.get("pitchData").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                    "onsets":       data.get("onsets").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                    "dynamics":     data.get("dynamics").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                    "spectroTimes": data.get("spectroTimes").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                    "spectroB64":   data.get("spectroB64").cloned().unwrap_or(serde_json::Value::String(String::new())),
                    "spectroFrames":data.get("spectroFrames").cloned().unwrap_or(serde_json::Value::Number(0.into())),
                    "spectroRows":  data.get("spectroRows").cloned().unwrap_or(serde_json::Value::Number(40.into())),
                    "stSpectrumTimes": data.get("stSpectrumTimes").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                    "stSpectrumB64":   data.get("stSpectrumB64").cloned().unwrap_or(serde_json::Value::String(String::new())),
                    "stSpectrumFrames":data.get("stSpectrumFrames").cloned().unwrap_or(serde_json::Value::Number(0.into())),
                    "stSpectrumBins":  data.get("stSpectrumBins").cloned().unwrap_or(serde_json::Value::Number(0.into())),
                    "stSpectrumMinDb": data.get("stSpectrumMinDb").cloned().unwrap_or(serde_json::Value::Null),
                    "stSpectrumMaxDb": data.get("stSpectrumMaxDb").cloned().unwrap_or(serde_json::Value::Null),
                });
                let analysis_path = output_dir.join("analysis.json");
                if let Ok(json) = serde_json::to_string_pretty(&analysis) {
                    let _ = std::fs::write(&analysis_path, json);
                }

                // Persist to library.json
                library::add(song.clone())?;

                return Ok(song);
            }
            SidecarMessage::Error {
                message, traceback, ..
            } => {
                let detail = traceback.unwrap_or_default();
                log::error!("Sidecar error: {message}\n{detail}");
                let _ = app.emit(
                    "processing-progress",
                    ProcessingStatus {
                        song_id: song_id.clone(),
                        progress: 0.0,
                        stage: "error".to_string(),
                        is_complete: true,
                        error: Some(message.clone()),
                    },
                );
                return Err(message);
            }
            _ => {}
        }
    }
}

#[tauri::command]
pub async fn pitch_shift_song(
    state: State<'_, SidecarState>,
    song_dir: String,
    n_steps: i32,
) -> Result<serde_json::Value, String> {
    let cache_dir = std::path::Path::new(&song_dir)
        .join("pitched")
        .join(n_steps.to_string());
    let vocals_cache = cache_dir.join("vocals.wav");
    let instr_cache = cache_dir.join("instrumental.wav");

    // Return cached result without touching the sidecar
    if vocals_cache.exists() && instr_cache.exists() {
        return Ok(serde_json::json!({
            "vocalsPath": vocals_cache.to_string_lossy(),
            "instrumentalPath": instr_cache.to_string_lossy(),
        }));
    }

    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("mkdir: {e}"))?;

    let cmd = serde_json::json!({
        "cmd": "pitch_shift",
        "songDir": song_dir,
        "cacheDir": cache_dir.to_string_lossy(),
        "nSteps": n_steps,
    });
    let guard = ensure_sidecar(&state)?;
    let sidecar = guard.as_ref().ok_or("Sidecar not available")?;
    sidecar.send_command(&cmd)?;

    let timeout = Duration::from_secs(300);
    loop {
        let msg = sidecar.recv_timeout(timeout)?;
        match msg {
            SidecarMessage::Result { data, .. } => return Ok(data),
            SidecarMessage::Error { message, .. } => return Err(message),
            _ => {}
        }
    }
}

#[tauri::command]
pub async fn list_songs() -> Result<Vec<Song>, String> {
    library::load()
}

#[tauri::command]
pub async fn delete_song(song_id: String) -> Result<(), String> {
    library::remove(&song_id)
}

// --- Take commands ---

/// Take metadata for frontend (includes optional analysis data).
#[derive(Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Take {
    pub id: String,
    pub song_id: String,
    pub recorded_at: String,
    pub filepath: String,
    /// User-assigned display name; falls back to "Take N" in the UI when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Song position (seconds) where recording started; 0 for full-song takes.
    #[serde(default)]
    pub start_position: f64,
    /// Seconds into the audio file to skip on playback (non-zero when latency
    /// compensation exceeds startPosition).
    #[serde(default, skip_serializing_if = "crate::commands::is_zero_f64")]
    pub audio_offset: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pitch_data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub onsets: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dynamics: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vibrato: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub st_spectrum_times: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub st_spectrum_b64: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub st_spectrum_frames: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub st_spectrum_bins: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub st_spectrum_min_db: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub st_spectrum_max_db: Option<serde_json::Value>,
}

pub fn is_zero_f64(v: &f64) -> bool { *v == 0.0 }

fn takes_json_path(song_id: &str) -> std::path::PathBuf {
    storage::song_dir(song_id).join("takes.json")
}

fn load_takes(song_id: &str) -> Result<Vec<Take>, String> {
    let path = takes_json_path(song_id);
    if !path.exists() {
        return Ok(vec![]);
    }
    let data = std::fs::read_to_string(&path).map_err(|e| format!("Read takes: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Parse takes: {e}"))
}

fn save_takes(song_id: &str, takes: &[Take]) -> Result<(), String> {
    let path = takes_json_path(song_id);
    let data = serde_json::to_string_pretty(takes).map_err(|e| format!("Serialize: {e}"))?;
    std::fs::write(&path, data).map_err(|e| format!("Write takes: {e}"))
}

#[tauri::command]
pub async fn save_take(
    state: State<'_, SidecarState>,
    song_id: String,
    audio_data: Vec<u8>,
    start_position: f64,
    audio_offset: f64,
    algorithm: Option<String>,
) -> Result<Take, String> {
    let take_id = uuid::Uuid::new_v4().to_string();
    let takes_dir = storage::song_dir(&song_id).join("takes");
    std::fs::create_dir_all(&takes_dir).map_err(|e| format!("Create takes dir: {e}"))?;

    let file_path = takes_dir.join(format!("{take_id}.webm"));
    std::fs::write(&file_path, &audio_data).map_err(|e| format!("Write take: {e}"))?;

    let file_path_str = file_path.to_string_lossy().to_string();
    let output_dir_str = takes_dir.to_string_lossy().to_string();
    let vocals_path = storage::song_dir(&song_id).join("vocals.wav");
    let reference_path_str = vocals_path.exists().then(|| vocals_path.to_string_lossy().to_string());

    // Analyze the recording via sidecar (also RMS-normalizes loudness against vocals.wav)
    let (pitch_data, onsets, dynamics, vibrato, st_spectrum_times, st_spectrum_b64, st_spectrum_frames, st_spectrum_bins, st_spectrum_min_db, st_spectrum_max_db, normalized_path) = {
        let guard = ensure_sidecar(&state);
        if let Ok(guard) = guard {
            if let Some(sidecar) = guard.as_ref() {
                let mut cmd_obj = serde_json::json!({
                    "cmd": "analyze",
                    "recordingPath": file_path_str,
                    "outputDir": output_dir_str,
                    "audioOffset": audio_offset,
                    "algorithm": algorithm.clone().unwrap_or_else(|| "srh".to_string()),
                });
                if let Some(ref_path) = &reference_path_str {
                    cmd_obj["referencePath"] = serde_json::json!(ref_path);
                }
                let _ = sidecar.send_command(&cmd_obj);
                let timeout = std::time::Duration::from_secs(300);
                let mut result = (None, None, None, None, None, None, None, None, None, None, None);
                loop {
                    match sidecar.recv_timeout(timeout) {
                        Ok(SidecarMessage::Result { data, .. }) => {
                            result = (
                                data.get("pitchData").cloned(),
                                data.get("onsets").cloned(),
                                data.get("dynamics").cloned(),
                                data.get("vibrato").cloned(),
                                data.get("stSpectrumTimes").cloned(),
                                data.get("stSpectrumB64").cloned(),
                                data.get("stSpectrumFrames").cloned(),
                                data.get("stSpectrumBins").cloned(),
                                data.get("stSpectrumMinDb").cloned(),
                                data.get("stSpectrumMaxDb").cloned(),
                                data.get("normalizedPath").and_then(|v| v.as_str().map(|s| s.to_string())),
                            );
                            break;
                        }
                        Ok(SidecarMessage::Error { message, .. }) => {
                            log::warn!("Take analysis error: {message}");
                            break;
                        }
                        Ok(SidecarMessage::Progress { .. }) => continue,
                        _ => break,
                    }
                }
                result
            } else {
                (None, None, None, None, None, None, None, None, None, None, None)
            }
        } else {
            (None, None, None, None, None, None, None, None, None, None, None)
        }
    };

    // Prefer the loudness-normalized WAV; fall back to the raw webm if normalization failed.
    let final_file_path_str = match &normalized_path {
        Some(p) => {
            if let Err(e) = std::fs::remove_file(&file_path) {
                log::warn!("Could not remove raw take recording {file_path_str}: {e}");
            }
            p.clone()
        }
        None => file_path_str,
    };

    let take = Take {
        id: take_id,
        song_id: song_id.clone(),
        recorded_at: chrono::Utc::now().to_rfc3339(),
        filepath: final_file_path_str,
        name: None,
        start_position,
        audio_offset,
        pitch_data,
        onsets,
        dynamics,
        vibrato,
        st_spectrum_times,
        st_spectrum_b64,
        st_spectrum_frames,
        st_spectrum_bins,
        st_spectrum_min_db,
        st_spectrum_max_db,
    };

    let mut takes = load_takes(&song_id)?;
    takes.push(take.clone());
    save_takes(&song_id, &takes)?;

    Ok(take)
}

#[tauri::command]
pub async fn load_analysis(
    state: State<'_, SidecarState>,
    song_id: String,
) -> Result<serde_json::Value, String> {
    let song_dir = storage::song_dir(&song_id);
    let path = song_dir.join("analysis.json");
    if !path.exists() {
        return Ok(serde_json::json!({"pitchData": [], "onsets": [], "dynamics": []}));
    }
    let data = std::fs::read_to_string(&path).map_err(|e| format!("Read analysis: {e}"))?;
    let mut analysis: serde_json::Value =
        serde_json::from_str(&data).map_err(|e| format!("Parse analysis: {e}"))?;

    // Backfill: songs processed before the Short-Term Spectrum feature (or
    // before its dB range was widened to -100..0, or before its resolution
    // was raised to ST_SPECTRUM_MIN_BINS) won't have all three version-marker
    // fields in analysis.json — any older/lower-res encoding is transparently
    // recomputed rather than misread or left stale. Uses the already-separated
    // vocals.wav, so future loads skip straight to the cached data.
    let has_spectrum = analysis
        .get("stSpectrumB64")
        .and_then(|v| v.as_str())
        .is_some_and(|s| !s.is_empty())
        && analysis.get("stSpectrumMinDb").is_some_and(|v| v.is_number())
        && analysis.get("stSpectrumMaxDb").is_some_and(|v| v.is_number())
        && analysis.get("stSpectrumBins").and_then(|v| v.as_i64()).is_some_and(|b| b >= ST_SPECTRUM_MIN_BINS);
    if !has_spectrum {
        let vocals_path = song_dir.join("vocals.wav");
        if vocals_path.exists() {
            if let Some(result) = compute_st_spectrum(&state, &vocals_path.to_string_lossy(), 0.0) {
                if let Some(obj) = analysis.as_object_mut() {
                    for key in [
                        "stSpectrumTimes", "stSpectrumB64", "stSpectrumFrames",
                        "stSpectrumBins", "stSpectrumMinDb", "stSpectrumMaxDb",
                    ] {
                        if let Some(v) = result.get(key) {
                            obj.insert(key.to_string(), v.clone());
                        }
                    }
                }
                if let Ok(json) = serde_json::to_string_pretty(&analysis) {
                    let _ = std::fs::write(&path, json);
                }
            }
        }
    }

    Ok(analysis)
}

#[tauri::command]
pub async fn list_takes(state: State<'_, SidecarState>, song_id: String) -> Result<Vec<Take>, String> {
    let mut takes = load_takes(&song_id)?;
    let mut changed = false;

    // Same backfill/version-marker logic as load_analysis, per-take, using
    // each take's own recording file and stored latency offset.
    for take in takes.iter_mut() {
        let has_spectrum = take
            .st_spectrum_b64
            .as_ref()
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.is_empty())
            && take.st_spectrum_min_db.as_ref().is_some_and(|v| v.is_number())
            && take.st_spectrum_max_db.as_ref().is_some_and(|v| v.is_number())
            && take.st_spectrum_bins.as_ref().and_then(|v| v.as_i64()).is_some_and(|b| b >= ST_SPECTRUM_MIN_BINS);
        if has_spectrum || !std::path::Path::new(&take.filepath).exists() {
            continue;
        }
        if let Some(result) = compute_st_spectrum(&state, &take.filepath, take.audio_offset) {
            take.st_spectrum_times = result.get("stSpectrumTimes").cloned();
            take.st_spectrum_b64 = result.get("stSpectrumB64").cloned();
            take.st_spectrum_frames = result.get("stSpectrumFrames").cloned();
            take.st_spectrum_bins = result.get("stSpectrumBins").cloned();
            take.st_spectrum_min_db = result.get("stSpectrumMinDb").cloned();
            take.st_spectrum_max_db = result.get("stSpectrumMaxDb").cloned();
            changed = true;
        }
    }

    if changed {
        save_takes(&song_id, &takes)?;
    }
    Ok(takes)
}

#[tauri::command]
pub async fn delete_take(song_id: String, take_id: String) -> Result<(), String> {
    let takes = load_takes(&song_id)?;
    if let Some(take) = takes.iter().find(|t| t.id == take_id) {
        let path = std::path::Path::new(&take.filepath);
        if path.exists() {
            std::fs::remove_file(path).map_err(|e| format!("Delete take file: {e}"))?;
        }
    }
    let filtered: Vec<Take> = takes.into_iter().filter(|t| t.id != take_id).collect();
    save_takes(&song_id, &filtered)
}

#[tauri::command]
pub async fn rename_take(song_id: String, take_id: String, name: String) -> Result<Take, String> {
    let mut takes = load_takes(&song_id)?;
    let trimmed = name.trim();
    let take = takes
        .iter_mut()
        .find(|t| t.id == take_id)
        .ok_or_else(|| format!("Take not found: {take_id}"))?;
    take.name = if trimmed.is_empty() { None } else { Some(trimmed.to_string()) };
    let updated = take.clone();
    save_takes(&song_id, &takes)?;
    Ok(updated)
}

// --- Exercise take commands ---

#[derive(Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExerciseTake {
    pub id: String,
    pub recorded_at: String,
    pub filepath: String,
    pub duration: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pitch_data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dynamics: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vibrato: Option<serde_json::Value>,
}

fn exercises_json_path() -> std::path::PathBuf {
    storage::exercises_dir().join("exercises.json")
}

fn load_exercise_takes() -> Result<Vec<ExerciseTake>, String> {
    let path = exercises_json_path();
    if !path.exists() {
        return Ok(vec![]);
    }
    let data = std::fs::read_to_string(&path).map_err(|e| format!("Read exercises: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Parse exercises: {e}"))
}

fn save_exercise_takes_list(takes: &[ExerciseTake]) -> Result<(), String> {
    let path = exercises_json_path();
    let data = serde_json::to_string_pretty(takes).map_err(|e| format!("Serialize: {e}"))?;
    std::fs::write(&path, data).map_err(|e| format!("Write exercises: {e}"))
}

// Shared by save_exercise_take (raw recorded bytes) and import_exercise_file
// (an arbitrary external file copied in) — both need: sidecar `analyze`,
// preferring its loudness-normalized output over the raw/copied file, then
// build + persist the resulting ExerciseTake.
fn analyze_and_persist_exercise_take(
    state: &State<'_, SidecarState>,
    analyze_path: &str,
    raw_file_path: String,
    output_dir_str: &str,
    take_id: String,
    duration: f64,
    algorithm: Option<String>,
) -> Result<ExerciseTake, String> {
    let (pitch_data, dynamics, vibrato, normalized_path) = {
        let guard = ensure_sidecar(state);
        if let Ok(guard) = guard {
            if let Some(sidecar) = guard.as_ref() {
                let cmd = serde_json::json!({
                    "cmd": "analyze",
                    "recordingPath": analyze_path,
                    "outputDir": output_dir_str,
                    "algorithm": algorithm.unwrap_or_else(|| "srh".to_string()),
                });
                let _ = sidecar.send_command(&cmd);
                let timeout = std::time::Duration::from_secs(300);
                let mut result = (None, None, None, None);
                loop {
                    match sidecar.recv_timeout(timeout) {
                        Ok(SidecarMessage::Result { data, .. }) => {
                            result = (
                                data.get("pitchData").cloned(),
                                data.get("dynamics").cloned(),
                                data.get("vibrato").cloned(),
                                data.get("normalizedPath").and_then(|v| v.as_str().map(|s| s.to_string())),
                            );
                            break;
                        }
                        Ok(SidecarMessage::Error { message, .. }) => {
                            log::warn!("Exercise take analysis error: {message}");
                            break;
                        }
                        Ok(SidecarMessage::Progress { .. }) => continue,
                        _ => break,
                    }
                }
                result
            } else {
                (None, None, None, None)
            }
        } else {
            (None, None, None, None)
        }
    };

    // Prefer the loudness-normalized WAV; fall back to the raw/copied file if normalization failed.
    // The sidecar derives the normalized path by swapping the raw file's extension for
    // ".wav" (see analysis.py) — if the raw file was ALREADY a .wav (e.g. an imported
    // file, unlike a recorded take's always-.webm raw file), that derived path is the
    // exact same file, and removing "raw_file_path" would delete the only copy that
    // exists. Only remove it when normalization actually produced a distinct file.
    let final_file_path_str = match &normalized_path {
        Some(p) if p != &raw_file_path => {
            if let Err(e) = std::fs::remove_file(&raw_file_path) {
                log::warn!("Could not remove raw exercise take recording {raw_file_path}: {e}");
            }
            p.clone()
        }
        Some(p) => p.clone(),
        None => raw_file_path,
    };

    let take = ExerciseTake {
        id: take_id,
        recorded_at: chrono::Utc::now().to_rfc3339(),
        filepath: final_file_path_str,
        duration,
        pitch_data,
        dynamics,
        vibrato,
    };

    let mut takes = load_exercise_takes()?;
    takes.push(take.clone());
    save_exercise_takes_list(&takes)?;

    Ok(take)
}

#[tauri::command]
pub async fn save_exercise_take(
    state: State<'_, SidecarState>,
    audio_data: Vec<u8>,
    duration: f64,
    algorithm: Option<String>,
) -> Result<ExerciseTake, String> {
    let take_id = uuid::Uuid::new_v4().to_string();
    let takes_dir = storage::exercises_takes_dir();

    let file_path = takes_dir.join(format!("{take_id}.webm"));
    std::fs::write(&file_path, &audio_data).map_err(|e| format!("Write exercise take: {e}"))?;

    let file_path_str = file_path.to_string_lossy().to_string();
    let output_dir_str = takes_dir.to_string_lossy().to_string();

    analyze_and_persist_exercise_take(&state, &file_path_str, file_path_str.clone(), &output_dir_str, take_id, duration, algorithm)
}

#[tauri::command]
pub async fn import_exercise_file(
    state: State<'_, SidecarState>,
    file_path: String,
    duration: f64,
    algorithm: Option<String>,
) -> Result<ExerciseTake, String> {
    let take_id = uuid::Uuid::new_v4().to_string();
    let takes_dir = storage::exercises_takes_dir();
    std::fs::create_dir_all(&takes_dir).map_err(|e| format!("Create exercise takes dir: {e}"))?;

    let src = std::path::Path::new(&file_path);
    if !src.exists() {
        return Err(format!("File not found: {file_path}"));
    }
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("wav");
    let dest = takes_dir.join(format!("{take_id}.{ext}"));
    std::fs::copy(src, &dest).map_err(|e| format!("Copy imported exercise file: {e}"))?;

    let dest_str = dest.to_string_lossy().to_string();
    let output_dir_str = takes_dir.to_string_lossy().to_string();

    // Analyze the copied file, not the original source, so the persisted
    // ExerciseTake's filepath always matches what analyze actually ran against.
    analyze_and_persist_exercise_take(&state, &dest_str, dest_str.clone(), &output_dir_str, take_id, duration, algorithm)
}

#[tauri::command]
pub async fn list_exercise_takes() -> Result<Vec<ExerciseTake>, String> {
    load_exercise_takes()
}

#[tauri::command]
pub async fn delete_exercise_take(take_id: String) -> Result<(), String> {
    let takes = load_exercise_takes()?;
    if let Some(take) = takes.iter().find(|t| t.id == take_id) {
        let path = std::path::Path::new(&take.filepath);
        if path.exists() {
            std::fs::remove_file(path).map_err(|e| format!("Delete exercise take file: {e}"))?;
        }
    }
    let filtered: Vec<ExerciseTake> = takes.into_iter().filter(|t| t.id != take_id).collect();
    save_exercise_takes_list(&filtered)
}

#[tauri::command]
pub async fn import_youtube(
    app: AppHandle,
    state: State<'_, SidecarState>,
    url: String,
    high_quality: Option<bool>,
    algorithm: Option<String>,
) -> Result<Song, String> {
    if !url.contains("youtube.com/") && !url.contains("youtu.be/") {
        return Err("Not a valid YouTube URL".to_string());
    }

    let song_id = uuid::Uuid::new_v4().to_string();
    let output_dir = storage::song_dir(&song_id);
    let output_dir_str = output_dir.to_string_lossy().to_string();

    let cmd = serde_json::json!({
        "cmd": "import_yt",
        "url": url,
        "outputDir": output_dir_str,
        "highQuality": high_quality.unwrap_or(false),
        "algorithm": algorithm.unwrap_or_else(|| "srh".to_string()),
    });

    let guard = ensure_sidecar(&state)?;
    let sidecar = guard.as_ref().ok_or("Sidecar not available")?;
    sidecar.send_command(&cmd)?;

    let timeout = Duration::from_secs(900);
    loop {
        let msg = sidecar.recv_timeout(timeout)?;
        match msg {
            SidecarMessage::Progress { value, stage, .. } => {
                let _ = app.emit(
                    "processing-progress",
                    ProcessingStatus {
                        song_id: song_id.clone(),
                        progress: value,
                        stage,
                        is_complete: false,
                        error: None,
                    },
                );
            }
            SidecarMessage::Result { data, .. } => {
                let _ = app.emit(
                    "processing-progress",
                    ProcessingStatus {
                        song_id: song_id.clone(),
                        progress: 1.0,
                        stage: "complete".to_string(),
                        is_complete: true,
                        error: None,
                    },
                );

                let title = data
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown")
                    .to_string();
                let detected_bpm = data.get("detectedBpm").and_then(|v| v.as_f64());
                let detected_key = data
                    .get("detectedKey")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let duration = data
                    .get("pitchData")
                    .and_then(|v| v.as_array())
                    .and_then(|arr| arr.last())
                    .and_then(|p| p.get("time"))
                    .and_then(|t| t.as_f64())
                    .unwrap_or(0.0);

                let song = Song {
                    id: song_id,
                    title,
                    artist: None,
                    duration,
                    detected_key,
                    detected_bpm,
                    processed_at: chrono::Utc::now().to_rfc3339(),
                    directory: output_dir_str,
                    kind: "vocal".to_string(),
                };

                let analysis = serde_json::json!({
                    "pitchData":    data.get("pitchData").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                    "onsets":       data.get("onsets").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                    "dynamics":     data.get("dynamics").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                    "spectroTimes": data.get("spectroTimes").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                    "spectroB64":   data.get("spectroB64").cloned().unwrap_or(serde_json::Value::String(String::new())),
                    "spectroFrames":data.get("spectroFrames").cloned().unwrap_or(serde_json::Value::Number(0.into())),
                    "spectroRows":  data.get("spectroRows").cloned().unwrap_or(serde_json::Value::Number(40.into())),
                    "stSpectrumTimes": data.get("stSpectrumTimes").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                    "stSpectrumB64":   data.get("stSpectrumB64").cloned().unwrap_or(serde_json::Value::String(String::new())),
                    "stSpectrumFrames":data.get("stSpectrumFrames").cloned().unwrap_or(serde_json::Value::Number(0.into())),
                    "stSpectrumBins":  data.get("stSpectrumBins").cloned().unwrap_or(serde_json::Value::Number(0.into())),
                    "stSpectrumMinDb": data.get("stSpectrumMinDb").cloned().unwrap_or(serde_json::Value::Null),
                    "stSpectrumMaxDb": data.get("stSpectrumMaxDb").cloned().unwrap_or(serde_json::Value::Null),
                });
                let analysis_path = output_dir.join("analysis.json");
                if let Ok(json) = serde_json::to_string_pretty(&analysis) {
                    let _ = std::fs::write(&analysis_path, json);
                }

                library::add(song.clone())?;
                return Ok(song);
            }
            SidecarMessage::Error {
                message, traceback, ..
            } => {
                let detail = traceback.unwrap_or_default();
                log::error!("YT import error: {message}\n{detail}");
                let _ = app.emit(
                    "processing-progress",
                    ProcessingStatus {
                        song_id: song_id.clone(),
                        progress: 0.0,
                        stage: "error".to_string(),
                        is_complete: true,
                        error: Some(message.clone()),
                    },
                );
                return Err(message);
            }
            _ => {}
        }
    }
}

#[tauri::command]
pub async fn export_stem(
    app: AppHandle,
    stem_path: String,
    suggested_name: String,
) -> Result<(), String> {
    use tauri_plugin_dialog::DialogExt;

    let src = std::path::Path::new(&stem_path);
    if !src.exists() {
        return Err(format!("Stem not found: {stem_path}"));
    }

    let dest = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let suggested_name = suggested_name.clone();
        move || {
            app.dialog()
                .file()
                .set_file_name(&suggested_name)
                .add_filter("Audio", &["wav"])
                .blocking_save_file()
        }
    })
    .await
    .map_err(|e| format!("Dialog task: {e}"))?;

    if let Some(path) = dest {
        std::fs::copy(src, path.as_path().ok_or("Invalid path")?)
            .map_err(|e| format!("Copy failed: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn export_take(
    app: AppHandle,
    state: State<'_, SidecarState>,
    take_path: String,
    suggested_name: String,
) -> Result<(), String> {
    use tauri_plugin_dialog::DialogExt;

    let src = std::path::Path::new(&take_path);
    if !src.exists() {
        return Err(format!("Take not found: {take_path}"));
    }

    // The take is typically webm/opus; decode it via the sidecar into a
    // temp WAV file, then offer that file through the Save-As dialog.
    let temp_path = std::env::temp_dir().join(format!("{}.wav", uuid::Uuid::new_v4()));
    let cmd = serde_json::json!({
        "cmd": "convert_take",
        "recordingPath": take_path,
        "outputPath": temp_path.to_string_lossy(),
    });
    {
        let guard = ensure_sidecar(&state)?;
        let sidecar = guard.as_ref().ok_or("Sidecar not available")?;
        sidecar.send_command(&cmd)?;

        let timeout = Duration::from_secs(120);
        loop {
            match sidecar.recv_timeout(timeout)? {
                SidecarMessage::Result { .. } => break,
                SidecarMessage::Error { message, .. } => return Err(message),
                _ => {}
            }
        }
    }
    let _temp_guard = TempFile(temp_path.clone());

    let dest = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let suggested_name = suggested_name.clone();
        move || {
            app.dialog()
                .file()
                .set_file_name(&suggested_name)
                .add_filter("Audio", &["wav"])
                .blocking_save_file()
        }
    })
    .await
    .map_err(|e| format!("Dialog task: {e}"))?;

    if let Some(path) = dest {
        std::fs::copy(&temp_path, path.as_path().ok_or("Invalid path")?)
            .map_err(|e| format!("Copy failed: {e}"))?;
    }
    Ok(())
}

/// One track to include in an `export_mix` render. `gain` is the final
/// linear volume already resolved from mute/solo/volume by the frontend —
/// this command has no concept of mute/solo, only gains. `start_position`/
/// `audio_offset` are only meaningful for `is_take` sources (see the
/// `fileTime = projectTime - startPosition + audioOffset` mapping in
/// `player.ts`); omitted for plain stem/instrumental sources.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MixSource {
    pub path: String,
    pub gain: f64,
    pub is_take: bool,
    pub start_position: Option<f64>,
    pub audio_offset: Option<f64>,
}

#[tauri::command]
pub async fn export_mix(
    app: AppHandle,
    state: State<'_, SidecarState>,
    sources: Vec<MixSource>,
    start_sec: f64,
    end_sec: f64,
    suggested_name: String,
) -> Result<(), String> {
    use tauri_plugin_dialog::DialogExt;

    if sources.is_empty() {
        return Err("No audible tracks to export".to_string());
    }

    let temp_path = std::env::temp_dir().join(format!("{}.wav", uuid::Uuid::new_v4()));
    let cmd = serde_json::json!({
        "cmd": "mix_export",
        "outputPath": temp_path.to_string_lossy(),
        "startSec": start_sec,
        "endSec": end_sec,
        "sources": sources,
    });
    {
        let guard = ensure_sidecar(&state)?;
        let sidecar = guard.as_ref().ok_or("Sidecar not available")?;
        sidecar.send_command(&cmd)?;

        let timeout = Duration::from_secs(120);
        loop {
            match sidecar.recv_timeout(timeout)? {
                SidecarMessage::Result { .. } => break,
                SidecarMessage::Error { message, .. } => return Err(message),
                _ => {}
            }
        }
    }
    let _temp_guard = TempFile(temp_path.clone());

    let dest = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let suggested_name = suggested_name.clone();
        move || {
            app.dialog()
                .file()
                .set_file_name(&suggested_name)
                .add_filter("Audio", &["wav"])
                .blocking_save_file()
        }
    })
    .await
    .map_err(|e| format!("Dialog task: {e}"))?;

    if let Some(path) = dest {
        std::fs::copy(&temp_path, path.as_path().ok_or("Invalid path")?)
            .map_err(|e| format!("Copy failed: {e}"))?;
    }
    Ok(())
}

/// Deletes the wrapped temp file when dropped.
struct TempFile(std::path::PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        if let Err(e) = std::fs::remove_file(&self.0) {
            log::warn!("Failed to remove temp export file {:?}: {e}", self.0);
        }
    }
}
