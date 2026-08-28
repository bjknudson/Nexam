import { useEffect, useState } from "react";

export const SETTINGS_KEYS = {
  showFullPaths: "nexzam:show-full-paths",
  questionsShowTypeTopicFilters: "nexzam:qp-show-type-topic-filters",
  questionsShowStandardsFilter: "nexzam:qp-show-standards-filter",
  questionsShowDifficultyFilter: "nexzam:qp-show-difficulty-filter",
  questionsShowSubtopicFilter: "nexzam:qp-show-subtopic-filter",
  questionsShowStatusFilter: "nexzam:qp-show-status-filter",
  questionsShortenText: "nexzam:qp-shorten-question-text",
  bankDirectory: "nexzam:bank-directory",
  lastGradebookPath: "nexzam:last-gradebook-path",
} as const;

// Persists to localStorage and stays in sync across windows (via the native
// `storage` event, which only fires in *other* documents than the one that
// wrote the value) as well as within the same window via React state.
export function usePersistedBoolean(key: string, defaultValue: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    const stored = localStorage.getItem(key);
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
  const [value, setValue] = useState(() => localStorage.getItem(key) ?? defaultValue);

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
