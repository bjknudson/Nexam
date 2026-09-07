import { SETTINGS_KEYS, usePersistedBoolean } from "./appSettings";
import type { MasteryCalculation, MasteryReporting, MasterySettingsModel } from "./types";

export const CALCULATION_LABEL: Record<MasteryCalculation, string> = {
  level_ladder: "Level Ladder",
  difficulty_weighted: "Difficulty Weighted",
  rubric_levels: "Rubric Levels",
};

export const CALCULATION_HELP: Record<MasteryCalculation, string> = {
  level_ladder:
    "Requires mastery in sequence: a level counts as cleared at 75%, and mastery is the last level cleared plus progress into the next. Best when the test walks the levels in order.",
  difficulty_weighted:
    "Converts partial success on a difficult question into estimated mastery, without assuming every level below it was cleared. Best when the test has hard questions but not a full ladder of them.",
  rubric_levels:
    "Applies the ladder to a multipart task's own components, each with its own difficulty. Best when the rubric was written around mastery levels. Falls back to laddering whole questions when no component carries one.",
};

export const REPORTING_LABEL: Record<MasteryReporting, string> = {
  exact: "Exact (two decimals)",
  half_steps: "Half steps (nearest 0.5)",
};

interface MasteryModePickerProps {
  settings: MasterySettingsModel;
  /** Shown as the "follow the default" option on a per-test picker. Omit on the
   *  gradebook-wide picker, which is what everything else follows. */
  inheritedFrom?: MasterySettingsModel | null;
  isOverridden?: boolean;
  busy?: boolean;
  onChange: (next: { calculation?: MasteryCalculation; reporting?: MasteryReporting }) => void;
  onClearOverride?: () => void;
}

/** The two controls that decide what a mastery number means. Deliberately one
 *  component for both the gradebook default and a single test's override --
 *  they are the same choice at two scopes, and a teacher comparing them should
 *  not have to read two different UIs. */
export default function MasteryModePicker({
  settings,
  inheritedFrom,
  isOverridden = false,
  busy = false,
  onChange,
  onClearOverride,
}: MasteryModePickerProps) {
  const [rubricMasteryLevels] = usePersistedBoolean(SETTINGS_KEYS.rubricMasteryLevels, false);

  // Rubric Levels is only offered once mastery levels on rubrics are switched
  // on -- but never withdrawn from a test already using it, or the control
  // would show a value it cannot display.
  const offered = (Object.keys(CALCULATION_LABEL) as MasteryCalculation[]).filter(
    (option) =>
      option !== "rubric_levels" ||
      rubricMasteryLevels ||
      settings.calculation === "rubric_levels",
  );

  return (
    <div className="mastery-picker">
      <div className="score-export-controls">
        <label>
          Calculation
          <select
            value={settings.calculation}
            disabled={busy}
            onChange={(event) =>
              onChange({ calculation: event.target.value as MasteryCalculation })
            }
          >
            {offered.map((option) => (
              <option key={option} value={option}>
                {CALCULATION_LABEL[option]}
              </option>
            ))}
          </select>
        </label>

        <label>
          Reporting
          <select
            value={settings.reporting}
            disabled={busy}
            onChange={(event) => onChange({ reporting: event.target.value as MasteryReporting })}
          >
            {(Object.keys(REPORTING_LABEL) as MasteryReporting[]).map((option) => (
              <option key={option} value={option}>
                {REPORTING_LABEL[option]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="score-export-help">{CALCULATION_HELP[settings.calculation]}</p>

      {!rubricMasteryLevels && settings.calculation !== "rubric_levels" ? (
        <p className="score-export-help">
          Rubric Levels is hidden. Turn on <strong>Mastery levels on rubrics</strong> in Settings
          to give a rubric's parts their own difficulties and score them separately.
        </p>
      ) : null}

      {inheritedFrom ? (
        <p className="score-export-help">
          {isOverridden ? (
            <>
              This test is set apart from the gradebook default (
              {CALCULATION_LABEL[inheritedFrom.calculation]},{" "}
              {REPORTING_LABEL[inheritedFrom.reporting].toLowerCase()}), and stays put when that
              default changes.{" "}
              {onClearOverride ? (
                <button
                  type="button"
                  className="link-button"
                  disabled={busy}
                  onClick={onClearOverride}
                >
                  Follow the default instead
                </button>
              ) : null}
            </>
          ) : (
            <>Following the gradebook default. Changing either control here sets this test apart.</>
          )}
        </p>
      ) : null}
    </div>
  );
}
