import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ProcessingStatus, Song, Take, ExerciseTake, PitchAlgorithm } from "./types";

/** Process a song file through the Python sidecar */
export async function processSong(
  filePath: string,
  highQuality?: boolean,
  trackKind?: "vocal" | "instrument",
  algorithm?: PitchAlgorithm
): Promise<Song> {
  return invoke<Song>("process_song", { filePath, highQuality, trackKind, algorithm });
}

/** List all songs in the library */
export async function listSongs(): Promise<Song[]> {
  return invoke<Song[]>("list_songs");
}

/** Delete a song from the library */
export async function deleteSong(songId: string): Promise<void> {
  return invoke("delete_song", { songId });
}

/** Save a recorded take */
export async function saveTake(
  songId: string,
  audioData: number[],
  startPosition: number,
  audioOffset = 0,
  algorithm?: PitchAlgorithm,
): Promise<Take> {
  return invoke<Take>("save_take", { songId, audioData, startPosition, audioOffset, algorithm });
}

/** List takes for a song */
export async function listTakes(songId: string): Promise<Take[]> {
  return invoke<Take[]>("list_takes", { songId });
}

/** Delete a take */
export async function deleteTakeApi(songId: string, takeId: string): Promise<void> {
  return invoke("delete_take", { songId, takeId });
}

/** Rename a take (empty/whitespace name clears it back to the default "Take N" label) */
export async function renameTakeApi(songId: string, takeId: string, name: string): Promise<Take> {
  return invoke<Take>("rename_take", { songId, takeId, name });
}

/** Persist a manual drag nudge (seconds, signed) on top of a take's auto-detected startPosition; 0 clears it back to that position */
export async function setTakeManualOffsetApi(songId: string, takeId: string, offset: number): Promise<Take> {
  return invoke<Take>("set_take_manual_offset", { songId, takeId, offset });
}

/** Persist the metronome's downbeat anchor (song time, seconds) for this song; null clears it back to song start */
export async function setMetronomeOffsetApi(songId: string, offset: number | null): Promise<Song> {
  return invoke<Song>("set_metronome_offset", { songId, offset });
}

/** Rename a song's library title (e.g. to tell apart reprocessed variants using a different pitch algorithm). Empty/whitespace is rejected. */
export async function renameSongApi(songId: string, title: string): Promise<Song> {
  return invoke<Song>("rename_song", { songId, title });
}

/** Load song analysis data (pitchData, onsets, dynamics, spectrogram) */
export async function loadAnalysis(songId: string): Promise<{
  pitchData: import("./types").PitchData;
  onsets: number[];
  dynamics: import("./types").DynamicsPoint[];
  spectroTimes?: number[];
  spectroB64?: string;
  spectroFrames?: number;
  spectroRows?: number;
  stSpectrumTimes?: number[];
  stSpectrumB64?: string;
  stSpectrumFrames?: number;
  stSpectrumBins?: number;
  stSpectrumMinDb?: number;
  stSpectrumMaxDb?: number;
}> {
  return invoke("load_analysis", { songId });
}

/** Pitch-shift both tracks for a song; returns paths to the shifted WAV files */
export async function pitchShiftSong(
  songDir: string,
  nSteps: number,
): Promise<{ vocalsPath: string; instrumentalPath: string }> {
  return invoke("pitch_shift_song", { songDir, nSteps });
}

/** Import a YouTube URL through yt-dlp + Demucs pipeline */
export async function importYoutube(url: string, highQuality?: boolean, algorithm?: PitchAlgorithm): Promise<Song> {
  return invoke<Song>("import_youtube", { url, highQuality, algorithm });
}

/** Open a native Save As dialog and copy a stem WAV to user-chosen location */
export async function exportStem(
  stemPath: string,
  suggestedName: string,
): Promise<void> {
  return invoke("export_stem", { stemPath, suggestedName });
}

export interface ZipExportEntry {
  path: string;
  archiveName: string;
}

/** Open a native Save As dialog and bundle stems + takes into a zip archive */
export async function exportAll(entries: ZipExportEntry[], suggestedName: string): Promise<void> {
  return invoke("export_all", { entries, suggestedName });
}

/**
 * Open a native Save As dialog and write a recorded take to a user-chosen
 * location as WAV. The take (typically webm/opus) is decoded via the
 * Python sidecar first.
 */
export async function exportTake(
  takePath: string,
  suggestedName: string,
): Promise<void> {
  return invoke("export_take", { takePath, suggestedName });
}

export interface MixSource {
  path: string;
  gain: number;
  isTake: boolean;
  startPosition?: number;
  audioOffset?: number;
  manualOffset?: number;
}

/**
 * Render a mixdown WAV from `sources` (each already resolved to a final
 * linear gain by the caller) trimmed to [startSec, endSec) of the project
 * timeline, then open a native Save As dialog for the result.
 */
export async function exportMix(
  sources: MixSource[],
  startSec: number,
  endSec: number,
  suggestedName: string,
): Promise<void> {
  return invoke("export_mix", { sources, startSec, endSec, suggestedName });
}

/** Save a free-exercise recorded take */
export async function saveExerciseTake(audioData: number[], duration: number, algorithm?: PitchAlgorithm): Promise<ExerciseTake> {
  return invoke<ExerciseTake>("save_exercise_take", { audioData, duration, algorithm });
}

/** List all exercise takes */
export async function listExerciseTakes(): Promise<ExerciseTake[]> {
  return invoke<ExerciseTake[]>("list_exercise_takes");
}

/** Delete an exercise take */
export async function deleteExerciseTakeApi(takeId: string): Promise<void> {
  return invoke("delete_exercise_take", { takeId });
}

/** Import an arbitrary external audio file into Free Exercise as an ExerciseTake */
export async function importExerciseFile(filePath: string, duration: number, algorithm?: PitchAlgorithm): Promise<ExerciseTake> {
  return invoke<ExerciseTake>("import_exercise_file", { filePath, duration, algorithm });
}

/** Listen for processing progress events */
export function onProcessingProgress(
  callback: (status: ProcessingStatus) => void
): Promise<UnlistenFn> {
  return listen<ProcessingStatus>("processing-progress", (event) => {
    callback(event.payload);
  });
}
