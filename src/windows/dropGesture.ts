export interface DropInput {
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
  innerWidth: number;
  innerHeight: number;
}

export type DropDecision = { detach: false } | { detach: true; x: number; y: number };

/** How far past the edge counts as outside: a slightly overshot drop is not a detach. */
const EDGE_MARGIN_PX = 8;
/** The new window opens with its title bar under the cursor, not its corner. */
const GRAB_OFFSET_X = 40;
const GRAB_OFFSET_Y = 16;

export function decideDrop(i: DropInput): DropDecision {
  const values = [i.clientX, i.clientY, i.screenX, i.screenY, i.innerWidth, i.innerHeight];
  if (!values.every(Number.isFinite)) return { detach: false };

  const outside =
    i.clientX < -EDGE_MARGIN_PX ||
    i.clientY < -EDGE_MARGIN_PX ||
    i.clientX > i.innerWidth + EDGE_MARGIN_PX ||
    i.clientY > i.innerHeight + EDGE_MARGIN_PX;
  if (!outside) return { detach: false };

  return {
    detach: true,
    x: Math.max(0, i.screenX - GRAB_OFFSET_X),
    y: Math.max(0, i.screenY - GRAB_OFFSET_Y),
  };
}
