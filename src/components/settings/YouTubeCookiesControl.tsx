import { open } from "@tauri-apps/plugin-dialog";
import { useSettingsStore } from "../../stores/settings";

function YouTubeCookiesControl() {
  const youtubeCookiesPath = useSettingsStore((s) => s.youtubeCookiesPath);
  const setYoutubeCookiesPath = useSettingsStore((s) => s.setYoutubeCookiesPath);

  const handleChoose = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Cookies", extensions: ["txt"] }],
    });
    if (selected) {
      setYoutubeCookiesPath(selected);
    }
  };

  return (
    <div className="youtube-cookies-control">
      <label className="youtube-cookies-control__label">YouTube cookies file (optional)</label>
      <p className="youtube-cookies-control__desc">
        Fixes YouTube import failing with a "bot detection" error. Export a{" "}
        <code>cookies.txt</code> once while logged into YouTube (e.g. with the "Get
        cookies.txt LOCALLY" browser extension) and select it here — avoids the flaky,
        browser-must-be-closed fallback of reading cookies live from Chrome/Firefox/Edge/Brave/Opera.
        Re-export it if it stops working (YouTube sessions eventually expire).
      </p>
      <div className="youtube-cookies-control__row">
        <span className="youtube-cookies-control__path" title={youtubeCookiesPath ?? undefined}>
          {youtubeCookiesPath ?? "Not set — falls back to reading a running browser's cookies"}
        </span>
        <button className="youtube-cookies-control__btn" onClick={handleChoose}>
          Choose file…
        </button>
        {youtubeCookiesPath && (
          <button
            className="youtube-cookies-control__btn youtube-cookies-control__btn--clear"
            onClick={() => setYoutubeCookiesPath(null)}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

export default YouTubeCookiesControl;
