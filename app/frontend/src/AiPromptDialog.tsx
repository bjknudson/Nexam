import { useEffect, useState } from "react";

interface AiPromptDialogProps {
  open: boolean;
  /** What's being edited, e.g. "question" or "test" -- used to word the
   *  heading and the suggested prompt so this dialog can back more than one
   *  AI-prompting entry point without rewriting its copy each time. */
  label: string;
  json: string;
  onClose: () => void;
}

function buildPromptTemplate(label: string): string {
  return `You are helping me edit a ${label} for a question bank app called Nexam. The current ${label} is provided below as JSON.

Instructions: <describe the change you want here>

Return the complete, valid JSON for the ${label} only, keeping the same structure and keys. Do not add commentary or markdown formatting around it.`;
}

/** Lets a teacher hand a question or test off to an outside AI assistant
 *  (ChatGPT, Claude, Gemini, ...) and bring the result back -- a prompt
 *  template and the live JSON, each one copy away, rather than
 *  hand-assembling both every time. */
function AiPromptDialog({ open, label, json, onClose }: AiPromptDialogProps) {
  const [promptCopied, setPromptCopied] = useState(false);
  const [jsonCopied, setJsonCopied] = useState(false);
  const [bothCopied, setBothCopied] = useState(false);

  const prompt = buildPromptTemplate(label);

  useEffect(() => {
    if (!open) return;
    setPromptCopied(false);
    setJsonCopied(false);
    setBothCopied(false);
  }, [open]);

  if (!open) return null;

  function copy(text: string, onDone: (copied: boolean) => void) {
    void navigator.clipboard.writeText(text).then(
      () => onDone(true),
      () => onDone(false),
    );
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        className="settings-modal ai-prompt-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Use AI to edit this ${label}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-header">
          <h2>Use AI to edit this {label}</h2>
          <button type="button" className="settings-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="settings-body">
          <p className="ai-prompt-intro">
            Copy the prompt and the {label}&rsquo;s JSON into ChatGPT, Claude, Gemini, or any AI
            assistant. Describe what you want changed, then paste the complete JSON it returns
            back into Text View here.
          </p>

          <section className="ai-prompt-section">
            <div className="ai-prompt-section-header">
              <h3>Prompt</h3>
              <button type="button" onClick={() => copy(prompt, setPromptCopied)}>
                {promptCopied ? "Copied" : "Copy"}
              </button>
            </div>
            <textarea className="ai-prompt-textarea" value={prompt} readOnly rows={6} />
          </section>

          <section className="ai-prompt-section">
            <div className="ai-prompt-section-header">
              <h3>{label === "question" ? "Question" : "Test"} JSON</h3>
              <button type="button" onClick={() => copy(json, setJsonCopied)}>
                {jsonCopied ? "Copied" : "Copy"}
              </button>
            </div>
            <textarea className="ai-prompt-textarea" value={json} readOnly rows={10} />
          </section>
        </div>

        <div className="bank-properties-actions">
          <button
            type="button"
            onClick={() => copy(`${prompt}\n\n${json}`, setBothCopied)}
          >
            {bothCopied ? "Copied Both" : "Copy Prompt + JSON"}
          </button>
          <button type="button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

export default AiPromptDialog;
