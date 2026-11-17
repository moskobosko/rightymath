// Checks that every autocomplete entry renders in MathJax 4 with Obsidian's TeX packages.
// Needs MathJax installed somewhere:   npm install @mathjax/src@4   (in any folder)
// Run:   MATHJAX_DIR=<that folder>/node_modules/@mathjax/src node test/latex.js
const path = require('path');
const fs = require('fs');
const Module = require('module');

const MJ = process.env.MATHJAX_DIR;
if (!MJ) { console.log('SKIP latex.js (set MATHJAX_DIR to run)'); process.exit(0); }
const mj = (p) => require(path.join(MJ, 'cjs', p));

// Same packages Obsidian enables (base defaults + its "[+]" list), minus noerrors so errors surface,
// and minus bussproofs (proof trees; it needs a real output renderer and none of our commands use it).
const PACKAGES = ['base', 'ams', 'newcommand', 'action', 'amscd', 'bbox', 'boldsymbol', 'braket',
  'cancel', 'cases', 'centernot', 'color', 'colortbl', 'empheq', 'enclose', 'extpfeil', 'gensymb', 'html',
  'mathtools', 'mhchem', 'tagformat', 'textcomp', 'unicode', 'upgreek', 'verb'];
const CONFIG_FILE = { amscd: 'AmsCd', bbox: 'Bbox', tagformat: 'TagFormat', textcomp: 'Textcomp' };
for (const p of PACKAGES) {
  const name = CONFIG_FILE[p] || p[0].toUpperCase() + p.slice(1);
  mj(`input/tex/${p}/${name}Configuration.js`);
}

const { mathjax } = mj('mathjax.js');
const { TeX } = mj('input/tex.js');
const { liteAdaptor } = mj('adaptors/liteAdaptor.js');
const { RegisterHTMLHandler } = mj('handlers/html.js');
const { STATE } = mj('core/MathItem.js');
RegisterHTMLHandler(liteAdaptor());
const tex = new TeX({ packages: PACKAGES, formatError: (jax, err) => { throw err; } });
const doc = mathjax.document('', { InputJax: tex });

// Load the command list from main.js (same trick as run.js: compile with an extra export line).
const file = path.join(__dirname, '..', 'main.js');
const stub = { Plugin: class {}, PluginSettingTab: class {}, Setting: class {}, MarkdownView: class {}, EditorSuggest: class {} };
const orig = Module._load;
Module._load = function (req, ...a) {
  if (req === 'obsidian') return stub;
  if (req === '@codemirror/view') return { ViewPlugin: { fromClass: () => ({}) }, Decoration: { line: () => ({}), mark: () => ({}), none: {} }, EditorView: {}, WidgetType: class {}, showTooltip: {}, Direction: { LTR: 0 } };
  if (req === '@codemirror/state') return { StateField: { define: () => ({}) } };
  return orig.call(this, req, ...a);
};
const m = new Module(file, module);
m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
m._compile(fs.readFileSync(file, 'utf8') + '\n;module.exports = { LATEX_COMMANDS };', file);
const { LATEX_COMMANDS } = m.exports;

let fail = 0;
for (const c of LATEX_COMMANDS) {
  for (const [kind, src] of [['preview', c.preview], ['insert', c.insert.replace('@', 'x')]]) {
    try { doc.convert(src, { display: false, end: STATE.CONVERT }); }
    catch (e) { fail++; console.log(`FAIL \\${c.name} (${kind}): ${src}  ->  ${e.message}`); }
  }
}
console.log(fail ? `${fail} FAILED of ${LATEX_COMMANDS.length * 2}` : `ALL ${LATEX_COMMANDS.length} commands render (preview + insert)`);
process.exit(fail ? 1 : 0);
