import type { AssetModel, QuestionModel } from "./types";

/** Every place a question uses an asset: attached figures and answer-choice images. */
export function assetUsesIn(question: QuestionModel, path: string): AssetModel[] {
  const uses = question.assets.filter((asset) => asset.path === path);
  for (const asset of Object.values(choiceAssets(question))) {
    if (asset.path === path) uses.push(asset);
  }
  return uses;
}

/** The question pointed at a new copy of an asset (the drawing window's
 *  "Save as a copy for this question"). Each use keeps its svg_variables. */
export function swapAssetPath(question: QuestionModel, oldPath: string, newPath: string): QuestionModel {
  const swap = (asset: AssetModel): AssetModel => (asset.path === oldPath ? { ...asset, path: newPath } : asset);
  const choices = choiceAssets(question);
  const answer =
    question.answer && Object.keys(choices).length > 0
      ? {
          ...question.answer,
          choice_assets: Object.fromEntries(Object.entries(choices).map(([index, asset]) => [index, swap(asset)])),
        }
      : question.answer;
  return { ...question, assets: question.assets.map(swap), answer };
}

function choiceAssets(question: QuestionModel): Record<string, AssetModel> {
  const value = question.answer?.choice_assets;
  return value && typeof value === "object" ? (value as Record<string, AssetModel>) : {};
}
