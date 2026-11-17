# RightyMath

**RTL support for LaTeX math in Obsidian.** Write Hebrew, Arabic, Persian or any right-to-left language together with `$...$` formulas without the text jumping around.

## What it fixes
- **Direction per line, ignoring math.** `$f(x)$ היא פונקציה` is RTL. Plain `dir=auto` makes it LTR, because the first letter is the `f` inside the formula. Markdown syntax (`- [x]`, `> [!note]`, `#tags`, links, inline code) is ignored too.
- **Empty lines follow the paragraph,** so a new line under RTL text already starts on the right.
- **Formulas are LTR islands.** Raw `$...$` source and rendered math are both bidi isolates, so punctuation and words next to a formula stay where they belong. This also holds while you're still typing an unclosed `$`. Display math stays centered.
- **Live inline preview.** While the cursor is inside `$...$`, the rendered formula shows under the line (like Obsidian's `$$` preview), or as a floating popup.
- **Keyboard layout fix inside math.** If you forget to switch to English, keys typed inside a formula on a non-Latin layout (Hebrew, Arabic, Persian, Russian, Greek…) become the English character of the same key. `\text{...}` is left alone, so you can still write words in your language there. A `∑ math · EN` status-bar indicator shows when you're inside a formula.
- **RTL text inside `\text{...}`** keeps its natural order.
- **Reading view** gets the same per-block direction (paragraphs, lists, headings, tables, callouts).

Supported RTL scripts: Hebrew, Arabic (incl. Persian, Urdu), Syriac, Thaana, N'Ko, Samaritan, Mandaic.

## Commands (bind hotkeys in Settings → Hotkeys)
- Insert inline math (`$|$`, or wraps the selection)
- Insert display math block
- Force current line(s) RTL / LTR (inserts an invisible RLM/LRM mark after the list/heading marker)
- Clear forced direction
- Toggle per-line auto direction

## Install
- **With BRAT (beta):** install the [BRAT](https://obsidian.md/plugins?id=obsidian42-brat) plugin, choose "Add beta plugin", and enter `moskobosko/rightymath`.
- **Manually:** download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/moskobosko/rightymath/releases/latest) into `<vault>/.obsidian/plugins/rightymath/`, then enable **RightyMath** in Settings → Community plugins.

Requires Obsidian 1.15.1 or later.

Tip: leave Obsidian's global "Right-to-left (RTL)" editor setting **off**. RightyMath handles direction per line.

## Development
No build step: `main.js` is plain CommonJS. Run the logic tests with:

```
node test/run.js
```

## License
Released under the [MIT License](LICENSE). Free to use, modify and share, as long as the copyright notice is kept.
