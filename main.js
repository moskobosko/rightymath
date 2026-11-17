'use strict';
/*
 * RightyMath — RTL support for LaTeX math in Obsidian.
 * Makes writing Hebrew / Arabic / Persian (any RTL language) + LaTeX usable.
 *
 *  1. Per-line text direction in the editor, decided by the first strong
 *     character *outside* math / code / markdown syntax. A line like
 *     "$f(x)$ היא פונקציה רציפה" is RTL, not LTR.
 *  2. Every formula (source `$...$` and rendered MathJax) is an LTR bidi
 *     isolate, so punctuation and RTL words around it stop jumping.
 *  3. Reading view gets the same per-block direction logic.
 *  4. Keyboard fix: while the cursor is inside math, keys typed on a non-Latin
 *     layout (Hebrew, Arabic, Russian...) become the Latin character of the same physical
 *     key (ש→a, ץ→., mirrored brackets fixed...). No more Alt+Shift dance.
 *  5. Commands to insert math and to force a line's direction (via an
 *     invisible RLM/LRM mark, so it survives export and other apps).
 *
 * Plain CommonJS: Obsidian provides `obsidian` and `@codemirror/*` at runtime,
 * so no build step is needed.
 */

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, MarkdownView } = obsidian;
const { ViewPlugin, Decoration, EditorView, Direction, WidgetType, showTooltip } = require('@codemirror/view');
const { StateField } = require('@codemirror/state');

// ---------------------------------------------------------------------------
// Direction detection
// ---------------------------------------------------------------------------

const RTL_CLASS = '֐-׿؀-ۿ܀-ࣿיִ-﷿ﹰ-﻿‏';
const LTR_CLASS = 'A-Za-zÀ-ʯͰ-ϿЀ-ӿ‎';
const STRONG_RE = new RegExp(`[${RTL_CLASS}${LTR_CLASS}]`);
const RTL_ONE_RE = new RegExp(`[${RTL_CLASS}]`);
const LRM = '‎';
const RLM = '‏';

/** 'rtl' | 'ltr' | null (no strong characters) */
function firstStrongDir(str) {
  const m = STRONG_RE.exec(str);
  if (!m) return null;
  return RTL_ONE_RE.test(m[0]) ? 'rtl' : 'ltr';
}

// Markdown line prefix: indentation, blockquotes, heading, list marker, task box.
const LINE_PREFIX_RE = /^(\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+(?:\[.\]\s+)?|\d+[.)]\s+(?:\[.\]\s+)?)?)/;

/** Remove markdown syntax that contains Latin letters but is not "content". */
function cleanMarkdown(s) {
  return s
    .replace(LINE_PREFIX_RE, ' ')
    .replace(/%%.*?(%%|$)/g, ' ')                 // comments
    .replace(/\[![^\]]*\][+-]?/g, ' ')            // callout type: > [!note]
    .replace(/!\[\[[^\]]*\]\]/g, ' ')             // embeds ![[img.png]]
    .replace(/\[\[[^\]|]*\|/g, ' ')               // wikilink target when alias exists
    .replace(/\]\([^)]*\)/g, ' ')                 // markdown link url
    .replace(/!\[[^\]]*\]/g, ' ')                 // image alt
    .replace(/\[\^[^\]]*\]/g, ' ')                // footnote refs
    .replace(/`+[^`]*`+/g, ' ')                   // inline code
    .replace(/<[^>]+>/g, ' ')                     // html tags
    .replace(/\bhttps?:\/\/\S+/g, ' ')            // bare urls
    .replace(/(^|\s)#[^\s#]+/g, ' ');             // #tags
}

// ---------------------------------------------------------------------------
// Math / code scanner (mirrors Obsidian's rules closely enough)
// ---------------------------------------------------------------------------

/**
 * @returns {{math: {from:number,to:number,display:boolean}[],
 *            code: {from:number,to:number}[],
 *            fmEnd: number, openDisplayFrom: number}}
 */
function scanDoc(text) {
  const math = [];
  const code = [];
  const n = text.length;
  let fmEnd = -1;
  let openDisplayFrom = -1;
  let i = 0;

  // YAML frontmatter
  if (/^---\r?\n/.test(text)) {
    const re = /\n---[ \t]*(\r?\n|$)/g;
    re.lastIndex = 3;
    const m = re.exec(text);
    if (m) { fmEnd = m.index + m[0].length; i = fmEnd; }
  }

  const fenceRe = /[ \t>]*(`{3,}|~{3,})/y;
  let lineStart = true;
  let fence = null;
  let fenceFrom = 0;

  const lineEnd = (p) => { const e = text.indexOf('\n', p); return e < 0 ? n : e; };

  while (i < n) {
    if (lineStart) {
      lineStart = false;
      fenceRe.lastIndex = i;
      const m = fenceRe.exec(text);
      const le = lineEnd(i);
      if (fence) {
        if (m && m[1][0] === fence[0] && m[1].length >= fence.length &&
            /^\s*$/.test(text.slice(fenceRe.lastIndex, le))) {
          code.push({ from: fenceFrom, to: le });
          fence = null;
        }
        i = le + 1; lineStart = true; continue;
      }
      if (m) {
        fence = m[1]; fenceFrom = i;
        i = le + 1; lineStart = true; continue;
      }
    }

    const c = text[i];
    if (c === '\n') { lineStart = true; i++; continue; }
    if (c === '\\') { i += 2; continue; }

    if (c === '`') {
      let k = i; while (text[k] === '`') k++;
      const ticks = k - i;
      const close = findBacktickClose(text, k, ticks);
      i = close < 0 ? k : close + ticks;
      continue;
    }

    if (c === '$') {
      if (text[i + 1] === '$') {
        let end = i + 2;
        while (true) {
          end = text.indexOf('$$', end);
          if (end < 0 || text[end - 1] !== '\\') break;
          end += 1;
        }
        if (end < 0) { openDisplayFrom = i; i += 2; continue; }
        math.push({ from: i, to: end + 2, display: true });
        i = end + 2;
        continue;
      }
      const next = text[i + 1];
      if (next === undefined || /\s/.test(next)) { i++; continue; }
      let k = i + 1;
      let found = -1;
      while (k < n && text[k] !== '\n') {
        const ck = text[k];
        if (ck === '\\') { k += 2; continue; }
        if (ck === '$') {
          if (!/\s/.test(text[k - 1]) && !/[0-9]/.test(text[k + 1] || '')) { found = k; break; }
        }
        k++;
      }
      if (found < 0) { i++; continue; }
      math.push({ from: i, to: found + 1, display: false });
      i = found + 1;
      continue;
    }
    i++;
  }
  if (fence) code.push({ from: fenceFrom, to: n });
  return { math, code, fmEnd, openDisplayFrom };
}

function findBacktickClose(text, from, ticks) {
  let k = from;
  const n = text.length;
  while (k < n) {
    if (text[k] === '\n' && text[k + 1] === '\n') return -1; // paragraph break
    if (text[k] === '`') {
      let j = k; while (text[j] === '`') j++;
      if (j - k === ticks) return k;
      k = j; continue;
    }
    k++;
  }
  return -1;
}

/** Index of first range with to > pos (ranges sorted, disjoint). */
function firstAfter(ranges, pos) {
  let lo = 0, hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].to > pos) hi = mid; else lo = mid + 1;
  }
  return lo;
}

/**
 * Classify one line. Returns {dir, prop} or null when the line has no strong chars.
 * prop=false means "structural" line (code, display math, frontmatter): it must not
 * leak its LTR into following empty lines.
 */
const LTR_STRUCT = { dir: 'ltr', prop: false };
function classifyLine(lineFrom, lineText, info) {
  const lineTo = lineFrom + lineText.length;
  if (info.fmEnd > 0 && lineFrom < info.fmEnd) return LTR_STRUCT;
  const ci = firstAfter(info.code, lineFrom);
  if (ci < info.code.length && info.code[ci].from <= lineFrom) return LTR_STRUCT;

  let masked = lineText;
  let idx = firstAfter(info.math, lineFrom);
  const first = info.math[idx];
  if (first && first.display && first.from <= lineFrom && first.to >= lineTo) return LTR_STRUCT;
  if (idx < info.math.length && info.math[idx].from < lineTo) {
    const chars = lineText.split('');
    for (; idx < info.math.length && info.math[idx].from <= lineTo; idx++) {
      const r = info.math[idx];
      if (r.display && r.from <= lineFrom && r.to >= lineTo) return LTR_STRUCT;
      const a = Math.max(r.from, lineFrom) - lineFrom;
      const b = Math.min(r.to, lineTo) - lineFrom;
      for (let k = a; k < b; k++) chars[k] = ' ';
    }
    masked = chars.join('');
  }
  if (/^\s*\$\$\s*$/.test(lineText)) return LTR_STRUCT; // dangling $$ while typing
  const dir = firstStrongDir(cleanMarkdown(masked));
  return dir ? { dir, prop: true } : null;
}

/**
 * If `pos` is inside a formula (including one still being typed), the offset where
 * that formula's content starts (after `$` / `$$`); otherwise -1.
 */
function mathContentStart(info, doc, pos) {
  const idx = firstAfter(info.math, pos);
  const r = info.math[idx];
  if (r) {
    const d = r.display ? 2 : 1;
    if (pos >= r.from + d && pos <= r.to - d) return r.from + d;
  }
  if (info.openDisplayFrom >= 0 && pos >= info.openDisplayFrom + 2) return info.openDisplayFrom + 2;
  const p = pendingInlineMath(info, doc, pos);
  return p ? p.from + 1 : -1;
}

/** Is `pos` inside a formula (including one the user is still typing)? */
function isInMath(info, doc, pos) {
  return mathContentStart(info, doc, pos) >= 0;
}

/**
 * The inline formula the user is typing right now: an opening `$` on the cursor's
 * line that has no closing `$` yet. Returns {from, to} (to = end of line) or null.
 * Only counts when the rest of the line has no Hebrew/Arabic letters (auto-paired
 * `}` `)` `]` `$`, or the tail of a formula being edited, are fine), so a stray "$5"
 * in normal Hebrew text doesn't swallow the rest of the line.
 */
function pendingInlineMath(info, doc, pos) {
  const line = doc.lineAt(pos);
  const after = line.text.slice(pos - line.from);
  if (RTL_ONE_RE.test(after)) return null;
  const ci = firstAfter(info.code, pos);
  if (ci < info.code.length && info.code[ci].from <= pos) return null;
  const prefix = line.text.slice(0, pos - line.from);
  let openAt = -1, inCode = false;
  for (let i = 0; i < prefix.length; i++) {
    const c = prefix[i];
    if (c === '\\') { i++; continue; }
    if (c === '`' && openAt < 0) { inCode = !inCode; continue; }
    if (inCode || c !== '$') continue;
    if (prefix[i + 1] === '$') { i++; continue; }
    if (openAt < 0) {
      const nx = prefix[i + 1];
      if (nx === undefined || !/\s/.test(nx)) openAt = i;
    } else if (!/\s/.test(prefix[i - 1])) {
      openAt = -1;
    }
  }
  if (openAt < 0) return null;
  const from = line.from + openAt;
  // Already a real (closed) formula? Then nothing is pending.
  const r = info.math[firstAfter(info.math, from)];
  if (r && r.from <= from) return null;
  return { from, to: line.from + line.text.length };
}

/** info with the pending formula merged into the math list (sorted, non-overlapping). */
function withPending(info, pending) {
  if (!pending) return info;
  const math = info.math.filter((r) => r.to <= pending.from || r.from >= pending.to);
  const at = firstAfter(math, pending.from);
  math.splice(at, 0, { from: pending.from, to: pending.to, display: false, pending: true });
  return Object.assign({}, info, { math });
}

// ---------------------------------------------------------------------------
// Non-Latin keyboard → Latin, by physical key (US layout)
// ---------------------------------------------------------------------------

const US_KEYS = {
  Backquote: ['`', '~'], Minus: ['-', '_'], Equal: ['=', '+'],
  BracketLeft: ['[', '{'], BracketRight: [']', '}'], Backslash: ['\\', '|'],
  Semicolon: [';', ':'], Quote: ["'", '"'], Comma: [',', '<'], Period: ['.', '>'], Slash: ['/', '?'],
  Digit1: ['1', '!'], Digit2: ['2', '@'], Digit3: ['3', '#'], Digit4: ['4', '$'], Digit5: ['5', '%'],
  Digit6: ['6', '^'], Digit7: ['7', '&'], Digit8: ['8', '*'], Digit9: ['9', '('], Digit0: ['0', ')'],
};
for (let c = 65; c <= 90; c++) {
  const ch = String.fromCharCode(c);
  US_KEYS['Key' + ch] = [ch.toLowerCase(), ch];
}
/** A letter from a non-Latin script (Hebrew, Arabic, Persian, Cyrillic, Greek, Thai...). */
function isForeignLetter(ch) {
  return /\p{L}/u.test(ch) && !/\p{Script=Latin}/u.test(ch);
}

const TEXT_COMMANDS = new Set(['text', 'textrm', 'textit', 'textbf', 'textsf', 'texttt', 'textnormal', 'textup', 'mbox', 'hbox']);

/**
 * Given formula source from its start up to the cursor, is the cursor inside a
 * \text{...}-like group? There, the user writes prose in their own language.
 */
function cursorInTextGroup(src) {
  const stack = [];
  let pendingText = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      let j = i + 1;
      while (j < src.length && /[a-zA-Z]/.test(src[j])) j++;
      if (j === i + 1) j++; // escaped symbol: \{ \$ \\ ...
      pendingText = TEXT_COMMANDS.has(src.slice(i + 1, j));
      i = j - 1;
      continue;
    }
    if (c === '{') {
      stack.push(pendingText || (stack.length > 0 && stack[stack.length - 1]));
      pendingText = false;
    } else if (c === '}') {
      stack.pop();
      pendingText = false;
    } else if (!/\s/.test(c)) {
      pendingText = false;
    }
  }
  return stack.length > 0 && stack[stack.length - 1];
}

// ---------------------------------------------------------------------------
// Reading view
// ---------------------------------------------------------------------------

const SKIP_SEL = '.math, code, pre, ul, ol, .tag, .list-bullet, .collapse-indicator, input, ' +
  '.footnote-ref, sup, svg, .callout-icon, .internal-embed, mjx-container';

function elementText(el) {
  let out = '';
  const walk = (node) => {
    for (const ch of node.childNodes) {
      if (ch.nodeType === 3) out += ch.nodeValue;
      else if (ch.nodeType === 1) {
        if (ch.matches(SKIP_SEL)) { out += ' '; continue; }
        walk(ch);
      }
      if (STRONG_RE.test(out)) return;
    }
  };
  walk(el);
  return out;
}

function fixRendered(el, fallback) {
  el.querySelectorAll('.math, mjx-container').forEach((m) => m.setAttribute('dir', 'ltr'));
  el.querySelectorAll('code, pre').forEach((m) => m.setAttribute('dir', 'ltr'));

  el.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, dt, dd, .callout-title-inner, figcaption')
    .forEach((b) => {
      if (b.closest('pre')) return;
      b.setAttribute('dir', firstStrongDir(elementText(b)) || fallback);
    });
  el.querySelectorAll('td, th').forEach((b) => {
    const d = firstStrongDir(elementText(b));
    if (d) b.setAttribute('dir', d);
  });
  el.querySelectorAll('ul, ol').forEach((list) => {
    const li = list.querySelector(':scope > li[dir]');
    if (li) list.setAttribute('dir', li.getAttribute('dir'));
  });
  el.querySelectorAll('table').forEach((t) => {
    const cell = t.querySelector('th[dir], td[dir]');
    if (cell) t.setAttribute('dir', cell.getAttribute('dir'));
  });
  el.querySelectorAll('blockquote, .callout').forEach((q) => {
    const first = q.querySelector('[dir]:not(.math):not(code):not(pre)');
    if (first) q.setAttribute('dir', first.getAttribute('dir'));
  });
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  editorAutoDirection: true,
  readingAutoDirection: true,
  isolateMathInEditor: true,
  fallbackDirection: 'rtl',
  keyboardFix: true,
  statusBarIndicator: true,
  inlinePreview: 'below', // 'below' | 'popup' | 'off'
};

// Live settings object, shared with state fields (set in onload).
let SETTINGS = Object.assign({}, DEFAULT_SETTINGS);

const mathField = StateField.define({
  create: (state) => scanDoc(state.doc.toString()),
  update: (val, tr) => (tr.docChanged ? scanDoc(tr.newDoc.toString()) : val),
});

// ---------------------------------------------------------------------------
// Live preview for inline $...$ (like Obsidian's preview under $$ blocks)
// ---------------------------------------------------------------------------

/** The inline formula the cursor is in (closed or still being typed), or null. */
function currentInlineFormula(info, doc, sel) {
  if (!sel.empty) return null;
  const pos = sel.head;
  const idx = firstAfter(info.math, pos);
  for (const r of [info.math[idx], info.math[idx - 1]]) {
    if (r && !r.display && pos >= r.from && pos <= r.to) {
      return { from: r.from, to: r.to, src: doc.sliceString(r.from + 1, r.to - 1) };
    }
  }
  const p = pendingInlineMath(info, doc, pos);
  if (p) return { from: p.from, to: p.to, src: doc.sliceString(p.from + 1, p.to).replace(/\$\s*$/, '') };
  return null;
}

function renderMathInto(el, src) {
  el.empty ? el.empty() : (el.textContent = '');
  try {
    el.appendChild(obsidian.renderMath(src, false));
    obsidian.finishRenderMath();
  } catch (e) {
    el.textContent = src;
  }
}

function makePreviewDom(src, cls) {
  const el = createDiv({ cls: 'rym-inline-preview ' + cls, attr: { dir: 'ltr', contenteditable: 'false' } });
  renderMathInto(el, src);
  return el;
}

class MathPreviewWidget extends WidgetType {
  constructor(src) { super(); this.src = src; }
  eq(other) { return other.src === this.src; }
  toDOM() { return makePreviewDom(this.src, 'rym-below'); }
  updateDOM(dom) { renderMathInto(dom, this.src); return true; } // re-render in place, no flicker
  ignoreEvent() { return false; }
}

const EMPTY_PREVIEW = { deco: Decoration.none, tooltip: null, src: null, pos: -1 };

function computePreview(state, prev) {
  const mode = SETTINGS.inlinePreview;
  if (mode === 'off') return EMPTY_PREVIEW;
  const f = currentInlineFormula(state.field(mathField), state.doc, state.selection.main);
  if (!f || !f.src.trim()) return EMPTY_PREVIEW;

  if (mode === 'popup') {
    if (prev && prev.tooltip && prev.src === f.src && prev.pos === f.from) return prev;
    const src = f.src;
    return {
      deco: Decoration.none, src, pos: f.from,
      tooltip: {
        pos: f.from,
        above: false,
        create: () => {
          const dom = makePreviewDom(src, 'rym-popup');
          // Style the tooltip wrapper by class (avoids a :has() selector in CSS).
          return { dom, mount: () => { if (dom.parentElement) dom.parentElement.classList.add('rym-tooltip'); } };
        },
      },
    };
  }
  const lineEnd = state.doc.lineAt(f.to).to;
  return {
    deco: Decoration.set([Decoration.widget({ widget: new MathPreviewWidget(f.src), block: true, side: 1 }).range(lineEnd)]),
    tooltip: null, src: f.src, pos: f.from,
  };
}

// Created per editor-extension build, so a settings change (which rebuilds the
// extension) starts it fresh with the new settings.
function makePreviewField() {
  return StateField.define({
    create: (state) => computePreview(state, null),
    update: (val, tr) => ((tr.docChanged || tr.selection) ? computePreview(tr.state, val) : val),
    provide: (f) => [
      EditorView.decorations.from(f, (v) => v.deco),
      showTooltip.from(f, (v) => v.tooltip),
    ],
  });
}

const LINE_RTL = Decoration.line({ attributes: { dir: 'rtl' }, class: 'rym-rtl' });
const LINE_LTR = Decoration.line({ attributes: { dir: 'ltr' }, class: 'rym-ltr' });
const MATH_MARK = Decoration.mark(Object.assign(
  { class: 'rym-math-src', attributes: { dir: 'ltr' } },
  Direction ? { bidiIsolate: Direction.LTR } : {}
));

class RightyMathPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (this.settings.hebrewKeyboardFix === false) this.settings.keyboardFix = false;
    delete this.settings.hebrewKeyboardFix;
    SETTINGS = this.settings;
    this.foreignLayout = false;
    if (obsidian.loadMathJax) obsidian.loadMathJax().catch(() => {});

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('rym-status');
    this.statusEl.setAttribute('aria-label', 'Cursor is inside math (non-English keys are converted to English)');
    this.setStatus(false);

    // Kept as one array so settings changes can swap its content (see refreshAll).
    this.editorExtension = [this.buildEditorExtension()];
    this.registerEditorExtension(this.editorExtension);

    this.registerMarkdownPostProcessor((el) => {
      if (this.settings.readingAutoDirection) fixRendered(el, this.settings.fallbackDirection);
    });

    this.addCommands();
    this.addSettingTab(new RightyMathSettingTab(this.app, this));
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshAll();
  }

  refreshAll() {
    // Rebuild the editor extension in place and let Obsidian reconfigure all editors.
    this.editorExtension.length = 0;
    this.editorExtension.push(this.buildEditorExtension());
    this.app.workspace.updateOptions();
    this.app.workspace.iterateAllLeaves((leaf) => {
      const v = leaf.view;
      if (v instanceof MarkdownView && v.previewMode) v.previewMode.rerender(true);
    });
    if (!this.settings.statusBarIndicator) this.setStatus(false);
  }

  setStatus(inMath) {
    if (!this.statusEl) return;
    const show = inMath && this.settings.statusBarIndicator;
    this.statusEl.setText(show ? '∑ math · EN' : '');
    this.statusEl.toggleClass('rym-hidden', !show);
  }

  buildEditorExtension() {
    const plugin = this;

    const vp = ViewPlugin.fromClass(class {
      constructor(view) {
        this.decorations = Decoration.none;
        this.isolates = Decoration.none;
        this.pending = this.computePending(view.state);
        this.build(view);
      }

      computePending(state) {
        const sel = state.selection.main;
        if (!sel.empty) return null;
        return pendingInlineMath(state.field(mathField), state.doc, sel.head);
      }

      update(u) {
        let pendingChanged = false;
        if (u.docChanged || u.selectionSet) {
          const p = this.computePending(u.state);
          const old = this.pending;
          pendingChanged = !p !== !old || (p && (p.from !== old.from || p.to !== old.to));
          this.pending = p;
        }
        if (u.docChanged || u.viewportChanged || pendingChanged) this.build(u.view);
        if (u.selectionSet || u.docChanged || u.focusChanged) {
          if (u.view.hasFocus) {
            const st = u.view.state;
            plugin.setStatus(isInMath(st.field(mathField), st.doc, st.selection.main.head));
          } else if (u.focusChanged) {
            plugin.setStatus(false);
          }
        }
      }

      build(view) {
        const s = plugin.settings;
        const state = view.state;
        const doc = state.doc;
        const info = withPending(state.field(mathField), this.pending);
        const decos = [];
        const iso = [];

        if (s.isolateMathInEditor) {
          for (const { from, to } of view.visibleRanges) {
            for (let i = firstAfter(info.math, from); i < info.math.length && info.math[i].from < to; i++) {
              const r = info.math[i];
              // Kept separate from line decorations: they must be drawn as *outer*
              // decorations so one isolate wraps all of Obsidian's syntax spans.
              iso.push(MATH_MARK.range(r.from, r.to));
            }
          }
        }

        if (s.editorAutoDirection) {
          let lastLine = 0;
          for (const { from, to } of view.visibleRanges) {
            const startLine = Math.max(doc.lineAt(from).number, lastLine + 1);
            const endLine = doc.lineAt(to).number;
            if (startLine > endLine) continue;

            // Neutral lines inherit the direction of the nearest prose line above.
            let prev = null;
            for (let n = startLine - 1; n >= Math.max(1, startLine - 80); n--) {
              const l = doc.line(n);
              const c = classifyLine(l.from, l.text, info);
              if (c) { if (c.prop) prev = c.dir; break; }
            }

            for (let n = startLine; n <= endLine; n++) {
              const l = doc.line(n);
              const c = classifyLine(l.from, l.text, info);
              let dir;
              if (c) { dir = c.dir; prev = c.prop ? c.dir : null; }
              else dir = prev || s.fallbackDirection;
              decos.push((dir === 'rtl' ? LINE_RTL : LINE_LTR).range(l.from));
            }
            lastLine = endLine;
          }
        }

        this.decorations = Decoration.set(decos, true);
        this.isolates = Decoration.set(iso, true);
      }
    }, { decorations: (v) => v.decorations });

    const exts = [
      mathField,
      makePreviewField(),
      vp,
      EditorView.domEventHandlers({ keydown: (e, view) => plugin.handleKeydown(e, view) }),
    ];
    if (EditorView.perLineTextDirection) exts.push(EditorView.perLineTextDirection.of(true));
    const isolatesOf = (view) => {
      const p = view.plugin(vp);
      return p ? p.isolates : Decoration.none;
    };
    // Outer decorations wrap around syntax-highlighting spans instead of being split
    // by them. Without this, a closed $...$ (which Obsidian tokenizes into $, \cmd, =, 5...)
    // becomes several tiny isolates that an RTL line lays out in reverse order.
    exts.push((EditorView.outerDecorations || EditorView.decorations).of(isolatesOf));
    if (EditorView.bidiIsolatedRanges) exts.push(EditorView.bidiIsolatedRanges.of(isolatesOf));
    return exts;
  }

  handleKeydown(e, view) {
    if (!this.settings.keyboardFix) return false;
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || !e.key || e.key.length !== 1) return false;

    // Track whether a non-Latin layout (Hebrew, Arabic, Persian, Russian, Greek...) is
    // active, so punctuation keys can be fixed too. Shift+letter on Hebrew gives Latin
    // capitals, so only an unshifted Latin letter means "switched back to English".
    const isForeign = isForeignLetter(e.key);
    if (e.code && e.code.startsWith('Key')) {
      if (isForeign) this.foreignLayout = true;
      else if (!e.shiftKey && /[a-zA-Z]/.test(e.key)) this.foreignLayout = false;
    }

    const map = US_KEYS[e.code];
    if (!map) return false;
    let want = e.shiftKey ? map[1] : map[0];
    if (e.code.startsWith('Key') && e.getModifierState && e.getModifierState('CapsLock')) {
      want = e.shiftKey ? map[0] : map[1];
    }
    if (e.key === want) return false;
    if (!isForeign && !this.foreignLayout) return false;

    const state = view.state;
    const pos = state.selection.main.head;
    const start = mathContentStart(state.field(mathField), state.doc, pos);
    if (start < 0) return false;
    // Inside \text{...} the user writes in their own language: leave it alone.
    if (cursorInTextGroup(state.doc.sliceString(start, pos))) return false;

    view.dispatch(state.replaceSelection(want), { scrollIntoView: true, userEvent: 'input.type' });
    e.preventDefault();
    return true;
  }

  addCommands() {
    this.addCommand({
      id: 'insert-inline-math',
      name: 'Insert inline math ($...$)',
      editorCallback: (editor) => {
        const sel = editor.getSelection();
        if (sel) { editor.replaceSelection(`$${sel}$`); return; }
        const cur = editor.getCursor();
        editor.replaceRange('$$', cur);
        editor.setCursor({ line: cur.line, ch: cur.ch + 1 });
      },
    });

    this.addCommand({
      id: 'insert-display-math',
      name: 'Insert display math block ($$...$$)',
      editorCallback: (editor) => {
        const sel = editor.getSelection();
        const cur = editor.getCursor('from');
        const lineText = editor.getLine(cur.line);
        const pre = cur.ch > 0 && lineText.trim() ? '\n' : '';
        editor.replaceSelection(`${pre}$$\n${sel}\n$$\n`);
        editor.setCursor({ line: cur.line + (pre ? 2 : 1), ch: sel.length });
      },
    });

    const setLineDir = (editor, mark) => {
      const from = editor.getCursor('from').line;
      const to = editor.getCursor('to').line;
      for (let line = from; line <= to; line++) {
        const text = editor.getLine(line);
        const prefix = LINE_PREFIX_RE.exec(text)[1];
        const rest = text.slice(prefix.length).replace(/^[‎‏]+/, '');
        const next = prefix + mark + rest;
        if (next !== text) editor.replaceRange(next, { line, ch: 0 }, { line, ch: text.length });
      }
    };
    this.addCommand({ id: 'force-line-rtl', name: 'Force current line(s) RTL', editorCallback: (ed) => setLineDir(ed, RLM) });
    this.addCommand({ id: 'force-line-ltr', name: 'Force current line(s) LTR', editorCallback: (ed) => setLineDir(ed, LRM) });
    this.addCommand({ id: 'clear-line-direction', name: 'Clear forced direction on current line(s)', editorCallback: (ed) => setLineDir(ed, '') });

    this.addCommand({
      id: 'toggle-editor-auto-direction',
      name: 'Toggle per-line auto direction in editor',
      callback: async () => {
        this.settings.editorAutoDirection = !this.settings.editorAutoDirection;
        await this.saveSettings();
      },
    });
  }
}

class RightyMathSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    const toggle = (name, desc, key) => new Setting(containerEl).setName(name).setDesc(desc)
      .addToggle((t) => t.setValue(s[key]).onChange(async (v) => { s[key] = v; await this.plugin.saveSettings(); }));

    toggle('Per-line direction in editor',
      'Each line is RTL or LTR by its first letter (Hebrew, Arabic, English...), ignoring math, code and markdown syntax.',
      'editorAutoDirection');
    toggle('Per-block direction in reading view',
      'Same logic for paragraphs, list items, headings, tables and callouts in reading view.',
      'readingAutoDirection');
    toggle('Isolate math source as LTR',
      'Keeps the raw $...$ text left-to-right and stops it from scrambling the surrounding RTL text.',
      'isolateMathInEditor');

    new Setting(containerEl)
      .setName('Direction for lines without letters')
      .setDesc('Used for empty lines or lines with only math/numbers when there is no prose line above to inherit from.')
      .addDropdown((d) => d.addOption('rtl', 'Right-to-left').addOption('ltr', 'Left-to-right')
        .setValue(s.fallbackDirection)
        .onChange(async (v) => { s.fallbackDirection = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Live preview for inline math')
      .setDesc('While the cursor is inside $...$, show the rendered formula — under the line (like $$ blocks) or as a floating popup.')
      .addDropdown((d) => d.addOption('below', 'Under the line').addOption('popup', 'Floating popup').addOption('off', 'Off')
        .setValue(s.inlinePreview)
        .onChange(async (v) => { s.inlinePreview = v; await this.plugin.saveSettings(); }));

    toggle('Fix keyboard layout inside math',
      'While the cursor is inside $...$, keys typed on a non-English layout (Hebrew, Arabic, Persian, Russian...) insert the English character of the same key. \\text{...} is left alone so you can write words in your language there.',
      'keyboardFix');
    toggle('Math indicator in status bar',
      'Shows "∑ math · EN" while the cursor is inside a formula.',
      'statusBarIndicator');
  }
}


module.exports = RightyMathPlugin;
