# QA-Toolbox

Chrome extension (Manifest V3) - a growing toolkit for QA engineers: record & auto-fill forms with multiple test accounts, generate test data with AI (Claude API), and inspect/restyle page elements.

## Features

- **Record & fill**: record form fields as you type, save them as profiles, and fill with one click
- **AI profile generator**: scans the form on the current page, generates realistic context-aware test data (Claude Haiku), fills the form instantly, and asks before saving
- **Element inspector**: DevTools-style element picker - view selector, attributes, and computed styles, and apply custom CSS to any element live
- Supports text inputs, selects, checkboxes, radio groups, custom comboboxes (`role="combobox"`), and rich text editors (CKEditor 5, Quill, TinyMCE inline, and more)
- Conditional fields: multi-pass fill catches fields that appear after earlier values are set
- Sequential/random choice cycling for selects, radios, and comboboxes on every fill
- Multiple profiles per page (max 5 per exact URL), sub-profiles, categories, import/export

## Setup

1. Clone the repo
2. Copy `config.example.js` to `config.js` and put your Anthropic API key in it:

   ```js
   apiKey: 'sk-ant-...'
   ```

   `config.js` is gitignored - the key never reaches the repository.
3. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select this folder.

## Files

| File | Role |
|---|---|
| `background.js` | Service worker: messaging hub, AI profile generation (Claude API), DB access |
| `content.js` | Recording, fill engine, floating button, AI save prompt |
| `db.js` | IndexedDB wrapper for profiles |
| `config.js` | API key + model (not committed - see `config.example.js`) |
| `popup.html/js` | Main popup UI |
| `editor.html/js` | Profile editor |
| `settings.html/js` | Settings, categories, import/export |
