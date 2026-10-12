import { describe, it, expect } from "vitest";
import { filterSongs, normalizeForSearch } from "./librarySearch";
import type { Folder, Song } from "./types";

const song = (id: string, title: string, extra: Partial<Song> = {}): Song => ({
  id, title, duration: 200, processedAt: "", directory: `/lib/${id}`, sortIndex: 0, ...extra,
});
const folder = (id: string, name: string): Folder => ({ id, name, sortIndex: 0 });

describe("normalizeForSearch", () => {
  it("lowercases, drops accents and collapses spaces", () => {
    expect(normalizeForSearch("  Café   DEL  Mar ")).toBe("cafe del mar");
  });
});

describe("filterSongs", () => {
  const songs = [
    song("a", "Back in Black", { detectedKey: "E minor", detectedBpm: 93.4, folderId: "f1" }),
    song("b", "Hotel California", { detectedKey: "B minor", detectedBpm: 74 }),
    song("c", "Café del Mar", { detectedKey: "A major", detectedBpm: 120.2, artist: "Gotan Project" }),
    song("d", "Scales in C", { kind: "instrument" }),
  ];
  const folders = [folder("f1", "AC/DC")];
  const ids = (q: string) => filterSongs(songs, folders, q).map((s) => s.id);

  it("returns every song for an empty or blank query", () => {
    expect(ids("")).toEqual(["a", "b", "c", "d"]);
    expect(ids("   ")).toEqual(["a", "b", "c", "d"]);
  });

  it("matches the title, whatever the case", () => {
    expect(ids("hotel")).toEqual(["b"]);
    expect(ids("BLACK")).toEqual(["a"]);
  });

  it("matches without accents", () => {
    expect(ids("cafe")).toEqual(["c"]);
    expect(ids("café")).toEqual(["c"]);
  });

  it("needs every word to match, in any order", () => {
    expect(ids("black back")).toEqual(["a"]);
    expect(ids("hotel black")).toEqual([]);
  });

  it("matches the artist and the instrument kind", () => {
    expect(ids("gotan")).toEqual(["c"]);
    expect(ids("instrument")).toEqual(["d"]);
  });

  it("matches the key, the tempo and the folder", () => {
    expect(ids("minor")).toEqual(["a", "b"]);
    expect(ids("120")).toEqual(["c"]);
    expect(ids("ac/dc")).toEqual(["a"]);
  });

  it("keeps the order it was given", () => {
    expect(filterSongs([...songs].reverse(), folders, "minor").map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("does not change the list it was given", () => {
    const before = [...songs];
    filterSongs(songs, folders, "hotel");
    expect(songs).toEqual(before);
  });
});
