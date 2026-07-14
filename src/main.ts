import {
  Editor,
  MarkdownView,
  Notice,
  Plugin,
  TFile,
  normalizePath,
  requestUrl,
} from "obsidian";
import {
  ContextualVocabularySettingTab,
  DEFAULT_SETTINGS,
  type ContextualVocabularySettings,
} from "./settings";

interface VocabularyAnalysis {
  headword: string;
  partOfSpeech: string;
  pronunciation: string;
  definition: string;
  contextualMeaning: string;
  sentenceReview: string;
  usageNote: string;
  example: string;
  synonyms: string[];
}

interface ManagedEntry {
  key: string;
  heading: string;
  block: string;
}

interface DictionaryUpdate {
  heading: string;
  alreadyExisted: boolean;
}

const INDEX_START = "<!-- contextual-vocabulary:index:start -->";
const INDEX_END = "<!-- contextual-vocabulary:index:end -->";
const ENTRIES_START = "<!-- contextual-vocabulary:entries:start -->";
const ENTRIES_END = "<!-- contextual-vocabulary:entries:end -->";
const ENTRY_PATTERN = /<!-- contextual-vocabulary:entry:start key="([^"]+)" -->[\s\S]*?<!-- contextual-vocabulary:entry:end -->/g;

export default class ContextualVocabularyPlugin extends Plugin {
  override settings: ContextualVocabularySettings = DEFAULT_SETTINGS;
  private isWorking = false;

  override async onload(): Promise<void> {
    await this.loadSettings();

    this.addCommand({
      id: "define-selected-vocabulary-word",
      name: "Define selected vocabulary word",
      editorCheckCallback: (checking, editor, view) => {
        const canRun = editor.somethingSelected() && view instanceof MarkdownView && !this.isWorking;
        if (canRun && !checking) {
          void this.defineSelection(editor, view);
        }
        return canRun;
      },
    });

    this.addSettingTab(new ContextualVocabularySettingTab(this.app, this));
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<ContextualVocabularySettings> | null);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async defineSelection(editor: Editor, view: MarkdownView): Promise<void> {
    if (this.isWorking) {
      new Notice("Contextual Vocabulary is already analyzing a word.");
      return;
    }

    const selectedText = editor.getSelection();
    const term = cleanSelectedTerm(selectedText);
    if (!term) {
      new Notice("Select one vocabulary word or short term first.");
      return;
    }

    let dictionaryPath: string;
    try {
      dictionaryPath = validateDictionaryPath(this.settings.dictionaryPath);
    } catch (error) {
      new Notice(errorMessage(error), 7000);
      return;
    }

    const sourceFile = view.file;
    if (!sourceFile) {
      new Notice("Open a saved Markdown note before defining a word.");
      return;
    }
    if (sourceFile.path === dictionaryPath) {
      new Notice("Define words from a note other than the dictionary itself.", 7000);
      return;
    }

    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    let existingHeading: string | null;
    try {
      existingHeading = await this.findExistingHeading(dictionaryPath, term);
    } catch (error) {
      new Notice(`Contextual Vocabulary: ${errorMessage(error)}`, 10000);
      return;
    }
    if (existingHeading) {
      editor.replaceRange(makeDictionaryLink(dictionaryPath, existingHeading, selectedText), from, to);
      new Notice(`Linked “${term}” to its existing dictionary entry.`);
      return;
    }

    if (!this.settings.apiKey) {
      new Notice("Add an API key in Settings → Contextual Vocabulary first.", 7000);
      return;
    }

    const sentence = extractContainingSentence(editor.getValue(), editor.posToOffset(from), editor.posToOffset(to));
    const notice = new Notice(`Reviewing “${term}” in context…`, 0);
    this.isWorking = true;

    try {
      const analysis = await this.analyzeVocabulary(term, sentence);
      const update = await this.upsertDictionaryEntry(dictionaryPath, analysis, term, sentence, sourceFile);

      if (editor.getRange(from, to) !== selectedText) {
        throw new Error("The source note changed while the AI request was running. The dictionary was updated, but the selection was not replaced.");
      }

      const link = makeDictionaryLink(dictionaryPath, update.heading, selectedText);
      editor.replaceRange(link, from, to);

      notice.hide();
      new Notice(update.alreadyExisted
        ? `Linked “${term}” to its existing dictionary entry.`
        : `Added and linked “${update.heading}”.`);
    } catch (error) {
      notice.hide();
      console.error("Contextual Vocabulary:", error);
      new Notice(`Contextual Vocabulary: ${errorMessage(error)}`, 10000);
    } finally {
      this.isWorking = false;
    }
  }

  private async findExistingHeading(path: string, term: string): Promise<string | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) return null;
    if (!(file instanceof TFile)) {
      throw new Error(`The dictionary path points to a folder: ${path}`);
    }
    const entries = parseManagedEntries(await this.app.vault.cachedRead(file));
    return entries.find((entry) => entry.key === canonicalKey(term))?.heading ?? null;
  }

  private async analyzeVocabulary(term: string, sentence: string): Promise<VocabularyAnalysis> {
    const endpoint = this.settings.apiEndpoint.trim();
    const model = this.settings.model.trim();
    if (!/^https:\/\//i.test(endpoint)) {
      throw new Error("The AI endpoint must be an HTTPS URL.");
    }
    if (!model) {
      throw new Error("Set an AI model in the plugin settings.");
    }

    const response = await requestUrl({
      url: endpoint,
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "You are a precise vocabulary editor.",
              "Analyze the highlighted term using the supplied sentence as context.",
              "Review whether the term is used naturally and explain its grammatical/contextual role.",
              "Return only valid JSON with exactly these keys:",
              "headword, partOfSpeech, pronunciation, definition, contextualMeaning, sentenceReview, usageNote, example, synonyms.",
              "synonyms must be an array of short strings; all other values must be strings.",
              "Keep the headword the same as the highlighted term except for sensible dictionary capitalization.",
              "Keep every field concise, accurate, and free of Markdown.",
            ].join(" "),
          },
          {
            role: "user",
            content: JSON.stringify({ highlightedTerm: term, sentence }),
          },
        ],
      }),
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      const detail = readApiError(response.json) || response.text.slice(0, 300);
      throw new Error(`AI request failed (${response.status})${detail ? `: ${detail}` : "."}`);
    }

    const content = readAssistantContent(response.json);
    if (!content) {
      throw new Error("The AI returned an empty response.");
    }

    return validateAnalysis(parseJsonObject(content), term);
  }

  private async upsertDictionaryEntry(
    path: string,
    analysis: VocabularyAnalysis,
    selectedTerm: string,
    sentence: string,
    sourceFile: TFile,
  ): Promise<DictionaryUpdate> {
    await ensureParentFolders(this, path);
    const existingFile = this.app.vault.getAbstractFileByPath(path);
    if (existingFile && !(existingFile instanceof TFile)) {
      throw new Error(`The dictionary path points to a folder: ${path}`);
    }

    const file = existingFile instanceof TFile
      ? existingFile
      : await this.app.vault.create(path, initialDictionary());

    let result: DictionaryUpdate = { heading: analysis.headword, alreadyExisted: false };
    await this.app.vault.process(file, (current) => {
      const scaffolded = ensureScaffold(current);
      const entries = parseManagedEntries(scaffolded);
      const key = canonicalKey(selectedTerm);
      const existing = entries.find((entry) => entry.key === key);
      if (existing) {
        result = { heading: existing.heading, alreadyExisted: true };
        return scaffolded;
      }

      const block = formatEntry(key, analysis, sentence, sourceFile);
      entries.push({ key, heading: analysis.headword, block });
      entries.sort((a, b) => a.heading.localeCompare(b.heading, undefined, { sensitivity: "base" }));
      result = { heading: analysis.headword, alreadyExisted: false };
      return replaceManagedSections(scaffolded, entries);
    });

    return result;
  }
}

function cleanSelectedTerm(selection: string): string | null {
  const cleaned = selection
    .replace(/^\s+|\s+$/g, "")
    .replace(/^[`*_~]+|[`*_~]+$/g, "")
    .replace(/^[\s“”‘’"'([{]+|[\s“”‘’"')\]},.:;!?]+$/g, "")
    .trim();

  if (!cleaned || cleaned.length > 80 || /[\r\n]/.test(cleaned) || !/[\p{L}\p{N}]/u.test(cleaned)) {
    return null;
  }
  return cleaned;
}

function validateDictionaryPath(value: string): string {
  let path = normalizePath(value.trim() || DEFAULT_SETTINGS.dictionaryPath);
  if (!path.toLowerCase().endsWith(".md")) {
    path += ".md";
  }
  if (path.startsWith(".obsidian/") || path === ".obsidian.md") {
    throw new Error("Choose a dictionary note inside the vault, not inside .obsidian.");
  }
  return path;
}

function extractContainingSentence(document: string, start: number, end: number): string {
  const before = document.slice(0, start);
  const matches = [...before.matchAll(/\n\s*\n/g)];
  const paragraphStart = matches.length ? (matches[matches.length - 1]?.index ?? -2) + (matches[matches.length - 1]?.[0].length ?? 2) : 0;
  const nextBreak = document.slice(end).search(/\n\s*\n/);
  const paragraphEnd = nextBreak === -1 ? document.length : end + nextBreak;
  const paragraph = document.slice(paragraphStart, paragraphEnd);
  const localStart = start - paragraphStart;
  const localEnd = end - paragraphStart;

  try {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
    for (const segment of segmenter.segment(paragraph)) {
      const segmentEnd = segment.index + segment.segment.length;
      if (segment.index <= localStart && segmentEnd >= localEnd) {
        return cleanContext(segment.segment);
      }
    }
  } catch {
    // Older Obsidian builds may not expose Intl.Segmenter; use the paragraph fallback.
  }

  return cleanContext(paragraph);
}

function cleanContext(value: string): string {
  return value
    .replace(/^\s{0,3}(?:>|[-*+] |\d+[.)] )+/gm, "")
    .replace(/!?(\[([^\]]+)\])\([^\)]+\)/g, "$2")
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_match, target: string, alias?: string) => alias ?? target)
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
}

function parseJsonObject(content: string): unknown {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(stripped) as unknown;
  } catch {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(stripped.slice(start, end + 1)) as unknown;
    }
    throw new Error("The AI response was not valid JSON.");
  }
}

function validateAnalysis(value: unknown, fallbackHeadword: string): VocabularyAnalysis {
  if (!value || typeof value !== "object") {
    throw new Error("The AI response did not contain a vocabulary analysis.");
  }
  const record = value as Record<string, unknown>;
  const read = (key: string, fallback = "Not provided"): string => {
    const item = record[key];
    return typeof item === "string" && item.trim() ? sanitizeInline(item) : fallback;
  };
  const rawSynonyms = record.synonyms;
  const synonyms = Array.isArray(rawSynonyms)
    ? rawSynonyms.filter((item): item is string => typeof item === "string").map(sanitizeInline).filter(Boolean).slice(0, 8)
    : [];

  const headword = sanitizeHeading(read("headword", fallbackHeadword)) || sanitizeHeading(fallbackHeadword);
  return {
    headword,
    partOfSpeech: read("partOfSpeech"),
    pronunciation: read("pronunciation", "—"),
    definition: read("definition"),
    contextualMeaning: read("contextualMeaning"),
    sentenceReview: read("sentenceReview"),
    usageNote: read("usageNote"),
    example: read("example"),
    synonyms,
  };
}

function sanitizeInline(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").replace(/[<>]/g, "").trim().slice(0, 1000);
}

function sanitizeHeading(value: string): string {
  return sanitizeInline(value).replace(/^[#\s]+/, "").replace(/[#[\]|^]/g, "").trim().slice(0, 80);
}

function readAssistantContent(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices.length) return null;
  const message = (choices[0] as { message?: unknown } | undefined)?.message;
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text : "")
      .join("");
  }
  return null;
}

function readApiError(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const error = (json as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return "";
}

async function ensureParentFolders(plugin: ContextualVocabularyPlugin, path: string): Promise<void> {
  const parts = path.split("/").slice(0, -1);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!plugin.app.vault.getAbstractFileByPath(current)) {
      await plugin.app.vault.createFolder(current);
    }
  }
}

function initialDictionary(): string {
  return [
    "---",
    "tags:",
    "  - dictionary",
    "cssclasses:",
    "  - contextual-vocabulary-dictionary",
    "---",
    "",
    "# Dictionary",
    "",
    "> [!info] How to use",
    "> Highlight a word in any note and run **Contextual Vocabulary: Define selected vocabulary word**. This index and the entries below stay alphabetized automatically.",
    "",
    INDEX_START,
    formatIndex([]),
    INDEX_END,
    "",
    ENTRIES_START,
    ENTRIES_END,
    "",
  ].join("\n");
}

function ensureScaffold(content: string): string {
  let result = content.trim() ? content.trimEnd() + "\n" : initialDictionary();
  const hasIndex = result.includes(INDEX_START) && result.includes(INDEX_END);
  const hasEntries = result.includes(ENTRIES_START) && result.includes(ENTRIES_END);
  if (hasIndex && hasEntries) return result;

  const sections: string[] = [];
  if (!hasIndex) sections.push(`${INDEX_START}\n${formatIndex([])}\n${INDEX_END}`);
  if (!hasEntries) sections.push(`${ENTRIES_START}\n${ENTRIES_END}`);
  return `${result.trimEnd()}\n\n${sections.join("\n\n")}\n`;
}

function parseManagedEntries(content: string): ManagedEntry[] {
  const start = content.indexOf(ENTRIES_START);
  const end = content.indexOf(ENTRIES_END, start + ENTRIES_START.length);
  if (start === -1 || end === -1) return [];
  const section = content.slice(start + ENTRIES_START.length, end);
  const entries: ManagedEntry[] = [];
  for (const match of section.matchAll(ENTRY_PATTERN)) {
    const block = match[0];
    const key = match[1];
    const heading = block.match(/^##\s+(.+)$/m)?.[1]?.trim();
    if (key && heading) entries.push({ key, heading, block });
  }
  return entries;
}

function replaceManagedSections(content: string, entries: ManagedEntry[]): string {
  const index = formatIndex(entries);
  const blocks = entries.map((entry) => entry.block.trim()).join("\n\n");
  let updated = replaceBetween(content, INDEX_START, INDEX_END, `\n${index}\n`);
  updated = replaceBetween(updated, ENTRIES_START, ENTRIES_END, blocks ? `\n${blocks}\n` : "\n");
  return updated.trimEnd() + "\n";
}

function replaceBetween(content: string, startMarker: string, endMarker: string, replacement: string): string {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start + startMarker.length);
  if (start === -1 || end === -1) return content;
  return content.slice(0, start + startMarker.length) + replacement + content.slice(end);
}

function formatIndex(entries: ManagedEntry[]): string {
  const lines = ["## Quick index", "", "<div class=\"contextual-vocabulary-index\">", ""];
  if (!entries.length) {
    lines.push("*No vocabulary entries yet.*");
  } else {
    const groups = new Map<string, ManagedEntry[]>();
    for (const entry of entries) {
      const initial = /^[\p{L}\p{N}]/u.test(entry.heading) ? (Array.from(entry.heading)[0] ?? "#").toLocaleUpperCase() : "#";
      const group = groups.get(initial) ?? [];
      group.push(entry);
      groups.set(initial, group);
    }
    for (const [initial, group] of groups) {
      lines.push(`**${escapeMarkdown(initial)}** · ${group.map((entry) => `[[#${escapeWiki(entry.heading)}|${escapeWiki(entry.heading)}]]`).join(" · ")}`);
      lines.push("");
    }
  }
  lines.push("", "</div>");
  return lines.join("\n");
}

function formatEntry(key: string, analysis: VocabularyAnalysis, sentence: string, sourceFile: TFile): string {
  const sourceTarget = sourceFile.path.replace(/\.md$/i, "");
  const sourceAlias = sourceFile.basename;
  const synonyms = analysis.synonyms.length ? analysis.synonyms.map(escapeMarkdown).join(", ") : "—";
  return [
    `<!-- contextual-vocabulary:entry:start key="${escapeHtmlAttribute(key)}" -->`,
    `## ${analysis.headword}`,
    "",
    `**Pronunciation:** ${escapeMarkdown(analysis.pronunciation)}  `,
    `**Part of speech:** ${escapeMarkdown(analysis.partOfSpeech)}`,
    "",
    `**Definition:** ${escapeMarkdown(analysis.definition)}`,
    "",
    `**Meaning in context:** ${escapeMarkdown(analysis.contextualMeaning)}`,
    "",
    `**Sentence review:** ${escapeMarkdown(analysis.sentenceReview)}`,
    "",
    `**Usage note:** ${escapeMarkdown(analysis.usageNote)}`,
    "",
    `**Example:** ${escapeMarkdown(analysis.example)}`,
    "",
    `**Synonyms:** ${synonyms}`,
    "",
    "> [!quote] Original context",
    `> ${escapeBlockquote(sentence)}`,
    "",
    `**Source:** [[${escapeWiki(sourceTarget)}|${escapeWiki(sourceAlias)}]] · [[#Quick index|↑ Index]]`,
    "",
    "---",
    `<!-- contextual-vocabulary:entry:end -->`,
  ].join("\n");
}

function canonicalKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function makeDictionaryLink(dictionaryPath: string, heading: string, alias: string): string {
  const target = dictionaryPath.replace(/\.md$/i, "");
  return `[[${escapeWiki(target)}#${escapeWiki(heading)}|${escapeWiki(alias)}]]`;
}

function escapeWiki(value: string): string {
  return value.replace(/([\\|\]])/g, "\\$1");
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]<>])/g, "\\$1");
}

function escapeBlockquote(value: string): string {
  return escapeMarkdown(value).replace(/\n/g, "\n> ");
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
