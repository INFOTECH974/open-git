import type { RowLayout } from "@/bindings";
import {
  LANE_WIDTH,
  LINE_WIDTH,
  NODE_RADIUS,
  ROW_HEIGHT,
  connector,
  laneColor,
  laneX,
} from "@/lib/graph";

interface Props {
  layout: RowLayout;
  /** Lanes to reserve, so every row of the list has the same width. */
  laneCount: number;
  /** A merge commit is drawn as a ring instead of a disc. */
  merge: boolean;
}

/** The lines and node of one graph row, as an SVG. */
export function GraphLanes({ layout, laneCount, merge }: Props) {
  const width = Math.max(laneCount, 1) * LANE_WIDTH;
  const cx = laneX(layout.lane);
  const cy = ROW_HEIGHT / 2;
  const color = laneColor(layout.color);

  return (
    <svg
      width={width}
      height={ROW_HEIGHT}
      className="shrink-0"
      aria-hidden
      style={{ overflow: "visible" }}
    >
      {layout.passing.map((ref) => (
        <line
          key={`p${ref.lane}`}
          x1={laneX(ref.lane)}
          y1={0}
          x2={laneX(ref.lane)}
          y2={ROW_HEIGHT}
          stroke={laneColor(ref.color)}
          strokeWidth={LINE_WIDTH}
        />
      ))}
      {layout.incoming.map((ref) => (
        <path
          key={`i${ref.lane}`}
          d={connector(laneX(ref.lane), 0, cx, cy)}
          stroke={laneColor(ref.color)}
          strokeWidth={LINE_WIDTH}
          fill="none"
        />
      ))}
      {layout.outgoing.map((ref, index) => (
        <path
          key={`o${index}`}
          d={connector(cx, cy, laneX(ref.lane), ROW_HEIGHT)}
          stroke={laneColor(ref.color)}
          strokeWidth={LINE_WIDTH}
          fill="none"
        />
      ))}
      <circle
        cx={cx}
        cy={cy}
        r={NODE_RADIUS}
        fill={merge ? "var(--background)" : color}
        stroke={color}
        strokeWidth={LINE_WIDTH}
      />
    </svg>
  );
}
