// Command name -> the sentence shown while it runs. A command left out is fast or
// reports its own progress (process_song, import_youtube, lyrics sync, updates).
export const ACTIVITY_LABELS: Readonly<Record<string, string>> = {
  pitch_shift_song: "Transposing…",
  save_take: "Analyzing take…",
  load_analysis: "Loading pitch analysis…",
  export_stem: "Exporting audio…",
  export_take: "Exporting take…",
  export_mix: "Exporting mix…",
  export_all: "Zipping tracks…",
  export_pack: "Building practice pack…",
  import_exercise_file: "Importing track…",
  save_exercise_take: "Saving take…",
  start_pack_share: "Starting phone share…",
};
