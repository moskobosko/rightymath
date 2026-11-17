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
  latexAutocomplete: true,
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

// ---------------------------------------------------------------------------
// LaTeX command autocomplete (inside math only)
// ---------------------------------------------------------------------------

/*
 * One command per line:  name ;; insert ;; preview ;; description ;; keywords
 *  - insert:  text that replaces "\query"; "@" marks where the cursor goes.
 *             Empty = "\name".
 *  - preview: what is rendered in the popup. Empty = the insert text (without "@").
 *  - keywords: extra words you can type to find it (e.g. "\box" finds \square).
 * Every entry is checked against MathJax 4 with Obsidian's packages (test/latex.mjs).
 */
const LATEX_COMMANDS_SRC = String.raw`
frac ;; \frac{@}{} ;; \frac{a}{b} ;; Fraction ;; divide over
dfrac ;; \dfrac{@}{} ;; \dfrac{a}{b} ;; Display-size fraction ;; fraction
tfrac ;; \tfrac{@}{} ;; \tfrac{a}{b} ;; Text-size fraction ;; fraction
sqrt ;; \sqrt{@} ;; \sqrt{x} ;; Square root ;; root radical
sqrt ;; \sqrt[@]{} ;; \sqrt[n]{x} ;; n-th root ;; root radical nth
binom ;; \binom{@}{} ;; \binom{n}{k} ;; Binomial coefficient ;; choose combination
sum ;; \sum_{@}^{} ;; \sum_{i=1}^{n} ;; Sum with limits ;; sigma series
sum ;; \sum ;; \sum ;; Sum ;; sigma series
prod ;; \prod_{@}^{} ;; \prod_{i=1}^{n} ;; Product with limits ;; pi
coprod ;; \coprod ;; \coprod ;; Coproduct ;;
int ;; \int_{@}^{} ;; \int_{a}^{b} ;; Integral with limits ;; integral
int ;; \int ;; \int ;; Integral ;; integral
iint ;; \iint ;; \iint ;; Double integral ;; integral
iiint ;; \iiint ;; \iiint ;; Triple integral ;; integral
oint ;; \oint ;; \oint ;; Contour integral ;; integral closed
lim ;; \lim_{@ \to } ;; \lim_{x \to \infty} ;; Limit ;; limit
limsup ;; \limsup_{@} ;; \limsup_{n} ;; Limit superior ;; limit
liminf ;; \liminf_{@} ;; \liminf_{n} ;; Limit inferior ;; limit
sup ;; \sup ;; \sup ;; Supremum ;;
inf ;; \inf ;; \inf ;; Infimum ;;
max ;; \max ;; \max ;; Maximum ;;
min ;; \min ;; \min ;; Minimum ;;
bigcup ;; \bigcup_{@} ;; \bigcup_{i} ;; Big union ;; union
bigcap ;; \bigcap_{@} ;; \bigcap_{i} ;; Big intersection ;; intersection
bigoplus ;; \bigoplus ;; \bigoplus ;; Big direct sum ;;
bigotimes ;; \bigotimes ;; \bigotimes ;; Big tensor product ;;
infty ;; \infty ;; \infty ;; Infinity ;; infinity
partial ;; \partial ;; \partial ;; Partial derivative ;; derivative
nabla ;; \nabla ;; \nabla ;; Nabla / gradient ;; gradient del
blacksquare ;; \blacksquare ;; \blacksquare ;; Filled square (end of proof) ;; qed proof box
square ;; \square ;; \square ;; Empty square ;; box qed
Box ;; \Box ;; \Box ;; Box ;; square qed
qed ;; \blacksquare ;; \blacksquare ;; End of proof ∎ ;; proof box square
therefore ;; \therefore ;; \therefore ;; Therefore ∴ ;; so
because ;; \because ;; \because ;; Because ∵ ;;
checkmark ;; \checkmark ;; \checkmark ;; Check mark ;; tick
alpha ;; \alpha ;; \alpha ;; Greek alpha ;; greek
beta ;; \beta ;; \beta ;; Greek beta ;; greek
gamma ;; \gamma ;; \gamma ;; Greek gamma ;; greek
Gamma ;; \Gamma ;; \Gamma ;; Greek capital Gamma ;; greek
delta ;; \delta ;; \delta ;; Greek delta ;; greek
Delta ;; \Delta ;; \Delta ;; Greek capital Delta ;; greek
epsilon ;; \epsilon ;; \epsilon ;; Greek epsilon ;; greek
varepsilon ;; \varepsilon ;; \varepsilon ;; Greek epsilon (variant) ;; greek epsilon
zeta ;; \zeta ;; \zeta ;; Greek zeta ;; greek
eta ;; \eta ;; \eta ;; Greek eta ;; greek
theta ;; \theta ;; \theta ;; Greek theta ;; greek
vartheta ;; \vartheta ;; \vartheta ;; Greek theta (variant) ;; greek theta
Theta ;; \Theta ;; \Theta ;; Greek capital Theta ;; greek
iota ;; \iota ;; \iota ;; Greek iota ;; greek
kappa ;; \kappa ;; \kappa ;; Greek kappa ;; greek
lambda ;; \lambda ;; \lambda ;; Greek lambda ;; greek
Lambda ;; \Lambda ;; \Lambda ;; Greek capital Lambda ;; greek
mu ;; \mu ;; \mu ;; Greek mu ;; greek
nu ;; \nu ;; \nu ;; Greek nu ;; greek
xi ;; \xi ;; \xi ;; Greek xi ;; greek
Xi ;; \Xi ;; \Xi ;; Greek capital Xi ;; greek
pi ;; \pi ;; \pi ;; Greek pi ;; greek
Pi ;; \Pi ;; \Pi ;; Greek capital Pi ;; greek
rho ;; \rho ;; \rho ;; Greek rho ;; greek
varrho ;; \varrho ;; \varrho ;; Greek rho (variant) ;; greek rho
sigma ;; \sigma ;; \sigma ;; Greek sigma ;; greek
Sigma ;; \Sigma ;; \Sigma ;; Greek capital Sigma ;; greek
tau ;; \tau ;; \tau ;; Greek tau ;; greek
upsilon ;; \upsilon ;; \upsilon ;; Greek upsilon ;; greek
phi ;; \phi ;; \phi ;; Greek phi ;; greek
varphi ;; \varphi ;; \varphi ;; Greek phi (variant) ;; greek phi
Phi ;; \Phi ;; \Phi ;; Greek capital Phi ;; greek
chi ;; \chi ;; \chi ;; Greek chi ;; greek
psi ;; \psi ;; \psi ;; Greek psi ;; greek
Psi ;; \Psi ;; \Psi ;; Greek capital Psi ;; greek
omega ;; \omega ;; \omega ;; Greek omega ;; greek
Omega ;; \Omega ;; \Omega ;; Greek capital Omega ;; greek
aleph ;; \aleph ;; \aleph ;; Aleph (cardinality) ;; hebrew cardinal
hbar ;; \hbar ;; \hbar ;; Reduced Planck constant ;; planck
ell ;; \ell ;; \ell ;; Script l ;;
Re ;; \Re ;; \Re ;; Real part ;; real
Im ;; \Im ;; \Im ;; Imaginary part ;; imaginary
cdot ;; \cdot ;; a \cdot b ;; Centered dot (multiply) ;; times multiply dot
times ;; \times ;; a \times b ;; Times / cross product ;; multiply cross
div ;; \div ;; a \div b ;; Division sign ;; divide
pm ;; \pm ;; \pm ;; Plus-minus ;; plusminus
mp ;; \mp ;; \mp ;; Minus-plus ;;
ast ;; \ast ;; \ast ;; Asterisk ;; star
star ;; \star ;; \star ;; Star ;;
circ ;; \circ ;; f \circ g ;; Composition ;; compose ring
bullet ;; \bullet ;; \bullet ;; Bullet ;; dot
oplus ;; \oplus ;; \oplus ;; Direct sum ;; xor
otimes ;; \otimes ;; \otimes ;; Tensor product ;;
odot ;; \odot ;; \odot ;; Circled dot ;;
cup ;; \cup ;; A \cup B ;; Union ;; union or
cap ;; \cap ;; A \cap B ;; Intersection ;; intersection and
setminus ;; \setminus ;; A \setminus B ;; Set difference ;; minus difference
wedge ;; \wedge ;; \wedge ;; Logical and ;; and land
vee ;; \vee ;; \vee ;; Logical or ;; or lor
land ;; \land ;; \land ;; Logical and ;; and wedge
lor ;; \lor ;; \lor ;; Logical or ;; or vee
neg ;; \neg ;; \neg ;; Logical not ;; not lnot
lnot ;; \lnot ;; \lnot ;; Logical not ;; not neg
leq ;; \leq ;; \leq ;; Less than or equal ;; le smaller
geq ;; \geq ;; \geq ;; Greater than or equal ;; ge bigger
le ;; \le ;; \le ;; Less than or equal ;; leq
ge ;; \ge ;; \ge ;; Greater than or equal ;; geq
neq ;; \neq ;; \neq ;; Not equal ;; ne different
ne ;; \ne ;; \ne ;; Not equal ;; neq
approx ;; \approx ;; \approx ;; Approximately ;; about
equiv ;; \equiv ;; \equiv ;; Equivalent / congruent ;; identical
sim ;; \sim ;; \sim ;; Similar / distributed as ;; tilde
simeq ;; \simeq ;; \simeq ;; Asymptotically equal ;;
cong ;; \cong ;; \cong ;; Congruent / isomorphic ;; isomorphic
propto ;; \propto ;; \propto ;; Proportional to ;; proportional
ll ;; \ll ;; \ll ;; Much less than ;;
gg ;; \gg ;; \gg ;; Much greater than ;;
coloneqq ;; \coloneqq ;; \coloneqq ;; Defined as := ;; define assign
triangleq ;; \triangleq ;; \triangleq ;; Defined as (triangle) ;; define
in ;; \in ;; x \in A ;; Element of ;; belongs member
notin ;; \notin ;; x \notin A ;; Not an element of ;; not member
ni ;; \ni ;; \ni ;; Contains as element ;; owns
subset ;; \subset ;; \subset ;; Subset ;; contained
subseteq ;; \subseteq ;; \subseteq ;; Subset or equal ;; contained
subsetneq ;; \subsetneq ;; \subsetneq ;; Proper subset ;; strict contained
supset ;; \supset ;; \supset ;; Superset ;; contains
supseteq ;; \supseteq ;; \supseteq ;; Superset or equal ;; contains
emptyset ;; \emptyset ;; \emptyset ;; Empty set ;; empty null
varnothing ;; \varnothing ;; \varnothing ;; Empty set (round) ;; empty null emptyset
forall ;; \forall ;; \forall ;; For all ;; every any
exists ;; \exists ;; \exists ;; There exists ;; some
nexists ;; \nexists ;; \nexists ;; There does not exist ;; exists not
mid ;; \mid ;; a \mid b ;; Divides / such that ;; divides bar
nmid ;; \nmid ;; a \nmid b ;; Does not divide ;; divides
perp ;; \perp ;; \perp ;; Perpendicular ;; orthogonal
parallel ;; \parallel ;; \parallel ;; Parallel ;;
angle ;; \angle ;; \angle ;; Angle ;;
triangle ;; \triangle ;; \triangle ;; Triangle ;;
degree ;; \degree ;; 90\degree ;; Degree sign ° ;; deg angle
models ;; \models ;; \models ;; Models / entails ;; entails
vdash ;; \vdash ;; \vdash ;; Proves ;; turnstile
top ;; \top ;; \top ;; Top / true ;; true
bot ;; \bot ;; \bot ;; Bottom / false ;; false
to ;; \to ;; \to ;; Right arrow (maps to) ;; arrow right
rightarrow ;; \rightarrow ;; \rightarrow ;; Right arrow ;; arrow to
leftarrow ;; \leftarrow ;; \leftarrow ;; Left arrow ;; arrow gets
leftrightarrow ;; \leftrightarrow ;; \leftrightarrow ;; Left-right arrow ;; arrow
Rightarrow ;; \Rightarrow ;; \Rightarrow ;; Implies (double arrow) ;; arrow implies
Leftarrow ;; \Leftarrow ;; \Leftarrow ;; Implied by (double arrow) ;; arrow
Leftrightarrow ;; \Leftrightarrow ;; \Leftrightarrow ;; If and only if (double arrow) ;; arrow iff
implies ;; \implies ;; \implies ;; Implies ⟹ ;; arrow then
impliedby ;; \impliedby ;; \impliedby ;; Implied by ⟸ ;; arrow
iff ;; \iff ;; \iff ;; If and only if ⟺ ;; arrow equivalent
mapsto ;; \mapsto ;; x \mapsto y ;; Maps to ;; arrow function
longrightarrow ;; \longrightarrow ;; \longrightarrow ;; Long right arrow ;; arrow
longmapsto ;; \longmapsto ;; \longmapsto ;; Long maps to ;; arrow
hookrightarrow ;; \hookrightarrow ;; \hookrightarrow ;; Injection arrow ;; arrow injective
twoheadrightarrow ;; \twoheadrightarrow ;; \twoheadrightarrow ;; Surjection arrow ;; arrow surjective onto
uparrow ;; \uparrow ;; \uparrow ;; Up arrow ;; arrow increasing
downarrow ;; \downarrow ;; \downarrow ;; Down arrow ;; arrow decreasing
xrightarrow ;; \xrightarrow{@} ;; \xrightarrow{f} ;; Arrow with label ;; arrow label
ldots ;; \ldots ;; 1, \ldots, n ;; Low dots … ;; dots ellipsis
cdots ;; \cdots ;; 1 + \cdots + n ;; Centered dots ⋯ ;; dots ellipsis
vdots ;; \vdots ;; \vdots ;; Vertical dots ;; dots ellipsis
ddots ;; \ddots ;; \ddots ;; Diagonal dots ;; dots ellipsis
dots ;; \dots ;; \dots ;; Dots ;; ellipsis
langle ;; \langle ;; \langle ;; Left angle bracket ;; bracket inner
rangle ;; \rangle ;; \rangle ;; Right angle bracket ;; bracket
lfloor ;; \lfloor ;; \lfloor ;; Left floor ;; floor
rfloor ;; \rfloor ;; \rfloor ;; Right floor ;; floor
lceil ;; \lceil ;; \lceil ;; Left ceiling ;; ceil
rceil ;; \rceil ;; \rceil ;; Right ceiling ;; ceil
lvert ;; \lvert ;; \lvert ;; Left bar (abs) ;; abs
rvert ;; \rvert ;; \rvert ;; Right bar (abs) ;; abs
left ;; \left( @ \right) ;; \left( \frac{a}{b} \right) ;; Auto-size parentheses ;; paren bracket
left ;; \left[ @ \right] ;; \left[ \frac{a}{b} \right] ;; Auto-size square brackets ;; bracket
left ;; \left\{ @ \right\} ;; \left\{ \frac{a}{b} \right\} ;; Auto-size braces ;; brace set
left ;; \left| @ \right| ;; \left| \frac{a}{b} \right| ;; Auto-size absolute value ;; abs bars
left ;; \left\langle @ \right\rangle ;; \left\langle u, v \right\rangle ;; Auto-size angle brackets ;; inner product
lfloor ;; \lfloor @ \rfloor ;; \lfloor x \rfloor ;; Floor of ;; floor
lceil ;; \lceil @ \rceil ;; \lceil x \rceil ;; Ceiling of ;; ceil
hat ;; \hat{@} ;; \hat{x} ;; Hat accent ;; accent
bar ;; \bar{@} ;; \bar{x} ;; Bar accent ;; accent mean
vec ;; \vec{@} ;; \vec{v} ;; Vector arrow ;; accent vector
dot ;; \dot{@} ;; \dot{x} ;; Dot accent (derivative) ;; accent derivative
ddot ;; \ddot{@} ;; \ddot{x} ;; Double dot accent ;; accent derivative
tilde ;; \tilde{@} ;; \tilde{x} ;; Tilde accent ;; accent
widehat ;; \widehat{@} ;; \widehat{xyz} ;; Wide hat ;; accent
widetilde ;; \widetilde{@} ;; \widetilde{xyz} ;; Wide tilde ;; accent
overline ;; \overline{@} ;; \overline{z} ;; Overline (conjugate) ;; conjugate bar
underline ;; \underline{@} ;; \underline{x} ;; Underline ;;
overrightarrow ;; \overrightarrow{@} ;; \overrightarrow{AB} ;; Vector over segment ;; vector arrow
overbrace ;; \overbrace{@}^{} ;; \overbrace{a+b}^{n} ;; Brace above ;; brace
underbrace ;; \underbrace{@}_{} ;; \underbrace{a+b}_{n} ;; Brace below ;; brace
overset ;; \overset{@}{} ;; \overset{!}{=} ;; Symbol over another ;; stack above
underset ;; \underset{@}{} ;; \underset{x}{\max} ;; Symbol under another ;; stack below
cancel ;; \cancel{@} ;; \cancel{x} ;; Cross out ;; strike cross
boxed ;; \boxed{@} ;; \boxed{x=1} ;; Box around answer ;; box answer frame
mathbb ;; \mathbb{@} ;; \mathbb{R} ;; Blackboard bold (ℝ, ℕ, ℤ) ;; real natural integers sets
mathcal ;; \mathcal{@} ;; \mathcal{F} ;; Calligraphic ;; script
mathfrak ;; \mathfrak{@} ;; \mathfrak{g} ;; Fraktur ;; gothic
mathbf ;; \mathbf{@} ;; \mathbf{v} ;; Bold ;; bold
boldsymbol ;; \boldsymbol{@} ;; \boldsymbol{\alpha} ;; Bold symbol ;; bold
mathrm ;; \mathrm{@} ;; \mathrm{d}x ;; Upright (roman) ;; roman upright
mathit ;; \mathit{@} ;; \mathit{abc} ;; Italic ;; italic
mathsf ;; \mathsf{@} ;; \mathsf{A} ;; Sans-serif ;; sans
text ;; \text{@} ;; \text{if } x>0 ;; Text inside math ;; words
operatorname ;; \operatorname{@} ;; \operatorname{rank} ;; Custom operator name ;; function
color ;; \color{@}{} ;; \color{red}{x} ;; Colored text ;; colour red
sin ;; \sin ;; \sin x ;; Sine ;; trig
cos ;; \cos ;; \cos x ;; Cosine ;; trig
tan ;; \tan ;; \tan x ;; Tangent ;; trig
cot ;; \cot ;; \cot x ;; Cotangent ;; trig
sec ;; \sec ;; \sec x ;; Secant ;; trig
csc ;; \csc ;; \csc x ;; Cosecant ;; trig
arcsin ;; \arcsin ;; \arcsin x ;; Arcsine ;; trig inverse
arccos ;; \arccos ;; \arccos x ;; Arccosine ;; trig inverse
arctan ;; \arctan ;; \arctan x ;; Arctangent ;; trig inverse
sinh ;; \sinh ;; \sinh x ;; Hyperbolic sine ;; hyperbolic
cosh ;; \cosh ;; \cosh x ;; Hyperbolic cosine ;; hyperbolic
tanh ;; \tanh ;; \tanh x ;; Hyperbolic tangent ;; hyperbolic
log ;; \log ;; \log x ;; Logarithm ;; log
ln ;; \ln ;; \ln x ;; Natural logarithm ;; log
exp ;; \exp ;; \exp x ;; Exponential ;; e
det ;; \det ;; \det A ;; Determinant ;; matrix
dim ;; \dim ;; \dim V ;; Dimension ;;
ker ;; \ker ;; \ker T ;; Kernel ;; null
gcd ;; \gcd ;; \gcd(a,b) ;; Greatest common divisor ;; divisor
deg ;; \deg ;; \deg p ;; Degree (polynomial) ;; degree
arg ;; \arg ;; \arg z ;; Argument ;;
Pr ;; \Pr ;; \Pr(A) ;; Probability ;; probability
bmod ;; \bmod ;; a \bmod n ;; Modulo (binary) ;; mod
pmod ;; \pmod{@} ;; a \equiv b \pmod{n} ;; Modulo in parentheses ;; mod congruent
begin ;; \begin{pmatrix} @ \end{pmatrix} ;; \begin{pmatrix} a & b \\ c & d \end{pmatrix} ;; Matrix (parentheses) ;; pmatrix matrix
begin ;; \begin{bmatrix} @ \end{bmatrix} ;; \begin{bmatrix} a & b \\ c & d \end{bmatrix} ;; Matrix (square brackets) ;; bmatrix matrix
begin ;; \begin{vmatrix} @ \end{vmatrix} ;; \begin{vmatrix} a & b \\ c & d \end{vmatrix} ;; Determinant matrix ;; vmatrix matrix det
begin ;; \begin{cases} @ \end{cases} ;; f(x)=\begin{cases} 1 & x>0 \\ 0 & x\le 0 \end{cases} ;; Cases (piecewise) ;; cases piecewise
begin ;; \begin{aligned} @ \end{aligned} ;; \begin{aligned} a&=b \\ &=c \end{aligned} ;; Aligned equations ;; aligned align
quad ;; \quad ;; a \quad b ;; Wide space ;; space
qquad ;; \qquad ;; a \qquad b ;; Very wide space ;; space
displaystyle ;; \displaystyle ;; \displaystyle\sum_{i=1}^{n} ;; Display style (big operators inline) ;; big
not ;; \not ;; \not\equiv ;; Negate next symbol ;; negate slash
ce ;; \ce{@} ;; \ce{H2O} ;; Chemical formula ;; chemistry mhchem
`;

function parseLatexCommands(src) {
  return src.split('\n').map((l) => l.trim()).filter(Boolean).map((l, i) => {
    const [name, insert, preview, desc, keywords] = l.split(';;').map((s) => (s || '').trim());
    const ins = insert || '\\' + name;
    return {
      name, insert: ins, preview: preview || ins.replace('@', ''), desc,
      label: ins.replace(/@/, '…'), keywords: (keywords || '').split(/\s+/).filter(Boolean), order: i,
    };
  });
}
const LATEX_COMMANDS = parseLatexCommands(LATEX_COMMANDS_SRC);

const POPULAR = ['frac', 'sqrt', 'sum', 'int', 'lim', 'infty', 'alpha', 'cdot', 'leq', 'geq', 'neq', 'in', 'mathbb', 'to', 'text', 'blacksquare'];

/** Rank commands for what was typed after the backslash. */
function rankLatexCommands(query, list = LATEX_COMMANDS, limit = 40) {
  if (!query) {
    const seen = new Set();
    return POPULAR.map((n) => list.find((c) => c.name === n && !seen.has(n) && seen.add(n))).filter(Boolean);
  }
  const ql = query.toLowerCase();
  const scored = [];
  for (const c of list) {
    const nl = c.name.toLowerCase();
    let s = null;
    if (c.name === query) s = 0;
    else if (c.name.startsWith(query)) s = 1;
    else if (nl.startsWith(ql)) s = 2;
    else if (c.keywords.some((k) => k.startsWith(ql))) s = 3;
    else if (nl.includes(ql)) s = 4;
    else if (c.keywords.some((k) => k.includes(ql))) s = 5;
    if (s !== null) scored.push([s, c]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length || a[1].order - b[1].order);
  return scored.slice(0, limit).map((x) => x[1]);
}

/** If the text before the cursor ends in an unescaped "\letters", return the letters (may be ""). */
function latexQueryBefore(lineBefore) {
  const m = /\\([a-zA-Z]*)$/.exec(lineBefore);
  if (!m) return null;
  const bs = lineBefore.length - m[0].length;
  // "\\" is a LaTeX line break, not the start of a command.
  let k = bs - 1, slashes = 0;
  while (k >= 0 && lineBefore[k] === '\\') { slashes++; k--; }
  return slashes % 2 === 0 ? m[1] : null;
}

/** Minimal CodeMirror-like doc over a plain string (for the math scanner). */
function stringDoc(text) {
  return {
    lineAt(p) {
      const s = p === 0 ? 0 : text.lastIndexOf('\n', p - 1) + 1;
      let e = text.indexOf('\n', p);
      if (e < 0) e = text.length;
      return { from: s, to: e, text: text.slice(s, e) };
    },
    sliceString: (a, b) => text.slice(a, b),
  };
}

class LatexSuggest extends obsidian.EditorSuggest {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.limit = 40;
    this.setInstructions([
      { command: '↑↓', purpose: 'to navigate' },
      { command: '↵ / Tab', purpose: 'to insert' },
      { command: 'esc', purpose: 'to dismiss' },
    ]);
    // Tab inserts too, like in code editors.
    // (Uses the popup's internal list when present; otherwise Tab behaves normally.)
    this.scope.register([], 'Tab', (evt) => {
      const list = this.suggestions;
      if (!this.context || !list || typeof list.useSelectedItem !== 'function') return true;
      evt.preventDefault();
      list.useSelectedItem(evt);
      return false;
    });
  }

  onTrigger(cursor, editor) {
    if (!this.plugin.settings.latexAutocomplete) return null;
    const before = editor.getLine(cursor.line).slice(0, cursor.ch);
    const query = latexQueryBefore(before);
    if (query === null) { this.justInserted = null; return null; }
    // Don't reopen on the command we just inserted (e.g. "\infty" right after picking it).
    const j = this.justInserted;
    if (j && j.line === cursor.line && j.ch === cursor.ch && j.query === query) return null;
    this.justInserted = null;
    const text = editor.getValue();
    const offset = editor.posToOffset(cursor);
    if (!isInMath(scanDoc(text), stringDoc(text), offset)) return null;
    return { start: { line: cursor.line, ch: cursor.ch - query.length - 1 }, end: cursor, query };
  }

  getSuggestions(ctx) {
    return rankLatexCommands(ctx.query);
  }

  renderSuggestion(c, el) {
    el.addClass('rym-suggest');
    const sym = el.createDiv({ cls: 'rym-suggest-symbol', attr: { dir: 'ltr' } });
    renderMathInto(sym, c.preview);
    const body = el.createDiv({ cls: 'rym-suggest-body' });
    body.createDiv({ cls: 'rym-suggest-name', text: c.label, attr: { dir: 'ltr' } });
    if (c.desc) body.createDiv({ cls: 'rym-suggest-desc', text: c.desc });
  }

  selectSuggestion(c) {
    const ctx = this.context;
    if (!ctx) return;
    const ed = ctx.editor;
    const caret = c.insert.indexOf('@');
    const text = c.insert.replace('@', '');
    // Templates are single-line, so the final cursor is on the same line. Work it out and
    // remember it *before* editing: the edit itself makes Obsidian re-check the trigger,
    // and it must not reopen the popup on the command we just inserted.
    const line = ed.getLine(ctx.start.line);
    const newLine = line.slice(0, ctx.start.ch) + text + line.slice(ctx.end.ch);
    const cur = { line: ctx.start.line, ch: ctx.start.ch + (caret < 0 ? text.length : caret) };
    const tail = latexQueryBefore(newLine.slice(0, cur.ch));
    this.justInserted = tail === null ? null : { line: cur.line, ch: cur.ch, query: tail };
    ed.replaceRange(text, ctx.start, ctx.end);
    ed.setCursor(cur);
    this.close();
  }
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

    this.registerEditorSuggest(new LatexSuggest(this.app, this));

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
    toggle('Autocomplete LaTeX commands',
      'Inside math, typing \\ shows matching commands (\\frac, \\blacksquare, \\mathbb...) with a rendered preview. Enter or Tab inserts.',
      'latexAutocomplete');
  }
}


module.exports = RightyMathPlugin;
