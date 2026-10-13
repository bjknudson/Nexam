// The drawing's variables, for fields deep in the inspector: the symbols
// palette offers them for insertion, and a slider for a derived variable
// shows its formula instead of letting it be dragged.

import { createContext, useContext } from "react";

export interface DrawingVariables {
  /** Every variable name, inputs then derived, for menus. */
  names: string[];
  /** Derived variables' formulas, by name. */
  derived: Record<string, string>;
}

export const DrawingVariablesContext = createContext<DrawingVariables>({ names: [], derived: {} });

export function useDrawingVariables(): DrawingVariables {
  return useContext(DrawingVariablesContext);
}
