// The variables of the question being shown, for text that should appear
// with this version's values ({{force}}, {{calc: …}}): the question editor,
// each question in the print preview, rows of an import. Null outside one
// question, where text shows as typed.

import { createContext, useContext } from "react";

export const QuestionValuesContext = createContext<Record<string, string> | null>(null);

export function useQuestionValues(): Record<string, string> | null {
  return useContext(QuestionValuesContext);
}
