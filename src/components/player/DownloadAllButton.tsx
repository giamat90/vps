import { useDownloadAll } from "@giamat90/mps-core/hooks";
import { usePlayerStore } from "../../stores/player";
import { exportAll, type ZipExportEntry } from "../../lib/tauri";
import type { Song } from "../../lib/types";

function trackEntries(song: Song, directory: string): ZipExportEntry[] {
  const isInstrument = song.kind === "instrument";
  const entries: ZipExportEntry[] = [
    { path: `${directory}/vocals.wav`, archiveName: isInstrument ? "Melody.wav" : "Vocals.wav" },
  ];
  if (!isInstrument) {
    entries.push({ path: `${directory}/instrumental.wav`, archiveName: "Instrumental.wav" });
  }
  return entries;
}

function DownloadAllButton({ song }: { song: Song }) {
  const download = useDownloadAll({ store: usePlayerStore, song, trackEntries, exportAll });

  return (
    <button
      className="practice-room__download-all"
      onClick={() => void download.onDownload()}
      disabled={download.isExporting}
      title="Download all tracks and takes as a zip archive"
    >
      {download.isExporting ? "Zipping…" : "Download All"}
    </button>
  );
}

export default DownloadAllButton;
