import { useState } from "react";
import { describePack } from "../../lib/packShare";
import type { PackSummary } from "../../lib/tauri";
import type { Song } from "../../lib/types";
import SendToPhoneDialog from "./SendToPhoneDialog";

function SendToPhoneButton({ song }: { song: Song }) {
  const [isOpen, setIsOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleSaved = (summary: PackSummary) => setMessage(`Saved: ${describePack(summary)}`);

  return (
    <>
      <button
        className="practice-room__download-all"
        onClick={() => {
          setMessage(null);
          setIsOpen(true);
        }}
        title="Send a practice pack to the Vocal Practice Pocket phone app, over Wi-Fi or as a file"
      >
        Send to phone
      </button>
      {message ? (
        <span className="practice-room__pack-message" role="status">
          {message}
        </span>
      ) : null}
      {isOpen && <SendToPhoneDialog song={song} onClose={() => setIsOpen(false)} onSaved={handleSaved} />}
    </>
  );
}

export default SendToPhoneButton;
