import { createSongFilter, normalizeForSearch } from "@giamat90/mps-core/hooks";
import type { Song } from "./types";

export { normalizeForSearch };

/** The songs whose title, artist, key, tempo, kind or folder contain every word of `query`, in the order given. */
export const filterSongs = createSongFilter<Song>({
  extraTerms: (song) => [song.artist ?? "", ...(song.kind === "instrument" ? ["instrument"] : [])],
});
