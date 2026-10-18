import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ProcessingStatus } from "./types";
import type { PackShareEvent } from "./ipcTypes";

// Every command wrapper is generated from the Rust command signatures; see ipc.generated.ts.
export * from "./ipc.generated";
export type { AnalysisData, LanAddress, MixSource, PackShareEvent, PackShareInfo, PackSummary, ZipExportEntry } from "./ipcTypes";

export function onPackShare(callback: (event: PackShareEvent) => void): Promise<UnlistenFn> {
  return listen<PackShareEvent>("pack-share", (event) => {
    callback(event.payload);
  });
}

/** Listen for processing progress events */
export function onProcessingProgress(
  callback: (status: ProcessingStatus) => void
): Promise<UnlistenFn> {
  return listen<ProcessingStatus>("processing-progress", (event) => {
    callback(event.payload);
  });
}
