import { create } from "zustand";
import type { ProcessingStatus, Song } from "../lib/types";
import {
  deleteSong as apiDeleteSong,
  importYoutube as importYoutubeApi,
  listSongs,
  onProcessingProgress,
  processSong,
} from "../lib/tauri";

interface LibraryState {
  songs: Song[];
  processing: ProcessingStatus | null;
  isLoading: boolean;

  fetchSongs: () => Promise<void>;
  uploadSong: (filePath: string) => Promise<void>;
  importYoutube: (url: string) => Promise<void>;
  deleteSong: (songId: string) => Promise<void>;
  initProgressListener: () => Promise<() => void>;
}

export const useLibraryStore = create<LibraryState>((set) => ({
  songs: [],
  processing: null,
  isLoading: false,

  fetchSongs: async () => {
    set({ isLoading: true });
    try {
      const songs = await listSongs();
      set({ songs, isLoading: false });
    } catch (e) {
      console.error("Failed to fetch songs:", e);
      set({ isLoading: false });
    }
  },

  uploadSong: async (filePath: string) => {
    try {
      const song = await processSong(filePath);
      set((state) => ({
        songs: [...state.songs, song],
        processing: null,
      }));
    } catch (e) {
      console.error("Failed to process song:", e);
      set({ processing: null });
    }
  },

  importYoutube: async (url: string) => {
    try {
      const song = await importYoutubeApi(url);
      set((state) => ({
        songs: [...state.songs, song],
        processing: null,
      }));
    } catch (e) {
      console.error("YouTube import failed:", e);
      set({ processing: null });
    }
  },

  deleteSong: async (songId: string) => {
    try {
      await apiDeleteSong(songId);
      set((state) => ({
        songs: state.songs.filter((s) => s.id !== songId),
      }));
    } catch (e) {
      console.error("Failed to delete song:", e);
    }
  },

  initProgressListener: async () => {
    const unlisten = await onProcessingProgress((status) => {
      set({ processing: status.isComplete ? null : status });
    });
    return unlisten;
  },
}));
