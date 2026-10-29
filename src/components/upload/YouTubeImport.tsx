import { useLibraryStore } from "../../stores/library";
import { useSettingsStore } from "../../stores/settings";
import { useYouTubeImport } from "@giamat90/mps-core/hooks";

interface YouTubeImportProps {
  highQuality?: boolean;
}

function YouTubeImport({ highQuality }: YouTubeImportProps) {
  const importYoutube = useLibraryStore((s) => s.importYoutube);
  const youtubeCookiesPath = useSettingsStore((s) => s.youtubeCookiesPath);
  const { url, setUrl, error, canSubmit, submit, onKeyDown } = useYouTubeImport({
    isProcessing: false,
    onImport: (link) => importYoutube(link, highQuality, youtubeCookiesPath),
  });

  return (
    <div className="yt-import">
      <div className="yt-import__row">
        <input
          className="yt-import__input"
          type="url"
          placeholder="Paste YouTube URL…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          className="yt-import__btn"
          onClick={submit}
          disabled={!canSubmit}
        >
          Import
        </button>
      </div>
      {error && <p className="yt-import__error">{error}</p>}
    </div>
  );
}

export default YouTubeImport;
