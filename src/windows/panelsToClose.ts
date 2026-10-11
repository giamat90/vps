import { panelsToClose as panelsHiddenWhileDetached } from "@giamat90/mps-core/windows";
import { DETACHABLE_PANELS, type DetachablePanel } from "./protocol";

export function panelsToClose(
  previous: Readonly<Record<string, boolean>>,
  next: Readonly<Record<string, boolean>>,
  detached: Readonly<Partial<Record<string, boolean>>>,
): DetachablePanel[] {
  return panelsHiddenWhileDetached(DETACHABLE_PANELS, previous, next, detached);
}
