const Module = require('module');
const orig = Module._load;
const stubDeco = { line: () => ({ range: () => ({}) }), mark: () => ({ range: () => ({}) }), none: {}, set: () => ({}) };
Module._load = function (req, ...a) {
  if (req === 'obsidian') return { Plugin: class {}, PluginSettingTab: class {}, Setting: class {}, MarkdownView: class {} };
  if (req === '@codemirror/view') return { ViewPlugin: { fromClass: () => ({}) }, Decoration: stubDeco, EditorView: {}, WidgetType: class {}, showTooltip: { from: () => ({}) }, Direction: { LTR: 0, RTL: 1 } };
  if (req === '@codemirror/state') return { StateField: { define: () => ({}) }, StateEffect: { define: () => ({ of: () => ({}) }) } };
  return orig.call(this, req, ...a);
};
// Load main.js without a test-only export: compile it with an extra line that
// exposes the pure helpers to this harness.
const fs = require('fs'), path = require('path');
const T = (() => {
  const file = path.join(__dirname, '..', 'main.js');
  const m = new Module(file, module);
  m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(fs.readFileSync(file, 'utf8') + `
;module.exports = { scanDoc, classifyLine, firstStrongDir, cleanMarkdown, isInMath, mathContentStart,
  cursorInTextGroup, isForeignLetter, pendingInlineMath, withPending, currentInlineFormula, US_KEYS, LINE_PREFIX_RE };`, file);
  return m.exports;
})();
let fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)); };

function lines(text) {
  const info = T.scanDoc(text); let pos = 0; const out = [];
  for (const l of text.split('\n')) { const c = T.classifyLine(pos, l, info); out.push(c ? c.dir : null); pos += l.length + 1; }
  return out;
}
const doc = (text) => ({ lineAt(p) { const s = text.lastIndexOf('\n', p - 1) + 1; let e = text.indexOf('\n', p); if (e < 0) e = text.length; return { from: s, text: text.slice(s, e) }; } });
const inMath = (text) => { const p = text.indexOf('|'); const t = text.replace('|', ''); return T.isInMath(T.scanDoc(t), doc(t), p); };

eq('math-first hebrew line is RTL', lines('$f(x)=x^2$ היא פונקציה רציפה'), ['rtl']);
eq('english line LTR', lines('Let $x$ be real'), ['ltr']);
eq('only math = neutral', lines('$a+b=c$'), [null]);
eq('list + task box', lines('- [x] $n$ מספר טבעי'), ['rtl']);
eq('heading', lines('## משפט $\epsilon$-$\delta$'), ['rtl']);
eq('callout', lines('> [!note] הגדרה'), ['rtl']);
eq('display block LTR struct', lines('הנה:\n$$\n\int_0^1 f\n\n$$\nסוף'), ['rtl', 'ltr', 'ltr', 'ltr', 'ltr', 'rtl']);
eq('code block', lines('```py\nprint("שלום")\n```'), ['ltr', 'ltr', 'ltr']);
eq('frontmatter', lines('---\ntitle: שלום\n---\nטקסט'), ['ltr', 'ltr', 'ltr', 'rtl']);
eq('inline code skipped', lines('`foo` שלום'), ['rtl']);
eq('wikilink alias', lines('[[Calculus notes|סיכום]] כאן'), ['rtl']);
eq('RLM forces rtl', lines('‏$x$ is good'), ['rtl']);
eq('dollar price not math', T.scanDoc('costs $5 and $10').math.length, 0);
eq('escaped dollar', T.scanDoc(String.fromCharCode(92) + '$x$ y').math.length, 0);
eq('math in inline code ignored', T.scanDoc('`$x$` and').math.length, 0);
eq('two inline', T.scanDoc('$a$ ו-$b$').math.map(r => [r.from, r.to]), [[0, 3], [6, 9]]);
eq('inside closed inline', inMath('אם $x|+1$ אז'), true);
eq('after closing $', inMath('אם $x$| אז'), false);
eq('typing new formula', inMath('אם $x^|'), true);
eq('just typed $', inMath('אם $|'), true);
eq('autopaired $|$', inMath('אם $|$'), true);
eq('hebrew text after price', inMath('עולה $5 ו|עוד מילים'), false);
eq('inside display', inMath('$$\n\fr|ac\n$$'), true);
eq('unclosed display', inMath('$$\n\sum|'), true);
eq('plain text', inMath('שלום |עולם'), false);
eq('US map', [T.US_KEYS.KeyA[0], T.US_KEYS.Comma[0], T.US_KEYS.Digit9[1]], ['a', ',', '(']);

const pend = (text) => { const p = text.indexOf('|'); const t = text.replace('|', ''); const info = T.scanDoc(t); return T.pendingInlineMath(info, doc(t), p); };
const dirWhileTyping = (text) => { const p = text.indexOf('|'); const t = text.replace('|', ''); const info = T.scanDoc(t); const i2 = T.withPending(info, T.pendingInlineMath(info, doc(t), p)); const c = T.classifyLine(0, t, i2); return c ? c.dir : null; };
eq('pending range while typing', pend('אם $' + String.fromCharCode(92) + 'frac{a|'), { from: 3, to: 11 });
eq('pending with autopaired $', pend('אם $x|$'), null); // closed already -> real math range
eq('no pending after closing', pend('אם $x$ |'), null);
eq('no pending for price mid-text', pend('עולה $5 ו|עוד'), null);
eq('line starting with unfinished math stays neutral', dirWhileTyping('$x^2 + y|'), null);
eq('hebrew line with unfinished math stays rtl', dirWhileTyping('אם $x^2 + y|'), 'rtl');
eq('math-first then hebrew, typing 2nd formula', dirWhileTyping('$f$ היא $g(x|'), 'rtl');
eq('pending does not break existing math', T.withPending(T.scanDoc('$a$ ו $b'), { from: 6, to: 8 }).math.map(r => [r.from, r.to]), [[0, 3], [6, 8]]);
eval(require('fs').readFileSync(__dirname + '/extra.js', 'utf8'));
eval(require('fs').readFileSync(__dirname + '/keyboard.js', 'utf8'));
console.log(fail ? `${fail} FAILED` : 'ALL PASSED'); process.exit(fail ? 1 : 0);
