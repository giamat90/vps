import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ProcessingStatus, Song, Take, ExerciseTake } from "./types";

/** Process a song file through the Python sidecar */
export async function processSong(filePath: string, highQuality?: boolean): Promise<Song> {
  return invoke<Song>("process_song", { filePath, highQuality });
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
): Promise<Take> {
  return invoke<Take>("save_take", { songId, audioData, startPosition, audioOffset });
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

/** Load song analysis data (pitchData, onsets, dynamics, spectrogram) */
export async function loadAnalysis(songId: string): Promise<{
  pitchData: import("./types").PitchData;
  onsets: number[];
  dynamics: import("./types").DynamicsPoint[];
  spectroTimes?: number[];
  spectroB64?: string;
  spectroFrames?: number;
  spectroRows?: number;
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
export async function importYoutube(url: string, highQuality?: boolean): Promise<Song> {
  return invoke<Song>("import_youtube", { url, highQuality });
}

/** Open a native Save As dialog and copy a stem WAV to user-chosen location */
export async function exportStem(
  stemPath: string,
  suggestedName: string,
): Promise<void> {
  return invoke("export_stem", { stemPath, suggestedName });
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

/** Save a free-exercise recorded take */
export async function saveExerciseTake(audioData: number[], duration: number): Promise<ExerciseTake> {
  return invoke<ExerciseTake>("save_exercise_take", { audioData, duration });
}

/** List all exercise takes */
export async function listExerciseTakes(): Promise<ExerciseTake[]> {
  return invoke<ExerciseTake[]>("list_exercise_takes");
}

/** Delete an exercise take */
export async function deleteExerciseTakeApi(takeId: string): Promise<void> {
  return invoke("delete_exercise_take", { takeId });
}

/** Listen for processing progress events */
export function onProcessingProgress(
  callback: (status: ProcessingStatus) => void
): Promise<UnlistenFn> {
  return listen<ProcessingStatus>("processing-progress", (event) => {
    callback(event.payload);
  });
}
