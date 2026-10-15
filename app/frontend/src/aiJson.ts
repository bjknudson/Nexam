// Reading JSON pasted back from an AI assistant, which is often almost JSON:
// wrapped in a ```json fence, with a sentence before or after it, or with
// LaTeX backslashes left single ("\frac" instead of "\\frac").

import { escapeLikelyLatexBackslashesInJson } from "./MathPreview";

/** The pasted text as an object ({questions: [...]} for a bare array), or an error to show. */
export function parseAiJson(text: string): { value: Record<string, unknown> } | { error: string } {
  let body = text.trim();
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) body = fenced[1].trim();
  // A sentence before or after: keep from the first { or [ to the matching last } or ].
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  if (start < 0 || end < start) return { error: "That doesn't look like JSON: paste the complete JSON the AI returned." };
  body = body.slice(start, end + 1);
  // The fixed text first: a single-backslash "\frac" still parses (as a form
  // feed, \f, then "rac"), so the raw text can't be trusted to fail. The fix
  // leaves correctly doubled backslashes alone.
  for (const candidate of [escapeLikelyLatexBackslashesInJson(body), body]) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (Array.isArray(parsed)) return { value: { questions: parsed } };
      if (parsed && typeof parsed === "object") return { value: parsed as Record<string, unknown> };
    } catch {
      // Try the next candidate.
    }
  }
  try {
    JSON.parse(body);
  } catch (error) {
    return { error: `The JSON can't be read (${(error as Error).message}). Ask the AI to return the complete JSON only.` };
  }
  return { error: "The JSON should be an object with \"test\" and \"questions\"." };
}
