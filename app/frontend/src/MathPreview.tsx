import type { ReactNode } from "react";
import { BlockMath, InlineMath } from "react-katex";

import { getAssetFileUrl } from "./api";
import type {
  AssetInspectionResponseModel,
  AssetModel,
  QuestionImportValidationIssueModel,
  QuestionModel,
} from "./types";

/** Small, non-blocking visual cue for advisory lint issues -- a colored dot
 *  with the issue message(s) as a tooltip. Renders nothing when there are no
 *  issues, so callers can pass an empty/filtered array unconditionally. */
export function IssueDot({ issues }: { issues: QuestionImportValidationIssueModel[] }) {
  if (issues.length === 0) return null;
  const hasError = issues.some((issue) => issue.severity === "error");
  const title = issues.map((issue) => issue.message).join("\n");
  return (
    <span
      className={`issue-dot ${hasError ? "issue-dot-error" : "issue-dot-warning"}`}
      title={title}
      aria-label={title}
    />
  );
}

type MathToken =
  | { kind: "text"; value: string }
  | { kind: "inline"; value: string }
  | { kind: "block"; value: string };

interface MathPreviewFieldProps {
  label: string;
  value: string;
  editing: boolean;
  children: ReactNode;
  className?: string;
  preferWholeExpression?: boolean;
  issues?: QuestionImportValidationIssueModel[];
}

interface MathPreviewSection {
  label: string;
  text: string;
  preferWholeExpression?: boolean;
}

// One list, used to build every pattern below. It used to be spelled out five
// times, which is how a bug in the terminator could sit in all five at once.
const MATH_COMMANDS =
  "frac|sqrt|sum|int|lim|theta|pi|alpha|beta|gamma|delta|Delta|lambda|mu|sigma|omega|cdot|times|div|pm|leq|geq|neq|approx|implies|sin|cos|tan|left|right";

/** A command name ends at the first character that is not a letter.
 *
 *  This has to be a lookahead, not `\b`: a word boundary treats `_` as a word
 *  character, so `\lim_{x \to c}` read as no command at all and rendered as
 *  raw LaTeX. Every subscripted command -- `\sum_`, `\int_`, `\theta_` -- hit
 *  the same thing.
 */
const COMMAND_END = "(?![A-Za-z])";

/** A subscript or superscript written as a braced group, which may contain
 *  spaces (`_{x \to c}`). Matched as a unit so a bare-math span never stops
 *  mid-group and hands KaTeX an unbalanced brace. */
const SCRIPT_GROUP = "(?:[_^]\\{[^{}]*\\})?";

const TRAILING_MATH_CHARS = "[A-Za-z0-9_^{}+\\-*/=().\\\\]*";

const COMMAND_PATTERN = new RegExp(`\\\\(?:${MATH_COMMANDS})${COMMAND_END}`);
const NOTATION_PATTERN = /(^|[\s([{=+\-*/])(?:[A-Za-z]\w*)\s*(?:\^\{?[-+]?\w+\}?|_\{?[-+]?\w+\}?)/;
const CURRENCY_PATTERN = /^\s*\$?\d+(?:\.\d{1,2})?\s*$/;
const BARE_MATH_PATTERN = new RegExp(
  [
    `\\\\(?:frac|sqrt)(?:\\{[^{}]*\\}){1,2}${TRAILING_MATH_CHARS}`,
    `\\\\(?:${MATH_COMMANDS})${COMMAND_END}${SCRIPT_GROUP}${TRAILING_MATH_CHARS}`,
    "[A-Za-z]\\w*\\s*(?:\\^\\{?[-+]?\\w+\\}?|_\\{?[-+]?\\w+\\}?)",
  ].join("|"),
  "g",
);
const JSON_LATEX_ESCAPE_PATTERN = new RegExp(
  `(^|[^\\\\])\\\\(${MATH_COMMANDS}|\\(|\\)|\\[|\\])`,
  "g",
);

export function hasMathMarkup(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const value = text;
  if (!value.trim()) return false;

  if (findDelimitedMath(value, 0)) return true;
  if (COMMAND_PATTERN.test(value)) return true;
  return NOTATION_PATTERN.test(value);
}

export function looksLikeUnescapedLatexInJson(rawText: string): boolean {
  JSON_LATEX_ESCAPE_PATTERN.lastIndex = 0;
  return JSON_LATEX_ESCAPE_PATTERN.test(rawText);
}

export function escapeLikelyLatexBackslashesInJson(rawText: string): string {
  JSON_LATEX_ESCAPE_PATTERN.lastIndex = 0;
  return rawText.replace(JSON_LATEX_ESCAPE_PATTERN, (_match, prefix: string, command: string) => {
    return `${prefix}\\\\${command}`;
  });
}

export function MathTextPreview({
  text,
  className,
  preferWholeExpression = false,
  inline = false,
}: {
  text: string;
  className?: string;
  preferWholeExpression?: boolean;
  inline?: boolean;
}) {
  const Wrapper = inline ? "span" : "div";

  if (
    preferWholeExpression &&
    !findDelimitedMath(text, 0) &&
    isLikelyWholeMathExpression(text)
  ) {
    const renderError = () => <span className="math-render-error">{text || "Invalid math"}</span>;
    return (
      <Wrapper className={["math-text-preview", className].filter(Boolean).join(" ")}>
        <InlineMath math={prepareMathForKatex(text.trim())} renderError={renderError} />
      </Wrapper>
    );
  }

  const tokens = tokenizeMathText(text);

  return (
    <Wrapper className={["math-text-preview", className].filter(Boolean).join(" ")}>
      {tokens.map((token, index) => {
        if (token.kind === "text") {
          return <span key={index}>{token.value}</span>;
        }

        const renderError = () => (
          <span className="math-render-error">{token.value || "Invalid math"}</span>
        );

        return token.kind === "block" ? (
          <BlockMath key={index} math={prepareMathForKatex(token.value)} renderError={renderError} />
        ) : (
          <InlineMath key={index} math={prepareMathForKatex(token.value)} renderError={renderError} />
        );
      })}
    </Wrapper>
  );
}

export function MathPreviewField({
  label,
  value,
  editing,
  children,
  className,
  preferWholeExpression = false,
  issues = [],
}: MathPreviewFieldProps) {
  const showLivePreview = editing && hasMathMarkup(value);

  return (
    <div
      className={[
        "math-preview-field",
        showLivePreview ? "with-preview" : "",
        issues.length > 0 ? "has-issue" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <label>
        {label}
        <IssueDot issues={issues} />
        {editing ? (
          children
        ) : value.trim() ? (
          <div className="math-preview-panel">
            <MathTextPreview text={value} preferWholeExpression={preferWholeExpression} />
          </div>
        ) : (
          <p className="math-preview-empty-field">No {label.toLowerCase()} yet.</p>
        )}
      </label>
      {showLivePreview ? (
        <aside className="math-preview-panel">
          <span className="math-preview-label">Preview</span>
          <MathTextPreview text={value} preferWholeExpression={preferWholeExpression} />
        </aside>
      ) : null}
    </div>
  );
}

export function QuestionMathSummaryPreview({
  question,
  previewEnabled,
  invalid,
  assetInspections,
}: {
  question: QuestionModel | null;
  previewEnabled: boolean;
  invalid?: boolean;
  assetInspections?: AssetInspectionResponseModel[];
}) {
  if (!previewEnabled) return null;

  if (invalid) {
    return (
      <section className="math-preview-summary">
        <p className="math-preview-empty">Preview unavailable until JSON is valid.</p>
      </section>
    );
  }

  if (!question) return null;

  const sections = getQuestionMathPreviewSections(question);
  const assets = question.assets ?? [];
  return (
    <section className="math-preview-summary">
      {sections.length > 0 ? (
        sections.map((section) => (
          <article key={section.label} className="math-preview-summary-item">
            <span className="math-preview-label">{section.label}</span>
            <MathTextPreview
              text={section.text}
              preferWholeExpression={section.preferWholeExpression}
            />
          </article>
        ))
      ) : (
        <p className="math-preview-empty">Nothing to preview yet.</p>
      )}
      <QuestionAssetPreviewList assets={assets} assetInspections={assetInspections} />
    </section>
  );
}

/**
 * Read-only asset rendering, shared by the JSON preview pane and by the
 * question editor when Edit Fields is off. Shows the asset the way a reader
 * sees it rather than the fields that produce it.
 */
export function QuestionAssetPreviewList({
  assets,
  assetInspections,
}: {
  assets: AssetModel[];
  assetInspections?: AssetInspectionResponseModel[];
}) {
  return (
    <>
      {assets.map((asset, index) => {
        const inspection = assetInspections?.[index];
        const svgMarkup = inspection?.rendered_svg;
        return (
          <article key={`${asset.path}-${index}`} className="math-preview-summary-item">
            <span className="math-preview-label">
              Asset: {asset.path.split("/").slice(-1)[0] ?? asset.path}
            </span>
            {asset.kind === "svg" ? (
              svgMarkup ? (
                <div className="asset-svg-preview" dangerouslySetInnerHTML={{ __html: svgMarkup }} />
              ) : (
                <p className="math-preview-empty">Preview unavailable.</p>
              )
            ) : (
              <img className="asset-image-preview" src={getAssetFileUrl(asset.path)} alt={asset.path} />
            )}
          </article>
        );
      })}
    </>
  );
}

function getQuestionMathPreviewSections(question: QuestionModel): MathPreviewSection[] {
  const sections: MathPreviewSection[] = [];

  addSection(sections, "Prompt", question.prompt);
  addSection(sections, "Explanation", question.explanation);
  addSection(sections, "Sample Solution", question.sample_solution);
  addSection(sections, "Exemplar Answer", question.exemplar_answer);

  question.rubric.forEach((row, rowIndex) => {
    for (const [key, value] of Object.entries(row)) {
      if (key === "points") continue;
      addSection(sections, `Rubric ${rowIndex + 1} ${formatAnswerLabel(key)}`, value);
    }
  });

  const answer = question.answer ?? {};
  if (Array.isArray(answer.choices)) {
    answer.choices.forEach((choice, index) =>
      addSection(sections, `Choice ${index + 1}`, choice, true, true),
    );
  }

  for (const [key, value] of Object.entries(answer)) {
    if (key === "choices") continue;
    if (typeof value === "string") {
      addSection(sections, formatAnswerLabel(key), value);
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === "string") {
          addSection(sections, `${formatAnswerLabel(key)} ${index + 1}`, item);
        }
      });
    }
  }

  return sections;
}

function addSection(
  sections: MathPreviewSection[],
  label: string,
  value: unknown,
  preferWholeExpression = false,
  alwaysShow = false,
) {
  if (typeof value !== "string") return;
  if (!alwaysShow && !value.trim()) return;
  sections.push({ label, text: value, preferWholeExpression });
}

function formatAnswerLabel(key: string): string {
  return key
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function tokenizeMathText(text: string): MathToken[] {
  const tokens: MathToken[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const match = findDelimitedMath(text, cursor);
    if (!match) {
      pushTextWithBareMath(tokens, text.slice(cursor));
      break;
    }

    if (match.start > cursor) {
      pushTextWithBareMath(tokens, text.slice(cursor, match.start));
    }
    tokens.push({ kind: match.block ? "block" : "inline", value: match.value });
    cursor = match.end;
  }

  return tokens.length > 0 ? tokens : [{ kind: "text", value: text }];
}

function isLikelyWholeMathExpression(text: string): boolean {
  const value = text.trim();
  if (!value || CURRENCY_PATTERN.test(value) || !hasMathMarkup(value)) return false;
  if (/\n/.test(value)) return false;

  const hasMathCommand = COMMAND_PATTERN.test(value);
  const hasEquationSyntax = /[=^_]|\\(?:frac|sqrt|left|right|sin|cos|tan|pi|theta|alpha|beta|Delta)\b/.test(
    value,
  );
  if (!hasMathCommand && !hasEquationSyntax) return false;

  const proseWords = value.match(/[A-Za-z]{4,}/g) ?? [];
  const latexWords =
    value.match(new RegExp(`\\\\(?:${MATH_COMMANDS})${COMMAND_END}`, "g")) ?? [];

  return proseWords.length <= latexWords.length + 2;
}

function prepareMathForKatex(math: string): string {
  return math.replace(/(^|[^\\])([#%&$])/g, (_match, prefix: string, character: string) => {
    return `${prefix}\\${character}`;
  });
}

function findDelimitedMath(
  text: string,
  fromIndex: number,
): { start: number; end: number; value: string; block: boolean } | null {
  const candidates = [
    findDelimitedPair(text, fromIndex, "$$", "$$", true),
    findDelimitedPair(text, fromIndex, "\\[", "\\]", true),
    findDelimitedPair(text, fromIndex, "\\(", "\\)", false),
    findDollarMath(text, fromIndex),
  ].filter((candidate): candidate is { start: number; end: number; value: string; block: boolean } =>
    Boolean(candidate),
  );

  if (candidates.length === 0) return null;
  return candidates.sort((left, right) => left.start - right.start)[0];
}

function findDelimitedPair(
  text: string,
  fromIndex: number,
  open: string,
  close: string,
  block: boolean,
): { start: number; end: number; value: string; block: boolean } | null {
  const start = text.indexOf(open, fromIndex);
  if (start === -1) return null;

  const contentStart = start + open.length;
  const closeIndex = text.indexOf(close, contentStart);
  if (closeIndex === -1) return null;

  const value = text.slice(contentStart, closeIndex).trim();
  if (!value) return null;
  return { start, end: closeIndex + close.length, value, block };
}

function findDollarMath(
  text: string,
  fromIndex: number,
): { start: number; end: number; value: string; block: boolean } | null {
  let start = text.indexOf("$", fromIndex);
  while (start !== -1) {
    if (text[start + 1] === "$" || isEscaped(text, start)) {
      start = text.indexOf("$", start + 1);
      continue;
    }

    const end = text.indexOf("$", start + 1);
    if (end === -1) return null;

    const value = text.slice(start + 1, end).trim();
    if (value && !CURRENCY_PATTERN.test(value)) {
      return { start, end: end + 1, value, block: false };
    }
    start = text.indexOf("$", end + 1);
  }

  return null;
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function pushTextWithBareMath(tokens: MathToken[], text: string) {
  if (!text) return;

  let cursor = 0;
  for (const match of text.matchAll(BARE_MATH_PATTERN)) {
    const start = match.index ?? 0;
    const value = match[0].trim();
    if (!value) continue;
    if (start > cursor) {
      tokens.push({ kind: "text", value: text.slice(cursor, start) });
    }
    tokens.push({ kind: "inline", value });
    cursor = start + match[0].length;
  }

  if (cursor < text.length) {
    tokens.push({ kind: "text", value: text.slice(cursor) });
  }
}
