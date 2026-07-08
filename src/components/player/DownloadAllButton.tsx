import { useState } from "react";
import { usePlayerStore } from "../../stores/player";
import { exportAll, type ZipExportEntry } from "../../lib/tauri";
import type { Song } from "../../lib/types";

function DownloadAllButton({ song }: { song: Song }) {
  const takes = usePlayerStore((s) => s.takes);
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const dir = song.directory.replace(/\\/g, "/");
      const isInstrument = song.kind === "instrument";
      const entries: ZipExportEntry[] = [
        { path: `${dir}/vocals.wav`, archiveName: isInstrument ? "Melody.wav" : "Vocals.wav" },
      ];
      if (!isInstrument) {
        entries.push({ path: `${dir}/instrumental.wav`, archiveName: "Instrumental.wav" });
      }

      const usedNames = new Set(entries.map((e) => e.archiveName));
      takes.forEach((take, i) => {
        const base = take.name || `Take ${i + 1}`;
        let archiveName = `${base}.wav`;
        let n = 2;
        while (usedNames.has(archiveName)) {
          archiveName = `${base} (${n++}).wav`;
        }
        usedNames.add(archiveName);
        entries.push({ path: take.filepath, archiveName });
      });

      await exportAll(entries, `${song.title}.zip`);
    } catch (e) {
      console.error("[DownloadAllButton] exportAll failed:", e);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <button
      className="practice-room__download-all"
      onClick={() => void handleExport()}
      disabled={isExporting}
      title="Download all tracks and takes as a zip archive"
    >
      {isExporting ? "Zipping…" : "Download All"}
    </button>
  );
}

export default DownloadAllButton;
