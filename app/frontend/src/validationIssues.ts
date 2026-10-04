import type { QuestionImportValidationIssueModel } from "./types";

/**
 * Exact-match lookup: every current lint rule's `location` already points at
 * the precise field it concerns (e.g. ["sample_solution"], ["answer",
 * "choices", 2]), so an exact match is sufficient -- no rule today needs a
 * "this field or any of its children" rollup.
 */
export function issuesForPath(
  issues: QuestionImportValidationIssueModel[],
  path: Array<string | number>,
): QuestionImportValidationIssueModel[] {
  return issues.filter(
    (issue) =>
      issue.location.length === path.length &&
      path.every((segment, index) => issue.location[index] === segment),
  );
}
