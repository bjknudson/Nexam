import { useEffect, useState } from "react";

import { checkForUpdates, getAppVersion, pickDirectoryDialog } from "./desktop";

interface SettingsProps {
  open: boolean;
  onClose: () => void;
  showFullPaths: boolean;
  onShowFullPathsChange: (value: boolean) => void;
  questionsShowTypeTopicFilters: boolean;
  onQuestionsShowTypeTopicFiltersChange: (value: boolean) => void;
  questionsShowStandardsFilter: boolean;
  onQuestionsShowStandardsFilterChange: (value: boolean) => void;
  questionsShowDifficultyFilter: boolean;
  onQuestionsShowDifficultyFilterChange: (value: boolean) => void;
  questionsShowSubtopicFilter: boolean;
  onQuestionsShowSubtopicFilterChange: (value: boolean) => void;
  questionsShowStatusFilter: boolean;
  onQuestionsShowStatusFilterChange: (value: boolean) => void;
  questionsShortenText: boolean;
  onQuestionsShortenTextChange: (value: boolean) => void;
  rubricMasteryLevels: boolean;
  onRubricMasteryLevelsChange: (value: boolean) => void;
  bankDirectory: string;
  onBankDirectoryChange: (value: string) => void;
}

function Settings({
  open,
  onClose,
  showFullPaths,
  onShowFullPathsChange,
  questionsShowTypeTopicFilters,
  onQuestionsShowTypeTopicFiltersChange,
  questionsShowStandardsFilter,
  onQuestionsShowStandardsFilterChange,
  questionsShowDifficultyFilter,
  onQuestionsShowDifficultyFilterChange,
  questionsShowSubtopicFilter,
  onQuestionsShowSubtopicFilterChange,
  questionsShowStatusFilter,
  onQuestionsShowStatusFilterChange,
  questionsShortenText,
  onQuestionsShortenTextChange,
  rubricMasteryLevels,
  onRubricMasteryLevelsChange,
  bankDirectory,
  onBankDirectoryChange,
}: SettingsProps) {
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  useEffect(() => {
    if (!open) return;
    void getAppVersion().then(setAppVersion);
  }, [open]);

  if (!open) return null;

  async function handleCheckForUpdates() {
    setCheckingUpdate(true);
    try {
      await checkForUpdates();
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function handleChooseBankDirectory() {
    const chosen = await pickDirectoryDialog(bankDirectory || undefined);
    if (chosen) onBankDirectoryChange(chosen);
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-header">
          <h2>Settings</h2>
          <button type="button" className="settings-close" onClick={onClose} aria-label="Close settings">
            &times;
          </button>
        </div>

        <div className="settings-body">
          <section className="settings-section">
            <h3>General</h3>
            <div className="settings-row">
              <span>Show full file path</span>
              <input
                type="checkbox"
                checked={showFullPaths}
                onChange={(event) => onShowFullPathsChange(event.target.checked)}
              />
            </div>
          </section>

          <section className="settings-section">
            <h3>Bank Files</h3>
            <div className="settings-row settings-row-stacked">
              <span>Default folder</span>
              <div className="settings-directory-row">
                <span className="settings-directory-path" title={bankDirectory}>
                  {bankDirectory || "Not set"}
                </span>
                <button type="button" onClick={() => void handleChooseBankDirectory()}>
                  Choose Folder…
                </button>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h3>Questions Pane</h3>
            <div className="settings-row">
              <span>Show type &amp; topic filters</span>
              <input
                type="checkbox"
                checked={questionsShowTypeTopicFilters}
                onChange={(event) => onQuestionsShowTypeTopicFiltersChange(event.target.checked)}
              />
            </div>
            <div className="settings-row">
              <span>Show standards filter</span>
              <input
                type="checkbox"
                checked={questionsShowStandardsFilter}
                onChange={(event) => onQuestionsShowStandardsFilterChange(event.target.checked)}
              />
            </div>
            <div className="settings-row">
              <span>Show difficulty filter</span>
              <input
                type="checkbox"
                checked={questionsShowDifficultyFilter}
                onChange={(event) => onQuestionsShowDifficultyFilterChange(event.target.checked)}
              />
            </div>
            <div className="settings-row">
              <span>Show subtopic filter</span>
              <input
                type="checkbox"
                checked={questionsShowSubtopicFilter}
                onChange={(event) => onQuestionsShowSubtopicFilterChange(event.target.checked)}
              />
            </div>
            <div className="settings-row">
              <span>Show status filter</span>
              <input
                type="checkbox"
                checked={questionsShowStatusFilter}
                onChange={(event) => onQuestionsShowStatusFilterChange(event.target.checked)}
              />
            </div>
            <div className="settings-row">
              <span>Shorten long question text</span>
              <input
                type="checkbox"
                checked={questionsShortenText}
                onChange={(event) => onQuestionsShortenTextChange(event.target.checked)}
              />
            </div>
          </section>

          <section className="settings-section">
            <h3>Grading</h3>
            <div className="settings-row">
              <span>
                Mastery levels on rubrics
                <small>
                  Adds a difficulty to each rubric row, and offers Rubric Levels as a way of
                  calculating mastery. Only worth turning on if you write rubrics whose parts step
                  up in difficulty. Anything you have already set is kept either way.
                </small>
              </span>
              <input
                type="checkbox"
                checked={rubricMasteryLevels}
                onChange={(event) => onRubricMasteryLevelsChange(event.target.checked)}
              />
            </div>
          </section>

          <section className="settings-section">
            <h3>About</h3>
            <div className="settings-row">
              <span>Version</span>
              <span>{appVersion ?? "Unknown"}</span>
            </div>
            <div className="settings-row">
              <span>License</span>
              <span>GNU GPL v3.0 or later</span>
            </div>
            <div className="settings-row">
              <span>Updates</span>
              <button type="button" onClick={() => void handleCheckForUpdates()} disabled={checkingUpdate}>
                {checkingUpdate ? "Checking…" : "Check for Updates"}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

export default Settings;
