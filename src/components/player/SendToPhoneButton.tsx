import { useState } from "react";
import { exportPack, type PackSummary } from "../../lib/tauri";
import type { Song } from "../../lib/types";

function describe(summary: PackSummary): string {
  const mb = (summary.sizeBytes / (1024 * 1024)).toFixed(1);
  const parts = [`${mb} MB`];
  if (summary.variants.length > 0) parts.push(`${summary.variants.length} transposition${summary.variants.length === 1 ? "" : "s"}`);
  if (summary.hasLyrics) parts.push("lyrics");
  if (!summary.hasReference) parts.push("no reference melody");
  return parts.join(", ");
}

function SendToPhoneButton({ song }: { song: Song }) {
  const [isWorking, setIsWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleSend = async () => {
    setIsWorking(true);
    setMessage(null);
    try {
      const summary = await exportPack(song.id, `${song.title}.vppack`);
      if (summary) setMessage(`Saved: ${describe(summary)}`);
    } catch (e) {
      console.error("[SendToPhoneButton] exportPack failed:", e);
      setMessage(`Could not build the pack: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <>
      <button
        className="practice-room__download-all"
        onClick={() => void handleSend()}
        disabled={isWorking}
        title="Save a practice pack for the Vocal Practice Pocket phone app"
      >
        {isWorking ? "Building pack…" : "Send to phone"}
      </button>
      {message ? (
        <span className="practice-room__pack-message" role="status">
          {message}
        </span>
      ) : null}
    </>
  );
}

export default SendToPhoneButton;
