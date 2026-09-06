import { useEffect, useState } from "react";

export const SETTINGS_KEYS = {
  showFullPaths: "nexam:show-full-paths",
  questionsShowTypeTopicFilters: "nexam:qp-show-type-topic-filters",
  questionsShowStandardsFilter: "nexam:qp-show-standards-filter",
  questionsShowDifficultyFilter: "nexam:qp-show-difficulty-filter",
  questionsShowSubtopicFilter: "nexam:qp-show-subtopic-filter",
  questionsShowStatusFilter: "nexam:qp-show-status-filter",
  questionsShortenText: "nexam:qp-shorten-question-text",
  // Shows the per-rubric-row Level field, and offers Rubric Levels as a
  // mastery calculation. Off by default: levelling a rubric is an authoring
  // commitment, and everything else works without it.
  rubricMasteryLevels: "nexam:rubric-mastery-levels",
  bankDirectory: "nexam:bank-directory",
  lastGradebookPath: "nexam:last-gradebook-path",
} as const;

/** The same setting under the app's former name.
 *
 *  Renaming Nexzam to Nexam changed every key, which on its own would have
 *  quietly reset each teacher's preferences -- including the bank directory and
 *  the last gradebook they had open. Reads fall back to the old key and the
 *  next write moves the value across; the old key is left in place rather than
 *  deleted, so an older build still finds its settings. */
function legacyKey(key: string): string {
  return key.replace(/^nexam:/, "nexzam:");
}

function readSetting(key: string): string | null {
  return localStorage.getItem(key) ?? localStorage.getItem(legacyKey(key));
}

// Persists to localStorage and stays in sync across windows (via the native
// `storage` event, which only fires in *other* documents than the one that
// wrote the value) as well as within the same window via React state.
export function usePersistedBoolean(key: string, defaultValue: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    const stored = readSetting(key);
    return stored === null ? defaultValue : stored === "true";
  });

  useEffect(() => {
    localStorage.setItem(key, String(value));
  }, [key, value]);

  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.key !== key || event.newValue === null) return;
      setValue(event.newValue === "true");
    }
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [key]);

  return [value, setValue];
}

// Same persistence/sync behavior as usePersistedBoolean, for string-valued settings.
export function usePersistedString(key: string, defaultValue: string): [string, (value: string) => void] {
  const [value, setValue] = useState(() => readSetting(key) ?? defaultValue);

  useEffect(() => {
    localStorage.setItem(key, value);
  }, [key, value]);

  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.key !== key || event.newValue === null) return;
      setValue(event.newValue);
    }
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [key]);

  return [value, setValue];
}
