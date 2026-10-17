import { useExportMix } from "@giamat90/mps-core/hooks";
import { usePlayerStore, buildMixSources } from "../../stores/player";
import { exportMix } from "../../lib/tauri";

function ExportMixButton() {
  const mix = useExportMix({
    store: usePlayerStore,
    watch: [
      (s) => s.mutedTracks,
      (s) => s.soloedTrack,
      (s) => s.vocalsVolume,
      (s) => s.instrumentalVolume,
      (s) => s.takeVolume,
      (s) => s.activeTakeId,
    ],
    buildMixSources,
    exportMix,
  });

  return (
    <button
      className="practice-room__export-mix"
      onClick={() => void mix.onExport()}
      disabled={!mix.canExport || mix.isExporting}
      title={mix.canExport ? "Export the currently audible mix as a WAV file" : "No audible tracks to export"}
    >
      {mix.isExporting ? "Exporting…" : "Export Mix"}
    </button>
  );
}

export default ExportMixButton;
