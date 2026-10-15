import { useEffect, useState } from "react";

export type AiPromptKind = "question" | "test";

export interface AiPromptContext {
  /** The question (or a question in the test) uses `variables`, so the
   *  prompt explains how they drive the text, answers and drawings. */
  usesVariables?: boolean;
  /** A test that already has questions: pasted questions are ignored, so the
   *  prompt asks the AI to leave them alone unless a request changes them. */
  testHasQuestions?: boolean;
}

interface AiPromptDialogProps {
  open: boolean;
  kind: AiPromptKind;
  json: string;
  context?: AiPromptContext;
  onClose: () => void;
  /** Tests: go on to pasting the AI's reply, which becomes a new version. */
  onNext?: () => void;
}

export type AiStep = "prompt" | "paste" | "review";

const AI_STEPS: { id: AiStep; label: string }[] = [
  { id: "prompt", label: "Ask the AI" },
  { id: "paste", label: "Paste its reply" },
  { id: "review", label: "Review" },
];

/** Where the teacher is in a test's AI round trip: prompt, paste, review. */
export function AiSteps({ current }: { current: AiStep }) {
  const at = AI_STEPS.findIndex((step) => step.id === current);
  return (
    <ol className="ai-steps" aria-label="Steps">
      {AI_STEPS.map((step, index) => (
        <li
          key={step.id}
          className={index === at ? "current" : index < at ? "done" : ""}
          aria-current={index === at ? "step" : undefined}
        >
          <span>{index + 1}</span>
          {step.label}
        </li>
      ))}
    </ol>
  );
}

/** What the teacher asked for: ticked common requests and their own words. */
export interface AiPromptRequest {
  options: string[];
  custom: string;
}

interface RequestOption {
  id: string;
  label: string;
  /** The line it adds to the prompt's instructions. */
  instruction: string;
  /** Only offered when the question (or test) uses variables. */
  needsVariables?: boolean;
  /** Test requests that change the questions themselves (not just the test). */
  changesQuestions?: boolean;
}

// Common requests, offered as checkboxes. Kept short; the custom field covers the rest.
export const REQUEST_OPTIONS: Record<AiPromptKind, RequestOption[]> = {
  question: [
    {
      id: "new-values",
      label: "Change variable values (a new version)",
      instruction: "Make a new version by changing the values in the \"variables\" block; keep the {{...}} references so the text, answers and drawings follow.",
      needsVariables: true,
    },
    {
      id: "new-numbers",
      label: "Change the numbers (a new version)",
      instruction: "Make a new version with different numbers, and recalculate the answer and every distractor to match.",
    },
    {
      id: "distractors",
      label: "Rewrite distractors as common mistakes",
      instruction: "Rewrite the wrong choices so each one is the result of a specific, common student mistake.",
    },
    {
      id: "explanation",
      label: "Write or improve the explanation",
      instruction: "Write a clear worked explanation that shows the steps to the correct answer.",
    },
    {
      id: "same-difficulty",
      label: "Keep the same difficulty",
      instruction: "Keep the same difficulty level.",
    },
    {
      id: "same-standards",
      label: "Keep the same standards",
      instruction: "Keep the same standards and topic.",
    },
    {
      id: "simpler-language",
      label: "Simplify the wording",
      instruction: "Simplify the wording for a lower reading level without changing the physics or math.",
    },
  ],
  test: [
    {
      id: "new-version",
      label: "Make a new version of this test",
      instruction: "Make a new version of this test (e.g. version B): set the next version letter and keep the same title.",
      changesQuestions: true,
    },
    {
      id: "change-order",
      label: "Change the order",
      instruction: "Change the order of the questions (shuffle them, keeping sections together).",
    },
    {
      id: "new-values",
      label: "Change variable values",
      instruction: "For questions with a \"variables\" block, change the values there; keep the {{...}} references so their text, answers and drawings follow.",
      needsVariables: true,
      changesQuestions: true,
    },
    {
      id: "new-questions",
      label: "Create new questions",
      instruction: "Replace the questions with new ones that assess the same skills, one for one.",
      changesQuestions: true,
    },
    {
      id: "same-difficulty",
      label: "Keep the same difficulty levels",
      instruction: "Keep each question's difficulty level the same as the one it replaces.",
    },
    {
      id: "same-standards",
      label: "Keep the same standards distribution",
      instruction: "Keep the same standards distribution: each question covers the same standards as the one it replaces.",
    },
    {
      id: "same-shape",
      label: "Keep question types and number of choices",
      instruction: "Keep each question's type and number of choices, so the same answer sheet works for every version.",
    },
    {
      id: "sections",
      label: "Group into sections with instructions",
      instruction: "Group the questions into sections by topic, each with a one-line instruction.",
    },
  ],
};

/** The options the dialog offers, given the context. */
export function offeredOptions(kind: AiPromptKind, context: AiPromptContext): RequestOption[] {
  return REQUEST_OPTIONS[kind].filter((option) => !option.needsVariables || context.usesVariables);
}

/** Whether the request changes questions inside a test. */
export function changesQuestions(request: AiPromptRequest): boolean {
  return REQUEST_OPTIONS.test.some((option) => option.changesQuestions && request.options.includes(option.id));
}

// Example requests, in the placeholder left when nothing is chosen.
const PLACEHOLDER: Record<AiPromptKind, string> = {
  question:
    '<describe the change you want here, for example "Make a new version with different values", "Rewrite the distractors so each one reflects a common mistake", "Add a worked explanation", "Make it easier for an introductory class">',
  test: '<describe the change you want here, for example "Order the items from easiest to hardest", "Group the questions into sections by topic, with a one-line instruction for each", "Write a 15-question unit test on Newton\'s laws (for an empty test)", "Retitle it as a quiz and set version B">',
};

const RETURN_RULES = (kind: AiPromptKind) =>
  `Return the complete, valid JSON for the ${kind} only, keeping the same structure, keys and ids. Do not add commentary or markdown formatting (no code fences) around it.`;

export const MATH_RULES = `Math and symbols:
- Write math in LaTeX between dollar signs, e.g. $F_{net} = ma$, $\\ln(x)$, $\\frac{1}{2}mv^2$, $30^\\circ$. Never leave a LaTeX command such as \\ln, \\frac or \\theta outside $...$.
- Inside JSON strings every backslash is doubled: write "$\\\\frac{1}{2}$" to get $\\frac{1}{2}$.
- Units can stay plain text after the math: "$12\\\\text{ kg}$" or "12 kg".`;

export const VARIABLE_RULES = `Variables:
- The "variables" block holds this version's values (e.g. "force": "40"). To make a new version, change the values there.
- Text uses them as {{name}}, and values worked out from them as {{calc: expression}}, with + - * /, parentheses, sin and cos (degrees), round(x, places) and sig(x, figures). Example choice: "{{calc: round(force * cos(angle), 1)}} N".
- Keep the variable names, the {{...}} references, and the attachments' "svg_variables" as they are: attached drawings take the values by name. Only change them if asked.
- Make sure correct_choice_index still points at the right choice, and that the explanation agrees with the values.`;

function testRules(context: AiPromptContext, request: AiPromptRequest): string {
  let questionsLine: string;
  if (!context.testHasQuestions) {
    questionsLine = `- This test has no questions yet. Questions in the "questions" array are created in the bank and added to the test in order. Each needs "type" (multiple_choice, numeric_response, short_answer or free_response), "topic", "difficulty" (1 to 5) and "prompt"; multiple_choice also needs "answer": {"choices": [...], "correct_choice_index": n}, and numeric_response needs "answer": {"value": n, "unit": "...", "tolerance": n}. Leave out "id" and Nexam assigns one.`;
  } else if (changesQuestions(request)) {
    questionsLine = `- Return every question in the "questions" array, changed or not. Keep each question's "id" as it is, even when you rewrite it, so Nexam knows which question it replaces, and keep the items' "question_id"s matching those ids.`;
  } else {
    questionsLine = `- Change the "test" object only. The "questions" array is there for reference; leave the questions as they are.`;
  }
  return `About test JSON:
- The "test" object holds the test: title, version, version_description, items (the order of questions and sections), and print settings. Keep each item's "question_id" exactly as it is; reorder items by moving them.
- A section item, {"item_type": "section", "title": "Part A", "instructions": "Answer each question."}, starts a group; the questions after it belong to it until the next section.
${questionsLine}`;
}

/** The instructions: each ticked request on its own line, then the teacher's
 *  own words. With neither, the placeholder for them to fill in. */
function instructions(kind: AiPromptKind, request: AiPromptRequest): string {
  const lines = REQUEST_OPTIONS[kind].filter((option) => request.options.includes(option.id)).map((option) => `- ${option.instruction}`);
  const custom = request.custom.trim();
  if (custom) lines.push(lines.length > 0 ? `- ${custom}` : custom);
  if (lines.length === 0) return `Instructions: ${PLACEHOLDER[kind]}`;
  return lines.length === 1 && !lines[0].startsWith("- ") ? `Instructions: ${lines[0]}` : `Instructions:\n${lines.join("\n")}`;
}

/** The prompt to paste above the JSON. Exported for tests. */
export function buildPromptTemplate(
  kind: AiPromptKind,
  context: AiPromptContext = {},
  request: AiPromptRequest = { options: [], custom: "" },
): string {
  const asksForValues = request.options.includes("new-values");
  const sections = [
    `You are helping me edit a ${kind} for a question bank app called Nexam, used by teachers to build printed tests. The current ${kind} is provided below as JSON.`,
    instructions(kind, request),
    RETURN_RULES(kind),
    MATH_RULES,
  ];
  if (kind === "test") sections.push(testRules(context, request));
  if (context.usesVariables || asksForValues) sections.push(VARIABLE_RULES);
  return sections.join("\n\n");
}

const STORAGE_KEY = (kind: AiPromptKind) => `nexam:ai-prompt-request:${kind}`;

// The last request is a per-viewer convenience; storage may be unavailable.
function readRequest(kind: AiPromptKind): AiPromptRequest {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY(kind)) ?? "null") as AiPromptRequest | null;
    if (parsed && Array.isArray(parsed.options) && typeof parsed.custom === "string") return parsed;
  } catch {
    // Start empty.
  }
  return { options: [], custom: "" };
}

function writeRequest(kind: AiPromptKind, request: AiPromptRequest) {
  try {
    window.localStorage.setItem(STORAGE_KEY(kind), JSON.stringify(request));
  } catch {
    // Not remembered; the dialog still works.
  }
}

/** Lets a teacher hand a question or test off to an outside AI assistant
 *  (ChatGPT, Claude, Gemini, ...) and bring the result back: tick common
 *  requests, add their own, and copy the prompt and the live JSON. */
function AiPromptDialog({ open, kind, json, context = {}, onClose, onNext }: AiPromptDialogProps) {
  const [promptCopied, setPromptCopied] = useState(false);
  const [jsonCopied, setJsonCopied] = useState(false);
  const [bothCopied, setBothCopied] = useState(false);
  const [request, setRequest] = useState<AiPromptRequest>(() => readRequest(kind));

  const options = offeredOptions(kind, context);
  // A remembered request may name an option this question doesn't offer (no variables).
  const effective: AiPromptRequest = {
    ...request,
    options: request.options.filter((id) => options.some((option) => option.id === id)),
  };
  const prompt = buildPromptTemplate(kind, context, effective);
  const unapplied = kind === "test" && context.testHasQuestions && changesQuestions(effective);

  useEffect(() => {
    if (!open) return;
    setPromptCopied(false);
    setJsonCopied(false);
    setBothCopied(false);
  }, [open]);

  useEffect(() => {
    setPromptCopied(false);
    setBothCopied(false);
    writeRequest(kind, request);
  }, [kind, request]);

  if (!open) return null;

  function copy(text: string, onDone: (copied: boolean) => void) {
    void navigator.clipboard.writeText(text).then(
      () => onDone(true),
      () => onDone(false),
    );
  }

  const toggle = (id: string, checked: boolean) =>
    setRequest((current) => ({
      ...current,
      options: checked ? [...current.options.filter((item) => item !== id), id] : current.options.filter((item) => item !== id),
    }));

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        className={`settings-modal ai-prompt-modal ${onNext ? "ai-wizard-modal" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={`Use AI to edit this ${kind}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-header">
          <h2>Use AI to edit this {kind}</h2>
          <button type="button" className="settings-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="settings-body">
          {onNext ? <AiSteps current="prompt" /> : null}
          <p className="ai-prompt-intro">
            Choose what you want, copy the prompt and the {kind}&rsquo;s JSON into ChatGPT, Claude, Gemini, or any AI
            assistant, then{" "}
            {kind === "question"
              ? "paste the complete JSON it returns back into Text View here."
              : onNext
                ? "press Next and paste the JSON it returns. You review it before anything is created."
                : "paste the complete JSON it returns into Test JSON here and press Apply."}
          </p>

          <section className="ai-prompt-section" aria-label="What should the AI do?">
            <h3>What should the AI do?</h3>
            <div className="ai-prompt-options">
              {options.map((option) => (
                <label key={option.id} className="ai-prompt-option">
                  <input
                    type="checkbox"
                    checked={effective.options.includes(option.id)}
                    onChange={(event) => toggle(option.id, event.target.checked)}
                  />
                  {option.label}
                </label>
              ))}
            </div>
            <label className="ai-prompt-custom">
              Anything else
              <textarea
                rows={2}
                value={request.custom}
                placeholder={
                  kind === "question"
                    ? "e.g. Use a skateboard instead of a cart, and keep the numbers under 100"
                    : "e.g. Make version B easier for students who missed the first test"
                }
                onChange={(event) => setRequest((current) => ({ ...current, custom: event.target.value }))}
              />
            </label>
          </section>

          {onNext && context.testHasQuestions ? (
            <p className="ai-prompt-note">
              The AI&rsquo;s reply becomes a new version of this test, after you review it. This test stays as it is.
            </p>
          ) : unapplied ? (
            <p className="ai-prompt-note">
              The AI&rsquo;s JSON will change questions, so bring it back with Import AI version. It becomes a new
              version of this test, after you review it; this test stays as it is.
            </p>
          ) : kind === "test" && context.testHasQuestions ? (
            <p className="ai-prompt-note">
              This test already has questions, so only the test&rsquo;s settings and item order are applied. To
              change a question&rsquo;s wording or values, use AI from that question in the Question Editor.
            </p>
          ) : null}

          <section className="ai-prompt-section">
            <div className="ai-prompt-section-header">
              <h3>Prompt</h3>
              <button type="button" onClick={() => copy(prompt, setPromptCopied)}>
                {promptCopied ? "Copied" : "Copy"}
              </button>
            </div>
            <textarea className="ai-prompt-textarea" value={prompt} readOnly rows={8} />
          </section>

          <section className="ai-prompt-section">
            <div className="ai-prompt-section-header">
              <h3>{kind === "question" ? "Question" : "Test"} JSON</h3>
              <button type="button" onClick={() => copy(json, setJsonCopied)}>
                {jsonCopied ? "Copied" : "Copy"}
              </button>
            </div>
            <textarea className="ai-prompt-textarea" value={json} readOnly rows={8} />
          </section>
        </div>

        <div className="bank-properties-actions">
          <button
            type="button"
            onClick={() => copy(`${prompt}\n\n${json}`, setBothCopied)}
          >
            {bothCopied ? "Copied Both" : "Copy Prompt + JSON"}
          </button>
          {onNext ? (
            <>
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="primary" onClick={onNext}>
                Next
              </button>
            </>
          ) : (
            <button type="button" onClick={onClose}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default AiPromptDialog;
