import {
  countInBpm,
  createCountInSlice as createSharedCountInSlice,
  steadyCountIn,
  type CountInSlice,
} from "@giamat90/mps-core/countIn";
import type { Slice, StoreGet } from "./types";

export const createCountInSlice: Slice<CountInSlice> = (set, get) => createSharedCountInSlice(set, get);

export function countInPlan(get: StoreGet) {
  const { song, playbackRate, countInBars } = get();
  return steadyCountIn(countInBpm(song?.detectedBpm, playbackRate), countInBars);
}
