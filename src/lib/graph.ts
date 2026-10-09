import type { RowLayout } from "@/bindings";

/** Height of a graph row, in pixels; the virtualizer and the SVG both rely on it. */
export const ROW_HEIGHT = 28;
/** Horizontal distance between two lanes, in pixels. */
export const LANE_WIDTH = 14;
export const NODE_RADIUS = 4;
export const LINE_WIDTH = 2;

const PALETTE = [
  "#3b82f6",
  "#f59e0b",
  "#10b981",
  "#ec4899",
  "#8b5cf6",
  "#06b6d4",
  "#ef4444",
  "#84cc16",
];

export function laneColor(color: number): string {
  return PALETTE[color % PALETTE.length];
}

/** Horizontal centre of a lane. */
export function laneX(lane: number): number {
  return lane * LANE_WIDTH + LANE_WIDTH / 2;
}

/** The number of lanes a row needs so none of its lines is cut off. */
export function rowLaneCount(layout: RowLayout): number {
  let max = layout.lane;
  for (const list of [layout.incoming, layout.outgoing, layout.passing]) {
    for (const ref of list) max = Math.max(max, ref.lane);
  }
  return max + 1;
}

/** An S-shaped path between two points, vertical at both ends. */
export function connector(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M${x1} ${y1}L${x2} ${y2}`;
  const middle = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${middle} ${x2} ${middle} ${x2} ${y2}`;
}
