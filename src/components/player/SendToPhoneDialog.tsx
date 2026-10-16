import { useCallback, useEffect, useId, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { exportPack, onPackShare, startPackShare, stopPackShare, type PackSummary } from "../../lib/tauri";
import { addressLabel, describePack, initialShareState, percent, shareReducer } from "../../lib/packShare";
import type { Song } from "../../lib/types";
import QrCode from "./QrCode";

interface Props {
  song: Song;
  onClose: () => void;
  onSaved: (summary: PackSummary) => void;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function SendToPhoneDialog({ song, onClose, onSaved }: Props) {
  const titleId = useId();
  const [state, dispatch] = useReducer(shareReducer, initialShareState);
  const [fileState, setFileState] = useState<{ working: boolean; error: string | null }>({ working: false, error: null });
  const [copied, setCopied] = useState(false);
  const ticket = useRef(0);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    onPackShare((event) => dispatch({ type: "event", event }))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((e) => console.error("[SendToPhoneDialog] could not listen for pack-share:", e));
    return () => {
      disposed = true;
      unlisten?.();
      stopPackShare().catch((e) => console.warn("[SendToPhoneDialog] stopPackShare failed:", e));
    };
  }, []);

  const begin = useCallback(
    async (address?: string) => {
      const mine = ++ticket.current;
      dispatch({ type: "start" });
      try {
        const info = await startPackShare(song.id, address);
        if (mine === ticket.current) dispatch({ type: "started", info });
      } catch (e) {
        console.error("[SendToPhoneDialog] startPackShare failed:", e);
        if (mine === ticket.current) dispatch({ type: "failed", message: messageOf(e) });
      }
    },
    [song.id],
  );

  const saveAsFile = useCallback(async () => {
    ticket.current++;
    dispatch({ type: "back" });
    setFileState({ working: true, error: null });
    try {
      await stopPackShare();
      const summary = await exportPack(song.id, `${song.title}.vppack`);
      if (summary) {
        onSaved(summary);
        onClose();
        return;
      }
      dispatch({ type: "back" });
      setFileState({ working: false, error: null });
    } catch (e) {
      console.error("[SendToPhoneDialog] exportPack failed:", e);
      dispatch({ type: "back" });
      setFileState({ working: false, error: `Could not build the pack: ${messageOf(e)}` });
    }
  }, [song.id, song.title, onSaved, onClose]);

  const copyLink = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.warn("[SendToPhoneDialog] clipboard refused:", e);
    }
  }, []);

  const busy = fileState.working || state.phase === "sending";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const fileOption = (
    <button className="share-modal__secondary" onClick={() => void saveAsFile()} disabled={fileState.working}>
      Save as a file instead
    </button>
  );

  return createPortal(
    <div className="update-overlay">
      <div className="update-modal share-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        {state.phase === "choose" && (
          <>
            <h2 id={titleId} className="update-modal__title">Send to phone</h2>
            <p className="share-modal__lead">
              “{song.title}” as a practice pack for Vocal Practice Pocket.
            </p>
            <button className="share-option share-option--primary" onClick={() => void begin()} disabled={fileState.working} autoFocus>
              <strong>Send over Wi-Fi</strong>
              <span>Scan a code with the phone. Both must be on the same network.</span>
            </button>
            <button className="share-option" onClick={() => void saveAsFile()} disabled={fileState.working}>
              <strong>{fileState.working ? "Building the pack…" : "Save as a file…"}</strong>
              <span>Move it yourself: cable, cloud drive or share sheet.</span>
            </button>
            {fileState.error && <p className="share-modal__error" role="alert">{fileState.error}</p>}
            <div className="update-modal__actions">
              <button className="update-modal__later" onClick={onClose} disabled={fileState.working}>Cancel</button>
            </div>
          </>
        )}

        {state.phase === "preparing" && (
          <>
            <h2 id={titleId} className="update-modal__title">Building the pack…</h2>
            {state.progress ? (
              <div className="progress-bar" role="progressbar" aria-label="Building the pack" aria-valuenow={Math.round(state.progress.value * 100)}>
                <div className="progress-bar__fill" style={{ width: `${Math.round(state.progress.value * 100)}%` }} />
              </div>
            ) : (
              <div className="progress-bar share-modal__busy" role="progressbar" aria-label="Starting the audio engine">
                <div className="progress-bar__fill" />
              </div>
            )}
            <p className="share-modal__hint">
              {state.progress ? `${state.progress.stage}…` : "Starting the audio engine. The first time takes longer."}
            </p>
            <div className="update-modal__actions">
              <button className="update-modal__later" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}

        {state.phase === "ready" && (
          <>
            <h2 id={titleId} className="update-modal__title">Scan with your phone</h2>
            <QrCode text={state.info.url} label={`Code for ${song.title}`} />
            <p className="share-modal__steps">
              On the phone, open <strong>Vocal Practice Pocket</strong>, go to <strong>Songs</strong> and tap <strong>Receive from laptop</strong>.
            </p>
            <p className="share-modal__hint">
              {describePack(state.info.summary)} · works once, for {Math.round(state.info.expiresInS / 60)} minutes
            </p>
            {state.interrupted && (
              <p className="share-modal__error" role="status">The transfer was interrupted. Scan again to retry.</p>
            )}
            {state.info.addresses.length > 1 && (
              <label className="share-modal__network">
                Network
                <select value={state.info.ip} onChange={(e) => void begin(e.target.value)}>
                  {state.info.addresses.map((a) => (
                    <option key={a.ip} value={a.ip}>
                      {addressLabel(a)}{a.virtualAdapter ? " · virtual" : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <code className="share-modal__link">{state.info.url}</code>
            <details className="share-modal__help">
              <summary>The phone cannot connect</summary>
              <ul>
                <li>Phone and computer must be on the same Wi-Fi (not a guest network, not mobile data).</li>
                <li>If Windows asked to allow Vocal Practice Studio, allow it on private networks.</li>
                <li>With several networks listed above, pick the one the phone is on.</li>
                <li>You can paste the copied link into the phone's Receive screen instead of scanning.</li>
              </ul>
            </details>
            <div className="update-modal__actions">
              <button className="update-modal__install" onClick={() => void copyLink(state.info.url)}>
                {copied ? "Copied" : "Copy link"}
              </button>
              {fileOption}
              <button className="update-modal__later" onClick={onClose}>Close</button>
            </div>
          </>
        )}

        {state.phase === "sending" && (
          <>
            <h2 id={titleId} className="update-modal__title">Sending to your phone…</h2>
            <div
              className="progress-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent(state.sent, state.total)}
            >
              <div className="progress-bar__fill" style={{ width: `${percent(state.sent, state.total)}%` }} />
            </div>
            <p className="share-modal__hint">{percent(state.sent, state.total)}%</p>
          </>
        )}

        {state.phase === "done" && (
          <>
            <h2 id={titleId} className="update-modal__title">Sent to your phone</h2>
            <p className="share-modal__steps">“{song.title}” is in the Songs list on the phone.</p>
            <div className="update-modal__actions">
              <button className="update-modal__install" onClick={onClose} autoFocus>Done</button>
              <button className="update-modal__later" onClick={() => void begin(state.info.ip)}>Send again</button>
            </div>
          </>
        )}

        {state.phase === "expired" && (
          <>
            <h2 id={titleId} className="update-modal__title">The code expired</h2>
            <p className="share-modal__steps">A code works once and for {Math.round(state.info.expiresInS / 60)} minutes.</p>
            <div className="update-modal__actions">
              <button className="update-modal__install" onClick={() => void begin(state.info.ip)} autoFocus>New code</button>
              <button className="update-modal__later" onClick={onClose}>Close</button>
            </div>
          </>
        )}

        {state.phase === "failed" && (
          <>
            <h2 id={titleId} className="update-modal__title">Could not share the pack</h2>
            <p className="share-modal__error" role="alert">{state.message}</p>
            <div className="update-modal__actions">
              <button className="update-modal__install" onClick={() => void begin()} autoFocus>Try again</button>
              {fileOption}
              <button className="update-modal__later" onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

export default SendToPhoneDialog;
