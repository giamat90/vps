import type { DynamicsPoint, PitchData } from "./types";

// Shapes that cross the IPC boundary and are not Rust-derived; scripts/ipc-types.json maps command types onto them.

export interface AnalysisData {
  pitchData: PitchData;
  onsets: number[];
  dynamics: DynamicsPoint[];
  spectroTimes?: number[];
  spectroB64?: string;
  spectroFrames?: number;
  spectroRows?: number;
  stSpectrumTimes?: number[];
  stSpectrumB64?: string;
  stSpectrumFrames?: number;
  stSpectrumBins?: number;
  stSpectrumMinDb?: number;
  stSpectrumMaxDb?: number;
}

export interface ZipExportEntry {
  path: string;
  archiveName: string;
}

export interface PackSummary {
  path: string;
  sizeBytes: number;
  variants: number[];
  hasReference: boolean;
  hasLyrics: boolean;
  loops: number;
}

export interface LanAddress {
  ip: string;
  /** adapter name as Windows shows it, e.g. "Wi-Fi" */
  name: string;
  /** WSL, Hyper-V, VMware, Docker, VPN...: rarely the network the phone is on */
  virtualAdapter: boolean;
}

export interface PackShareInfo {
  /** what the QR code carries and the phone fetches */
  url: string;
  ip: string;
  port: number;
  expiresInS: number;
  summary: PackSummary;
  /** every network this computer could serve on, best first */
  addresses: LanAddress[];
}

export interface MixSource {
  path: string;
  gain: number;
  isTake: boolean;
  startPosition?: number;
  audioOffset?: number;
  manualOffset?: number;
}

export type PackShareEvent =
  | { kind: "building"; value: number; stage: string }
  | { kind: "sending"; sent: number; total: number }
  | { kind: "interrupted" }
  | { kind: "done" }
  | { kind: "expired" };
