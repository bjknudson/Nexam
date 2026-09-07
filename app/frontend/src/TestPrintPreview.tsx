import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactElement } from "react";

import { getAdministeredTest, getAssetFileUrl, inspectAssets, listTestDrafts } from "./api";
import { printCurrentWindow } from "./desktop";
import { MathTextPreview } from "./MathPreview";
import type {
  AssetInspectionResponseModel,
  AssetModel,
  QuestionModel,
  QuestionType,
  TestDraftDetailModel,
  TestInstructionSectionOptionsModel,
  TestInstructionSectionModel,
  TestItemModel,
  TestPrintSettingsModel,
  TestTemplateBlockModel,
} from "./types";

interface TestPrintPreviewProps {
  testId: string | null;
  /** When set, renders the frozen test paper from an administered snapshot
   *  (gradebook side) instead of the live bank draft named by `testId`. */
  snapshotId?: string | null;
  onClose: () => void;
}

/** The minimal shape print rendering needs -- satisfied by both a live
 *  TestDraftDetailModel (bank) and a frozen AdministeredTestSnapshotModel
 *  (gradebook), so the same pagination/rendering code serves both. */
interface PrintableTestDetail {
  test: {
    title: string;
    version: string;
    items: TestItemModel[];
    print_settings: TestPrintSettingsModel;
  };
  questions: QuestionModel[];
}

const CHOICE_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function formatDate(value = new Date()) {
  return value.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function getPageSizeLabel(settings: TestPrintSettingsModel) {
  if (settings.page_size === "a4") return "A4";
  return settings.page_size === "legal" ? "Legal" : "Letter";
}

function assetRenderKey(questionId: string, index: number) {
  return `${questionId}::${index}`;
}

function QuestionAssetFigures({
  question,
  renders,
}: {
  question: QuestionModel;
  renders: Record<string, AssetInspectionResponseModel>;
}) {
  if (question.assets.length === 0) return null;

  return (
    <div className="print-question-assets">
      {question.assets.map((asset, index) => {
        const rendered = renders[assetRenderKey(question.id, index)]?.rendered_svg;
        return (
          <figure key={`${asset.path}-${index}`} className="print-question-asset">
            {asset.kind === "svg" ? (
              rendered ? (
                <div dangerouslySetInnerHTML={{ __html: rendered }} />
              ) : null
            ) : (
              <img src={getAssetFileUrl(asset.path)} alt="" />
            )}
          </figure>
        );
      })}
    </div>
  );
}

function questionById(test: PrintableTestDetail) {
  return Object.fromEntries(test.questions.map((question) => [question.id, question]));
}

function getChoices(question: QuestionModel): string[] {
  const choices = question.answer?.choices;
  return Array.isArray(choices) ? choices.map(String) : [];
}

function isQuestionItem(item: TestItemModel) {
  return (item.item_type ?? "question") === "question";
}

function isSectionItem(item: TestItemModel) {
  return item.item_type === "section";
}

const DEFAULT_INSTRUCTION_SECTIONS: Record<QuestionType, TestInstructionSectionModel> = {
  multiple_choice: {
    question_type: "multiple_choice",
    title: "Multiple Choice",
    instructions: "Select the best answer.",
    header_template: "{{section_title}}\n{{instructions}}\n{{topic}}\n{{standards}}\n{{time}}",
    show_topic: false,
    show_standards: false,
    show_suggested_time: true,
    suggested_time_mode: "calculated",
    suggested_time_sec: null,
  },
  numeric_response: {
    question_type: "numeric_response",
    title: "Numeric Response",
    instructions: "Enter a numeric answer.",
    header_template: "{{section_title}}\n{{instructions}}\n{{topic}}\n{{standards}}\n{{time}}",
    show_topic: false,
    show_standards: false,
    show_suggested_time: true,
    suggested_time_mode: "calculated",
    suggested_time_sec: null,
  },
  short_answer: {
    question_type: "short_answer",
    title: "Short Answer",
    instructions: "Write a concise response.",
    header_template: "{{section_title}}\n{{instructions}}\n{{topic}}\n{{standards}}\n{{time}}",
    show_topic: false,
    show_standards: false,
    show_suggested_time: true,
    suggested_time_mode: "calculated",
    suggested_time_sec: null,
  },
  free_response: {
    question_type: "free_response",
    title: "Free Response",
    instructions: "Show your work and justify your answer.",
    header_template: "{{section_title}}\n{{instructions}}\n{{topic}}\n{{standards}}\n{{time}}",
    show_topic: false,
    show_standards: false,
    show_suggested_time: true,
    suggested_time_mode: "calculated",
    suggested_time_sec: null,
  },
};

const DEFAULT_PAGE_HEADER: TestTemplateBlockModel = {
  template: "{{title}}\nVersion {{version}}    {{date}}",
  alignment: "center",
  horizontal_line: true,
  spacing_after_lines: 1,
};

const DEFAULT_NAME_FIELD: TestTemplateBlockModel = {
  template: "Name: ______________________________",
  alignment: "left",
  horizontal_line: false,
  spacing_after_lines: 1,
};

const DEFAULT_INSTRUCTION_OPTIONS: TestInstructionSectionOptionsModel = {
  show_topic: false,
  show_standards: false,
  show_suggested_time: true,
  alignment: "left",
  horizontal_line: true,
  spacing_after_lines: 1,
};

function getInstructionSection(
  settings: TestPrintSettingsModel,
  questionType: QuestionType,
): TestInstructionSectionModel {
  const section = settings.instruction_sections?.find((item) => item.question_type === questionType);
  return {
    ...DEFAULT_INSTRUCTION_SECTIONS[questionType],
    ...section,
  };
}

function getPageHeader(settings: TestPrintSettingsModel): TestTemplateBlockModel {
  return { ...DEFAULT_PAGE_HEADER, ...settings.page_header };
}

function getNameField(settings: TestPrintSettingsModel): TestTemplateBlockModel {
  return { ...DEFAULT_NAME_FIELD, ...settings.name_field };
}

function getInstructionOptions(
  settings: TestPrintSettingsModel,
): TestInstructionSectionOptionsModel {
  return {
    ...DEFAULT_INSTRUCTION_OPTIONS,
    ...settings.instruction_section_options,
  };
}

function getCorrectChoiceCount(question: QuestionModel) {
  const answer = question.answer ?? {};
  return Array.isArray(answer.correct_choice_indices) ? answer.correct_choice_indices.length : 1;
}

function getSectionInstruction(section: TestInstructionSectionModel, question: QuestionModel) {
  if (
    section.question_type === "multiple_choice" &&
    section.instructions === DEFAULT_INSTRUCTION_SECTIONS.multiple_choice.instructions
  ) {
    const correctCount = getCorrectChoiceCount(question);
    if (correctCount > 1) {
      return `Select the ${correctCount} choices.`;
    }
  }

  return section.instructions;
}

function getSectionRun(
  test: PrintableTestDetail,
  startIndex: number,
  questionsById: Record<string, QuestionModel>,
) {
  const firstItem = test.test.items[startIndex];
  const firstQuestion =
    firstItem && isQuestionItem(firstItem) && firstItem.question_id
      ? questionsById[firstItem.question_id]
      : null;
  if (!firstQuestion) return [];

  const run = [];
  for (let index = startIndex; index < test.test.items.length; index += 1) {
    const item = test.test.items[index];
    if (isSectionItem(item)) break;
    const question = item.question_id ? questionsById[item.question_id] : null;
    if (!question || question.type !== firstQuestion.type) break;
    run.push(question);
  }
  return run;
}

function getManualSectionRun(
  test: PrintableTestDetail,
  startIndex: number,
  questionsById: Record<string, QuestionModel>,
) {
  const run = [];
  for (let index = startIndex + 1; index < test.test.items.length; index += 1) {
    const item = test.test.items[index];
    if (isSectionItem(item)) break;
    if (!item.question_id) continue;
    const question = questionsById[item.question_id];
    if (question) run.push(question);
  }
  return run;
}

function formatSectionTime(seconds: number) {
  if (seconds <= 0) return "0 min";
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} min`;
}

function getSectionMetadata(
  section: TestInstructionSectionModel,
  options: TestInstructionSectionOptionsModel,
  run: QuestionModel[],
): Record<string, string> {
  const metadata: Record<string, string> = {};
  if (options.show_topic) {
    const topics = Array.from(new Set(run.map((question) => question.topic).filter(Boolean)));
    if (topics.length > 0) {
      metadata.topic = `Topic: ${topics.join(", ")}`;
    }
  }

  if (options.show_standards) {
    const standards = Array.from(
      new Set(
        run.flatMap((question) =>
          question.standards.map((reference) => reference.standard_id),
        ),
      ),
    );
    if (standards.length > 0) {
      metadata.standards = `Standards: ${standards.join(", ")}`;
    }
  }

  if (options.show_suggested_time) {
    const seconds =
      section.suggested_time_mode === "override"
        ? section.suggested_time_sec
        : run.reduce((total, question) => total + (question.estimated_time_sec ?? 0), 0);
    if ((seconds ?? 0) > 0) {
      metadata.time = `Suggested time: ${formatSectionTime(seconds ?? 0)}`;
    }
  }

  return metadata;
}

function getManualSectionMetadata(
  item: TestItemModel,
  options: TestInstructionSectionOptionsModel,
  run: QuestionModel[],
): Record<string, string> {
  const metadata: Record<string, string> = {};
  if (options.show_topic) {
    const topic = item.topic?.trim();
    if (topic) {
      metadata.topic = `Topic: ${topic}`;
    } else {
      const topics = Array.from(new Set(run.map((question) => question.topic).filter(Boolean)));
      if (topics.length > 0) {
        metadata.topic = `Topic: ${topics.join(", ")}`;
      }
    }
  }

  if (options.show_standards) {
    const itemStandards = item.standards ?? [];
    if (itemStandards.length > 0) {
      metadata.standards = `Standards: ${itemStandards.join(", ")}`;
    } else {
      const standards = Array.from(
        new Set(
          run.flatMap((question) =>
            question.standards.map((reference) => reference.standard_id),
          ),
        ),
      );
      if (standards.length > 0) {
        metadata.standards = `Standards: ${standards.join(", ")}`;
      }
    }
  }

  if (options.show_suggested_time) {
    const seconds =
      item.suggested_time_mode === "override"
        ? item.suggested_time_sec
        : run.reduce((total, question) => total + (question.estimated_time_sec ?? 0), 0);
    if ((seconds ?? 0) > 0) {
      metadata.time = `Suggested time: ${formatSectionTime(seconds ?? 0)}`;
    }
  }

  return metadata;
}

function applyTemplate(template: string, values: Record<string, string>) {
  return template
    .replace(/\{\{title\}\}/g, values.title ?? "")
    .replace(/\{\{version\}\}/g, values.version ?? "")
    .replace(/\{\{date\}\}/g, values.date ?? "")
    .replace(/\{\{section_title\}\}/g, values.section_title ?? "")
    .replace(/\{\{instructions\}\}/g, values.instructions ?? "")
    .replace(/\{\{topic\}\}/g, values.topic ?? "")
    .replace(/\{\{standards\}\}/g, values.standards ?? "")
    .replace(/\{\{time\}\}/g, values.time ?? "")
    .split("\n")
    .map((line: string) => line.trim())
    .filter(Boolean);
}

function TemplateBlock({
  block,
  values,
  className,
}: {
  block: TestTemplateBlockModel;
  values: Record<string, string>;
  className: string;
}) {
  const lines = applyTemplate(block.template, values);
  if (lines.length === 0) return null;

  return (
    <section
      className={`${className} align-${block.alignment} ${block.horizontal_line ? "with-line" : ""}`}
      style={{ marginBottom: `${Math.max(0, block.spacing_after_lines) * 0.12}in` }}
    >
      {lines.map((line: string, index: number) => (
        <MathTextPreview key={`${line}-${index}`} text={line} />
      ))}
    </section>
  );
}

/** Paper sizes in inches. */
const PAGE_DIMENSIONS: Record<TestPrintSettingsModel["page_size"], { width: number; height: number }> = {
  letter: { width: 8.5, height: 11 },
  legal: { width: 8.5, height: 14 },
  a4: { width: 8.27, height: 11.69 },
};

/** CSS reference pixels per inch. */
const PX_PER_INCH = 96;
const COLUMN_GAP_IN = 0.35;

interface PageGeometry {
  pageWidth: number;
  pageHeight: number;
  contentWidth: number;
  contentHeight: number;
  columnWidth: number;
  columnGap: number;
  columns: number;
}

function getPageGeometry(settings: TestPrintSettingsModel): PageGeometry {
  const paper = PAGE_DIMENSIONS[settings.page_size] ?? PAGE_DIMENSIONS.letter;
  const columns = Math.max(1, settings.columns);
  const pageWidth = paper.width * PX_PER_INCH;
  const pageHeight = paper.height * PX_PER_INCH;
  const margin = settings.margin_in * PX_PER_INCH;
  const contentWidth = Math.max(1, pageWidth - margin * 2);
  const contentHeight = Math.max(1, pageHeight - margin * 2);
  const columnGap = COLUMN_GAP_IN * PX_PER_INCH;
  const columnWidth = Math.max(
    1,
    (contentWidth - columnGap * (columns - 1)) / columns,
  );
  return { pageWidth, pageHeight, contentWidth, contentHeight, columnWidth, columnGap, columns };
}

/** Block indices laid out as pages of columns. */
type PageLayout = number[][][];

/** Fill column by column, page by page, so numbering runs top-to-bottom of
 *  column one and continues in column two of the *same* page.
 *
 *  CSS multi-column cannot do this: it balances one flow across the whole
 *  document, so with two columns question 5 lands at the bottom of page two
 *  while question 8 sits back at the top of page one. */
function paginateBlocks(
  heights: number[],
  leadHeight: number,
  geometry: PageGeometry,
): PageLayout {
  const { columns, contentHeight } = geometry;
  const pages: PageLayout = [];

  let page: number[][] = Array.from({ length: columns }, () => []);
  let columnIndex = 0;
  let used = 0;
  // The header or cover sheet spans the full width, so it shortens every
  // column on the first page.
  let columnHeight = Math.max(1, contentHeight - leadHeight);

  pages.push(page);

  heights.forEach((height, index) => {
    // `used > 0` keeps a block taller than a whole column from looping: it goes
    // on a column of its own and overflows rather than never being placed.
    if (used > 0 && used + height > columnHeight) {
      columnIndex += 1;
      if (columnIndex >= columns) {
        page = Array.from({ length: columns }, () => []);
        pages.push(page);
        columnIndex = 0;
        columnHeight = contentHeight;
      }
      used = 0;
    }
    page[columnIndex].push(index);
    used += height;
  });

  return pages;
}

/** Every atomic block of the test, in order.

 *  A block is the smallest thing that may not be split across a column or page
 *  boundary: a section header, or a question with its figures, choices, and
 *  response space. Pagination moves whole blocks, never parts of them. */
function buildPrintBlocks({
  selectedTest,
  settings,
  questionsById,
  instructionOptions,
  assetRenders,
}: {
  selectedTest: PrintableTestDetail;
  settings: TestPrintSettingsModel;
  questionsById: Record<string, QuestionModel>;
  instructionOptions: TestInstructionSectionOptionsModel;
  assetRenders: Record<string, AssetInspectionResponseModel>;
}): ReactElement[] {
  let questionNumber = 0;
  let previousQuestionType: QuestionType | null = null;
  let manualSectionQuestionType: QuestionType | null = null;
  let suppressAutoAfterManualSection = false;

  return selectedTest.test.items.map((item, index) => {
    if (isSectionItem(item)) {
      const sectionRun = getManualSectionRun(selectedTest, index, questionsById);
      const linkedSection = item.question_type
        ? getInstructionSection(settings, item.question_type)
        : null;
      const firstQuestion = sectionRun[0] ?? null;
      const title = item.title || linkedSection?.title || "Section";
      const instructions =
        item.instructions ||
        (linkedSection && firstQuestion
          ? getSectionInstruction(linkedSection, firstQuestion)
          : linkedSection?.instructions) ||
        "";
      const sectionMetadata = getManualSectionMetadata(item, instructionOptions, sectionRun);
      previousQuestionType = null;
      manualSectionQuestionType = item.question_type ?? null;
      suppressAutoAfterManualSection = true;

      return (
        <article
          key={`${item.section_id ?? item.title ?? "section"}-${index}`}
          className="print-section-item"
        >
          <TemplateBlock
            block={{
              template:
                item.header_template ??
                linkedSection?.header_template ??
                "{{section_title}}\n{{instructions}}\n{{topic}}\n{{standards}}\n{{time}}",
              alignment: instructionOptions.alignment,
              horizontal_line: instructionOptions.horizontal_line,
              spacing_after_lines: instructionOptions.spacing_after_lines,
            }}
            values={{
              section_title: title,
              instructions,
              ...sectionMetadata,
            }}
            className="print-instruction-section"
          />
        </article>
      );
    }

    const question = item.question_id ? questionsById[item.question_id] : null;
    const suppressAutoHeader =
      !!question &&
      suppressAutoAfterManualSection &&
      (!manualSectionQuestionType || manualSectionQuestionType === question.type);
    const showSectionHeader =
      !!question && !suppressAutoHeader && previousQuestionType !== question.type;
    const section = question
      ? getInstructionSection(settings, question.type)
      : null;
    const sectionRun = question
      ? getSectionRun(selectedTest, index, questionsById)
      : [];
    const sectionMetadata = section
      ? getSectionMetadata(section, instructionOptions, sectionRun)
      : {};
    const choices = question ? getChoices(question) : [];
    const responseLines =
      item.response_space_lines ?? settings.default_response_space_lines;

    if (question) {
      questionNumber += 1;
      if (
        suppressAutoAfterManualSection &&
        (!manualSectionQuestionType || manualSectionQuestionType !== question.type)
      ) {
        suppressAutoAfterManualSection = false;
        manualSectionQuestionType = null;
      }
      if (suppressAutoAfterManualSection && !manualSectionQuestionType) {
        suppressAutoAfterManualSection = false;
      }
      previousQuestionType = question.type;
    }

    return (
      <article key={`${item.question_id ?? "question"}-${index}`} className="print-question-item">
        {showSectionHeader && section && question ? (
          <TemplateBlock
            block={{
              template:
                section.header_template ??
                "{{section_title}}\n{{instructions}}\n{{topic}}\n{{standards}}\n{{time}}",
              alignment: instructionOptions.alignment,
              horizontal_line: instructionOptions.horizontal_line,
              spacing_after_lines: instructionOptions.spacing_after_lines,
            }}
            values={{
              section_title: section.title,
              instructions: getSectionInstruction(section, question),
              ...sectionMetadata,
            }}
            className="print-instruction-section"
          />
        ) : null}

        {/* Number and prompt share one flex row so the text starts
            beside the number rather than beneath it. */}
        <div className="print-question-header">
          <strong className="print-question-number">{questionNumber}.</strong>
          {question ? (
            <MathTextPreview text={question.prompt} className="print-question-prompt" />
          ) : (
            <p className="print-missing-question">
              Question not found: {item.question_id}
            </p>
          )}
        </div>

        {question ? (
          <>
            <QuestionAssetFigures question={question} renders={assetRenders} />
            {choices.length > 0 ? (
              <ol className="print-choice-list">
                {choices.map((choice, choiceIndex) => (
                  <li key={`${choice}-${choiceIndex}`}>
                    <span>{CHOICE_LABELS[choiceIndex] ?? `${choiceIndex + 1}`}</span>
                    <MathTextPreview text={choice} preferWholeExpression />
                  </li>
                ))}
              </ol>
            ) : null}
            {responseLines > 0 ? (
              <div className="print-response-space">
                {Array.from({ length: responseLines }).map((_, lineIndex) => (
                  <i key={lineIndex} />
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </article>
    );
  });
}

function TestPrintPreview({ testId, snapshotId, onClose }: TestPrintPreviewProps) {
  const [tests, setTests] = useState<TestDraftDetailModel[]>([]);
  const [snapshotTest, setSnapshotTest] = useState<PrintableTestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [assetRenders, setAssetRenders] = useState<Record<string, AssetInspectionResponseModel>>({});
  const [assetsLoading, setAssetsLoading] = useState(false);
  // Kept separate from errorMessage on purpose: failing to render a diagram
  // must not replace the whole printable test with an error.
  const [assetError, setAssetError] = useState("");
  const [printError, setPrintError] = useState("");
  const previewViewportRef = useRef<HTMLDivElement | null>(null);
  const measureBlocksRef = useRef<HTMLDivElement | null>(null);
  const measureLeadRef = useRef<HTMLDivElement | null>(null);
  // Measured heights of every block, and of the full-width header/cover, in the
  // exact column width they will print at. Null until the first measure lands.
  const [blockHeights, setBlockHeights] = useState<number[] | null>(null);
  const [leadHeight, setLeadHeight] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setLoading(true);
      try {
        if (snapshotId) {
          const snapshot = await getAdministeredTest(snapshotId);
          if (cancelled) return;
          setSnapshotTest({
            test: {
              title: snapshot.title,
              version: snapshot.version,
              items: snapshot.items,
              print_settings: snapshot.print_settings,
            },
            questions: snapshot.questions,
          });
        } else {
          const response = await listTestDrafts();
          if (cancelled) return;
          setTests(response.items);
        }
        setErrorMessage("");
      } catch (error) {
        if (cancelled) return;
        setErrorMessage((error as Error).message);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [snapshotId]);

  const selectedTest: PrintableTestDetail | null = snapshotId
    ? snapshotTest
    : tests.find((item) => item.test.id === testId) ?? tests[0] ?? null;
  const questionsById = useMemo(
    () => (selectedTest ? questionById(selectedTest) : {}),
    [selectedTest],
  );

  useEffect(() => {
    if (!selectedTest) return;

    const entries: Array<{ key: string; asset: AssetModel }> = [];
    for (const question of selectedTest.questions) {
      question.assets.forEach((asset, index) => {
        entries.push({ key: assetRenderKey(question.id, index), asset });
      });
    }

    if (entries.length === 0) {
      setAssetRenders({});
      setAssetsLoading(false);
      setAssetError("");
      return;
    }

    let cancelled = false;
    setAssetsLoading(true);
    setAssetError("");

    void (async () => {
      try {
        const response = await inspectAssets(entries.map((entry) => entry.asset));
        if (cancelled) return;
        const next: Record<string, AssetInspectionResponseModel> = {};
        response.items.forEach((item, index) => {
          const entry = entries[index];
          if (entry) next[entry.key] = item;
        });
        setAssetRenders(next);
      } catch (error) {
        // Degrade to a test without figures rather than losing the preview.
        if (!cancelled) {
          setAssetRenders({});
          setAssetError((error as Error).message);
        }
      } finally {
        if (!cancelled) setAssetsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedTest]);

  // Everything below has to run before the early returns to keep hook order
  // stable, so each piece tolerates `selectedTest` being null.
  const previewSettings = selectedTest?.test.print_settings ?? null;
  const geometry = useMemo(
    () => (previewSettings ? getPageGeometry(previewSettings) : null),
    [previewSettings],
  );

  const blocks = useMemo(() => {
    if (!selectedTest || !previewSettings) return [] as ReactElement[];
    return buildPrintBlocks({
      selectedTest,
      settings: previewSettings,
      questionsById,
      instructionOptions: getInstructionOptions(previewSettings),
      assetRenders,
    });
  }, [selectedTest, previewSettings, questionsById, assetRenders]);

  // Measure off-screen at the real column width, then flow the measurements into
  // pages. A ResizeObserver covers content that settles late -- images decoding,
  // KaTeX swapping in its own metrics.
  useLayoutEffect(() => {
    const container = measureBlocksRef.current;
    if (!container) return;

    const measure = () => {
      const lead = measureLeadRef.current;
      const nextLead = lead ? lead.getBoundingClientRect().height : 0;
      const nextHeights = Array.from(container.children).map(
        (child) => (child as HTMLElement).getBoundingClientRect().height,
      );

      setLeadHeight((current) => (Math.abs(current - nextLead) < 0.5 ? current : nextLead));
      setBlockHeights((current) => {
        if (
          current &&
          current.length === nextHeights.length &&
          current.every((value, index) => Math.abs(value - nextHeights[index]) < 0.5)
        ) {
          return current;
        }
        return nextHeights;
      });
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(container);
    if (measureLeadRef.current) observer.observe(measureLeadRef.current);
    Array.from(container.children).forEach((child) => observer.observe(child));

    return () => observer.disconnect();
  }, [blocks, geometry, previewSettings]);

  const pages = useMemo(() => {
    if (!geometry || blocks.length === 0) return null;
    if (!blockHeights || blockHeights.length !== blocks.length) return null;
    return paginateBlocks(blockHeights, leadHeight, geometry);
  }, [blockHeights, leadHeight, geometry, blocks.length]);

  // A block taller than a whole column cannot be placed without splitting it,
  // which is the one thing pagination will not do. Say so rather than quietly
  // cropping the question off the sheet.
  const oversizeBlockLabels = useMemo(() => {
    if (!geometry || !blockHeights) return [] as string[];
    return blockHeights.flatMap((height, index) => {
      if (height <= geometry.contentHeight) return [];
      const key = String(blocks[index]?.key ?? "");
      // Keys look like "q_mc_0003-7"; the question id is the useful half.
      const label = key.replace(/-\d+$/, "").replace(/^\.\$/, "");
      return [label || `item ${index + 1}`];
    });
  }, [blockHeights, geometry, blocks]);

  if (loading) {
    return (
      <div className="print-preview-shell">
        <div className="print-preview-empty">Loading printable preview...</div>
      </div>
    );
  }

  if (errorMessage || !selectedTest) {
    return (
      <div className="print-preview-shell">
        <div className="print-preview-toolbar">
          <button type="button" onClick={onClose}>Close</button>
        </div>
        <div className="print-preview-empty">
          {errorMessage || "No test draft is available to preview."}
        </div>
      </div>
    );
  }

  async function handlePrint() {
    const viewport = previewViewportRef.current;
    if (viewport) {
      const images = Array.from(viewport.querySelectorAll("img"));
      await Promise.all(
        images.map((image) =>
          image.complete ? Promise.resolve() : image.decode().catch(() => undefined),
        ),
      );
    }

    // Fonts settle after images: printing mid-swap reflows the sheets and can
    // push a block onto the next page, which is exactly what pagination just
    // worked out not to do.
    if (document.fonts?.ready) {
      await document.fonts.ready.catch(() => undefined);
    }

    try {
      // Narrowing above (the early `if (!selectedTest) return`) doesn't carry
      // into this nested function declaration, but the guard makes this safe.
      await printCurrentWindow(selectedTest!.test.print_settings.page_size);
      setPrintError("");
    } catch (error) {
      setPrintError((error as Error).message || String(error));
    }
  }

  const settings = selectedTest.test.print_settings;
  const pageHeader = getPageHeader(settings);
  const nameField = getNameField(settings);
  const instructionOptions = getInstructionOptions(settings);
  const headerValues = {
    title: selectedTest.test.title,
    version: selectedTest.test.version,
    date: formatDate(),
  };
  // `geometry` is memoized before the early returns, so it carries a null in its
  // type even though a rendered preview always has settings to derive it from.
  const pageGeometry = geometry ?? getPageGeometry(settings);

  // The header or cover sheet: full page width, first page only.
  const leadContent = settings.cover_sheet_enabled ? (
    <section className="print-cover-sheet">
      <TemplateBlock
        block={pageHeader}
        values={headerValues}
        className="print-page-header-template"
      />
      {settings.name_field_enabled ? (
        <TemplateBlock block={nameField} values={headerValues} className="print-name-template" />
      ) : null}
    </section>
  ) : (
    <div className="print-lead-block">
      <TemplateBlock
        block={pageHeader}
        values={headerValues}
        className="print-page-header-template compact"
      />
      {settings.name_field_enabled ? (
        <TemplateBlock
          block={nameField}
          values={headerValues}
          className="print-name-template compact"
        />
      ) : null}
    </div>
  );

  const pageSizeForPrint = settings.page_size === "a4" ? "A4" : settings.page_size;
  const printStyle = {
    "--print-font-size": `${settings.font_size_pt}pt`,
    "--print-margin": `${settings.margin_in}in`,
    "--print-columns": settings.columns,
  } as CSSProperties;
  const scrollPreviewPage = (direction: -1 | 1) => {
    const viewport = previewViewportRef.current;
    if (!viewport) return;
    const page = viewport.querySelector<HTMLElement>(".print-page-wrapper");
    const distance = page ? page.getBoundingClientRect().height : viewport.clientHeight * 0.85;
    viewport.scrollBy({ top: direction * distance, behavior: "smooth" });
  };

  return (
    <div className="print-preview-shell" style={printStyle}>
      <style>{`@page { size: ${pageSizeForPrint}; margin: 0; }`}</style>
      <div className="print-preview-toolbar">
        <div>
          <strong>{selectedTest.test.title}</strong>
          <span>
            Version {selectedTest.test.version} / {getPageSizeLabel(settings)} / {settings.columns} column
            {settings.columns === 1 ? "" : "s"}
          </span>
        </div>
        {assetError ? (
          <span className="print-preview-warning" role="status">
            Asset previews unavailable ({assetError}). The test below prints without figures.
          </span>
        ) : null}
        {printError ? (
          <span className="print-preview-warning" role="status">
            {printError}
          </span>
        ) : null}
        {oversizeBlockLabels.length > 0 ? (
          <span className="print-preview-warning" role="status">
            {oversizeBlockLabels.length === 1 ? "1 question is" : `${oversizeBlockLabels.length} questions are`}{" "}
            taller than one column and will be cut off: {oversizeBlockLabels.join(", ")}. Shorten the
            prompt, trim response lines, or use fewer columns.
          </span>
        ) : null}
        <div className="print-preview-actions">
          <button type="button" onClick={() => scrollPreviewPage(-1)}>
            Previous Page
          </button>
          <button type="button" onClick={() => scrollPreviewPage(1)}>
            Next Page
          </button>
          <button type="button" onClick={() => void handlePrint()} disabled={assetsLoading}>
            {assetsLoading ? "Preparing..." : "Print"}
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      <div ref={previewViewportRef} className="print-preview-viewport">
        {/* Hidden measuring pass: the same blocks at the exact width they will
            print at, so their heights decide where the pages break. */}
        <div className="print-measure" aria-hidden="true">
          <div
            ref={measureLeadRef}
            className="print-measure-lead"
            style={{ width: `${pageGeometry.contentWidth}px` }}
          >
            {leadContent}
          </div>
          <div
            ref={measureBlocksRef}
            className="print-measure-blocks"
            style={{ width: `${pageGeometry.columnWidth}px` }}
          >
            {blocks.map((block, index) => (
              <div className="print-measure-block" key={block.key ?? index}>
                {block}
              </div>
            ))}
          </div>
        </div>

        {(pages ?? [[blocks.map((_, index) => index)]]).map((page, pageIndex, allPages) => (
          <div className="print-page-wrapper" key={`page-${pageIndex}`}>
            <main
              className={`print-page page-${settings.page_size}${
                pageIndex === allPages.length - 1 ? " print-page-last" : ""
              }`}
              style={{ width: `${pageGeometry.pageWidth}px`, height: `${pageGeometry.pageHeight}px` }}
            >
              {/* Dotted rule showing where the margin actually falls. */}
              <div className="print-page-margin-guide" aria-hidden="true" />
              {pageIndex === 0 ? leadContent : null}
              <div
                className="print-page-columns"
                style={{
                  gap: `${pageGeometry.columnGap}px`,
                  gridTemplateColumns: `repeat(${pageGeometry.columns}, minmax(0, 1fr))`,
                }}
              >
                {page.map((columnBlocks, columnIndex) => (
                  <div className="print-page-column" key={`column-${columnIndex}`}>
                    {columnBlocks.map((blockIndex) => blocks[blockIndex])}
                  </div>
                ))}
              </div>
            </main>
            <div className="print-page-break" aria-hidden="true">
              <span>
                Page {pageIndex + 1} of {allPages.length}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default TestPrintPreview;
