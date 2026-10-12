// Searching, filtering and sorting the bank's assets for the Bank Assets pane.
// Matches the drawing tool's stamp search: case and accents are ignored,
// every word typed must match the start of some word, and a result that
// matched on something other than its name says why.

import type { AssetListItemModel } from "./types";

export interface AssetFilters {
  kind: "all" | "svg" | "image";
  unusedOnly: boolean;
  onQuestionOnly: boolean;
  withVariablesOnly: boolean;
  topic: string | null;
}

export const NO_FILTERS: AssetFilters = {
  kind: "all",
  unusedOnly: false,
  onQuestionOnly: false,
  withVariablesOnly: false,
  topic: null,
};

export type AssetSort = "name" | "recent" | "uses";

export interface AssetMatch {
  asset: AssetListItemModel;
  /** Why it matched, when not by its name: e.g. "topic: Mechanics" or "“Pulley”". */
  reason: string | null;
}

export function assetName(asset: AssetListItemModel): string {
  return asset.path.split("/").slice(-1)[0] ?? asset.path;
}

function words(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[-_./]+/g, " ")
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

function singular(word: string): string {
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}

function covers(haystack: string[], needle: string): boolean {
  return haystack.some((word) => word.startsWith(needle) || word.startsWith(singular(needle)));
}

/** Null when `asset` doesn't match `query`; otherwise the match and its reason. */
export function matchAsset(asset: AssetListItemModel, query: string): AssetMatch | null {
  const needles = words(query);
  if (needles.length === 0) return { asset, reason: null };
  const nameWords = words(`${assetName(asset)} ${asset.kind}`);
  const sources: { label: string; text: string }[] = [
    ...(asset.topics ?? []).map((topic) => ({ label: `topic: ${topic}`, text: topic })),
    ...(asset.tags ?? []).map((tag) => ({ label: `tag: ${tag}`, text: tag })),
    ...(asset.search_terms ?? []).map((term) => ({ label: `“${term}”`, text: term })),
    ...asset.svg_placeholders.map((name) => ({ label: `variable: ${name}`, text: name })),
    ...asset.referenced_by.map((id) => ({ label: `used by ${id}`, text: id })),
  ];
  const everything = [...nameWords, ...sources.flatMap((source) => words(source.text))];
  if (!needles.every((needle) => covers(everything, needle))) return null;
  if (needles.every((needle) => covers(nameWords, needle))) return { asset, reason: null };
  const reason = sources.find((source) => needles.some((needle) => covers(words(source.text), needle)));
  return { asset, reason: reason?.label ?? null };
}

export function filterAssets(
  assets: AssetListItemModel[],
  query: string,
  filters: AssetFilters,
  attachedPaths: string[],
  sort: AssetSort,
): AssetMatch[] {
  const matches = assets
    .filter((asset) => {
      if (filters.kind === "svg" && asset.kind !== "svg") return false;
      if (filters.kind === "image" && asset.kind === "svg") return false;
      if (filters.unusedOnly && asset.referenced_by.length > 0) return false;
      if (filters.onQuestionOnly && !attachedPaths.includes(asset.path)) return false;
      if (filters.withVariablesOnly && asset.svg_placeholders.length === 0) return false;
      if (filters.topic && !(asset.topics ?? []).some((topic) => topic.toLowerCase() === filters.topic?.toLowerCase())) {
        return false;
      }
      return true;
    })
    .flatMap((asset) => matchAsset(asset, query) ?? []);
  const byName = (a: AssetMatch, b: AssetMatch) => assetName(a.asset).localeCompare(assetName(b.asset));
  if (sort === "recent") return matches.sort((a, b) => (b.asset.modified ?? 0) - (a.asset.modified ?? 0) || byName(a, b));
  if (sort === "uses") return matches.sort((a, b) => b.asset.referenced_by.length - a.asset.referenced_by.length || byName(a, b));
  return matches.sort(byName);
}

export function activeFilterCount(filters: AssetFilters): number {
  return (
    (filters.kind !== "all" ? 1 : 0) +
    (filters.unusedOnly ? 1 : 0) +
    (filters.onQuestionOnly ? 1 : 0) +
    (filters.withVariablesOnly ? 1 : 0) +
    (filters.topic ? 1 : 0)
  );
}
