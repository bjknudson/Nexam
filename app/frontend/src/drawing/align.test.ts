import { describe, expect, it } from "vitest";

import { alignDeltas, distributeDeltas, unionBox } from "./align";

const a = { x: 10, y: 10, width: 20, height: 10 };
const b = { x: 50, y: 30, width: 40, height: 20 };
const c = { x: 120, y: 5, width: 10, height: 10 };

describe("align", () => {
  it("lines boxes up with the selection's edges and centres", () => {
    expect(unionBox([a, b, c])).toEqual({ x: 10, y: 5, width: 120, height: 45 });
    expect(alignDeltas([a, b, c], "left").map((d) => d.dx)).toEqual([0, -40, -110]);
    expect(alignDeltas([a, b, c], "right").map((d) => d.dx)).toEqual([100, 40, 0]);
    expect(alignDeltas([a, b, c], "center").map((d) => d.dx)).toEqual([50, 0, -55]);
    expect(alignDeltas([a, b, c], "middle").map((d) => d.dy)).toEqual([12.5, -12.5, 17.5]);
    expect(alignDeltas([a, b], "bottom")).toEqual([
      { dx: 0, dy: 30 },
      { dx: 0, dy: 0 },
    ]);
  });

  it("centres one box on the canvas", () => {
    expect(alignDeltas([a], "center", { x: 0, y: 0, width: 318, height: 200 })).toEqual([{ dx: 139, dy: 0 }]);
  });
});

describe("distribute", () => {
  it("leaves equal gaps, keeping the outermost boxes in place, whatever the selection order", () => {
    // Gaps now: a→b 20, b→c 30. Total gap 50 over 2 → 25 each: b moves +5.
    expect(distributeDeltas([c, a, b], "horizontal")).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 },
      { dx: 5, dy: 0 },
    ]);
  });

  it("does nothing for fewer than three", () => {
    expect(distributeDeltas([a, b], "vertical")).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 },
    ]);
  });
});
