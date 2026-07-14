# Contextual Vocabulary

Contextual Vocabulary turns a highlighted word into a permanent, navigable vocabulary entry. It reviews the sentence containing the selection, generates a contextual definition and usage review, links the selected text to its dictionary entry, and maintains an alphabetical quick index.

## Installation

### Community Plugins

After the plugin is accepted into the Obsidian Community Plugins directory:

1. Open **Settings → Community plugins → Browse**.
2. Search for **Contextual Vocabulary**.
3. Select **Install**, then **Enable**.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/0utsights/obsidian-contextual-vocabulary/releases/latest).
2. Create `<vault>/.obsidian/plugins/contextual-vocabulary/`.
3. Put all three downloaded files in that folder.
4. Reload Obsidian and enable **Contextual Vocabulary** under **Settings → Community plugins**.

The repository URL can also be installed as a beta using [BRAT](https://github.com/TfTHacker/obsidian42-brat).

## Setup

1. Open **Settings → Community plugins** and enable **Contextual Vocabulary**.
2. Open **Settings → Contextual Vocabulary**.
3. Enter an API key, endpoint, model, and the vault-relative path of your dictionary note.
4. Open **Settings → Hotkeys**, search for **Define selected vocabulary word**, and assign your preferred shortcut. **Ctrl/Cmd+Shift+D** is a convenient choice.
5. Highlight a vocabulary word in a Markdown note and use your assigned shortcut.

The command can also be run directly from Obsidian's command palette.

## What it does

- Finds the sentence containing the selected word.
- Asks an OpenAI-compatible chat-completions endpoint for a contextual definition and usage review.
- Creates the configured dictionary note and missing folders when necessary.
- Adds entries alphabetically and rebuilds a compact A–Z quick index.
- Replaces the highlighted occurrence with a direct Obsidian link to the word's dictionary heading.
- Reuses an existing managed entry instead of adding a duplicate.

The plugin-managed index and entries are surrounded by HTML comment markers. You can add your own content outside those markers without it being rewritten.

## Privacy

This plugin requires an account and API key from OpenAI or another provider offering an OpenAI-compatible chat-completions endpoint. Provider usage fees may apply; this plugin does not collect payment.

When you invoke the command, the highlighted term and its containing sentence are sent to the endpoint you configured. The API key is stored locally by Obsidian in this plugin's `data.json` file and is never written into a note. Review your chosen provider's privacy and data-retention policies before use.

Contextual Vocabulary contains no telemetry, analytics, advertisements, or background network activity. It makes a network request only when you explicitly run the vocabulary command for a term that is not already in the managed dictionary.

## Development

```bash
npm install
npm run build
```

The production build outputs `main.js` in the repository root.

## License

[MIT](LICENSE)
