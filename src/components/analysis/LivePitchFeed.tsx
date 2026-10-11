import { useEffect } from "react";
import { PitchDetector } from "../../audio/pitchDetector";
import { createLivePitchFeed } from "../../audio/livePitchFeed";
import { useAnalysisStore } from "../../stores/analysis";
import { getMonitorStream, getRecorderStream, usePlayerStore } from "../../stores/player";

/** Headless: listens to the microphone while recording or monitoring. */
export default function LivePitchFeed() {
  useEffect(() => {
    const analysis = () => useAnalysisStore.getState();
    const feed = createLivePitchFeed({
      getPlayer: () => usePlayerStore.getState(),
      getAnalysis: analysis,
      appendLivePitch: (p) => analysis().appendLivePitch(p),
      clearLivePitch: () => analysis().clearLivePitch(),
      setLiveCents: (c) => analysis().setLiveCents(c),
      getStream: (monitoring) => (monitoring ? getMonitorStream() : getRecorderStream()),
      makeDetector: () => new PitchDetector(),
      requestFrame: (cb) => requestAnimationFrame(cb),
      cancelFrame: (id) => cancelAnimationFrame(id),
    });
    feed.sync();
    const unsubscribe = usePlayerStore.subscribe(() => feed.sync());
    return () => {
      unsubscribe();
      feed.dispose();
    };
  }, []);

  return null;
}
