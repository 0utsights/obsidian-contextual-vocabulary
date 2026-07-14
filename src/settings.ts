import { App, PluginSettingTab, Setting } from "obsidian";
import type ContextualVocabularyPlugin from "./main";

export interface ContextualVocabularySettings {
  apiKey: string;
  apiEndpoint: string;
  model: string;
  dictionaryPath: string;
}

export const DEFAULT_SETTINGS: ContextualVocabularySettings = {
  apiKey: "",
  apiEndpoint: "https://api.openai.com/v1/chat/completions",
  model: "gpt-4.1-mini",
  dictionaryPath: "Dictionary.md",
};

export class ContextualVocabularySettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ContextualVocabularyPlugin) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("AI connection")
      .setHeading();

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Stored locally in this vault's plugin data. It is sent only to the endpoint below.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-…")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Chat completions endpoint")
      .setDesc("OpenAI or another service with an OpenAI-compatible /chat/completions API.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.apiEndpoint)
          .setValue(this.plugin.settings.apiEndpoint)
          .onChange(async (value) => {
            this.plugin.settings.apiEndpoint = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Model")
      .setDesc("The model name accepted by your endpoint.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.model)
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Dictionary")
      .setHeading();

    new Setting(containerEl)
      .setName("Dictionary note")
      .setDesc("Vault-relative Markdown path. Missing folders and the note are created automatically.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.dictionaryPath)
          .setValue(this.plugin.settings.dictionaryPath)
          .onChange(async (value) => {
            this.plugin.settings.dictionaryPath = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Keyboard shortcut")
      .setDesc("Assign one in Settings → Hotkeys by searching for “Define selected vocabulary word”. Suggested: Ctrl/Cmd + Shift + D.");
  }
}
