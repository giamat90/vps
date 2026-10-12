import type { Folder, Song } from "./types";

/** Lower case, accents removed, runs of spaces collapsed: what two spellings of a name have in common. */
export function normalizeForSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function haystack(song: Song, folderName: string | undefined): string {
  const parts = [song.title, song.artist ?? "", song.detectedKey ?? "", folderName ?? ""];
  if (song.detectedBpm) parts.push(`${Math.round(song.detectedBpm)} bpm`);
  if (song.kind === "instrument") parts.push("instrument");
  return normalizeForSearch(parts.join(" "));
}

/** The songs whose title, artist, key, tempo, kind or folder contain every word of `query`, in the order given. */
export function filterSongs(songs: Song[], folders: Folder[], query: string): Song[] {
  const words = normalizeForSearch(query).split(" ").filter(Boolean);
  if (words.length === 0) return songs;
  const folderNames = new Map(folders.map((f) => [f.id, f.name]));
  return songs.filter((song) => {
    const text = haystack(song, song.folderId ? folderNames.get(song.folderId) : undefined);
    return words.every((w) => text.includes(w));
  });
}
