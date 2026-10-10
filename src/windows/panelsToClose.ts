import { DETACHABLE_PANELS, type DetachablePanel } from "./protocol";

/**
 * The panels whose window has to go: hidden in the Panels menu just now while
 * living in a window of their own. A docked panel has no window to close.
 */
export function panelsToClose(
  previous: Readonly<Record<string, boolean>>,
  next: Readonly<Record<string, boolean>>,
  detached: Readonly<Partial<Record<string, boolean>>>,
): DetachablePanel[] {
  return DETACHABLE_PANELS.filter((id) => previous[id] !== false && next[id] === false && detached[id] === true);
}
