// Aligning and distributing the selection. Works on the boxes the browser
// drew (so it suits every kind of element), and returns how far to move each.
// One element is aligned to the canvas; several to their combined bounds.

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AlignEdge = "left" | "center" | "right" | "top" | "middle" | "bottom";

export interface Delta {
  dx: number;
  dy: number;
}

export function unionBox(boxes: Box[]): Box {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Moves that line every box up with `edge` of the reference box. */
export function alignDeltas(boxes: Box[], edge: AlignEdge, reference: Box = unionBox(boxes)): Delta[] {
  return boxes.map((box) => {
    switch (edge) {
      case "left":
        return { dx: reference.x - box.x, dy: 0 };
      case "center":
        return { dx: reference.x + reference.width / 2 - (box.x + box.width / 2), dy: 0 };
      case "right":
        return { dx: reference.x + reference.width - (box.x + box.width), dy: 0 };
      case "top":
        return { dx: 0, dy: reference.y - box.y };
      case "middle":
        return { dx: 0, dy: reference.y + reference.height / 2 - (box.y + box.height / 2) };
      default:
        return { dx: 0, dy: reference.y + reference.height - (box.y + box.height) };
    }
  });
}

/** Moves that leave equal gaps between boxes along an axis, keeping the
 *  first and last where they are (in order of position). Needs 3 or more. */
export function distributeDeltas(boxes: Box[], axis: "horizontal" | "vertical"): Delta[] {
  const deltas: Delta[] = boxes.map(() => ({ dx: 0, dy: 0 }));
  if (boxes.length < 3) return deltas;
  const start = (box: Box) => (axis === "horizontal" ? box.x : box.y);
  const size = (box: Box) => (axis === "horizontal" ? box.width : box.height);
  const order = boxes.map((box, index) => ({ box, index })).sort((a, b) => start(a.box) + size(a.box) / 2 - (start(b.box) + size(b.box) / 2));
  const first = order[0].box;
  const last = order[order.length - 1].box;
  const span = start(last) + size(last) - start(first);
  const gap = (span - order.reduce((sum, item) => sum + size(item.box), 0)) / (order.length - 1);
  let position = start(first);
  for (const { box, index } of order) {
    const move = position - start(box);
    deltas[index] = axis === "horizontal" ? { dx: move, dy: 0 } : { dx: 0, dy: move };
    position += size(box) + gap;
  }
  return deltas;
}
