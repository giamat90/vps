import { useState } from "react";
import { useLibraryStore } from "../../stores/library";
import { useSettingsStore } from "../../stores/settings";
import type { PitchAlgorithm } from "../../lib/types";

const YT_PATTERN = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//;

interface YouTubeImportProps {
  highQuality?: boolean;
  algorithm?: PitchAlgorithm;
}

function YouTubeImport({ highQuality, algorithm }: YouTubeImportProps) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const importYoutube = useLibraryStore((s) => s.importYoutube);
  const isProcessing = useLibraryStore((s) => s.processing !== null);
  const youtubeCookiesPath = useSettingsStore((s) => s.youtubeCookiesPath);

  const handleImport = async () => {
    if (!YT_PATTERN.test(url)) {
      setError("Please enter a valid YouTube URL.");
      return;
    }
    setError(null);
    await importYoutube(url, highQuality, algorithm, youtubeCookiesPath);
    setUrl("");
  };

  return (
    <div className="yt-import">
      <div className="yt-import__row">
        <input
          className="yt-import__input"
          type="url"
          placeholder="Paste YouTube URL…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={isProcessing}
          onKeyDown={(e) => e.key === "Enter" && !isProcessing && handleImport()}
        />
        <button
          className="yt-import__btn"
          onClick={handleImport}
          disabled={isProcessing || !url.trim()}
        >
          Import
        </button>
      </div>
      {error && <p className="yt-import__error">{error}</p>}
    </div>
  );
}

export default YouTubeImport;
