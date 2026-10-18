import { create } from "zustand";
import { signInYoutube } from "@giamat90/mps-core/youtube";
import { createFriendlyError, libraryStateCreator, messageIncludes, type LibraryCoreState } from "@giamat90/mps-core/hooks";
import type { Folder, ProcessingStatus, Song } from "../lib/types";
import {
  createFolder as createFolderApi,
  deleteFolder as deleteFolderApi,
  deleteSong as apiDeleteSong,
  importYoutube as importYoutubeApi,
  listFolders,
  listSongs,
  moveSongs as moveSongsApi,
  onProcessingProgress,
  processSong,
  renameFolder as renameFolderApi,
  renameSongApi,
  reorderFolders as reorderFoldersApi,
  setSongIdentityApi,
} from "../lib/tauri";
import { useSettingsStore } from "./settings";

type YoutubeRequest = { url: string; highQuality?: boolean };
type Upload = [highQuality?: boolean, trackKind?: "vocal" | "instrument"];

interface LibraryState extends LibraryCoreState<Song, Folder, ProcessingStatus, YoutubeRequest, Upload> {
  importYoutube: (
    url: string,
    highQuality?: boolean,
    cookiesPath?: string | null,
    options?: { freshSession?: boolean },
  ) => Promise<void>;
}

const friendlyError = createFriendlyError({
  // Experiment-only switch (src-tauri/src/pitch.rs): its message already names the
  // bad value and the valid ones, which the generic text would hide.
  first: [messageIncludes(["vps_pitch_algorithm"], ({ raw }) => String(raw))],
  last: [
    messageIncludes(["ffmpeg", "ffprobe"], "ffmpeg was not found. Make sure ffmpeg is installed and on your system PATH."),
  ],
  uploadFallback: "Failed to process the audio file. Make sure it is a valid audio format.",
});

export const useLibraryStore = create<LibraryState>((set, get) => {
  const core = libraryStateCreator<Song, Folder, ProcessingStatus, YoutubeRequest, Upload, LibraryState>({
    api: {
      listSongs,
      listFolders,
      processSong,
      importYoutube: (request, cookiesPath) => importYoutubeApi(request.url, request.highQuality, cookiesPath),
      deleteSong: apiDeleteSong,
      renameSong: renameSongApi,
      setSongIdentity: setSongIdentityApi,
      createFolder: createFolderApi,
      renameFolder: renameFolderApi,
      deleteFolder: deleteFolderApi,
      reorderFolders: reorderFoldersApi,
      moveSongs: moveSongsApi,
      onProcessingProgress,
    },
    friendlyError,
    signInYoutube,
    saveCookiesPath: (path) => useSettingsStore.getState().setYoutubeCookiesPath(path),
  })(set, get);

  return {
    ...core,
    importYoutube: (url, highQuality, cookiesPath, options) =>
      core.importYoutubeRequest({ url, highQuality }, cookiesPath, options),
  };
});
