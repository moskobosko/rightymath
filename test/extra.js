// appended cases for auto-paired brackets
const BS = String.fromCharCode(92);
eq('autopaired } keeps pending', pend('וואו איזה נוח $' + BS + 'lim_{|}'), { from: 14, to: 22 });
eq('user line stays rtl while typing {}', dirWhileTyping('וואו איזה נוח $' + BS + 'lim_{|}'), 'rtl');
eq('editing middle of unfinished formula', pend('אם $' + BS + 'frac{a|}{b}') !== null, true);
eq('autopaired ( and ^{}', pend('אם $f(x^{2|})') !== null, true);
eq('hebrew after cursor -> no pending', pend('עולה $5 ו|עוד מילים'), null);
eq('keyboard fix active inside {}', inMath('אם $' + BS + 'lim_{|}'), true);
// inline preview source extraction
const cur = (text) => { const p = text.indexOf('|'); const t = text.replace('|', ''); const d = doc(t); d.sliceString = (a, b) => t.slice(a, b); const f = T.currentInlineFormula(T.scanDoc(t), d, { empty: true, head: p }); return f && f.src; };
eq('preview src closed', cur('אם $x^|2$ אז'), 'x^2');
eq('preview src right after closing $', cur('אם $x^2$|'), 'x^2');
eq('preview src while typing', cur('אם $' + BS + 'frac{a|'), BS + 'frac{a');
eq('preview src autopaired brace', cur('נוח $' + BS + 'lim_{n|}'), BS + 'lim_{n}');
eq('preview src autopaired $', cur('אם $x|$'), 'x');
eq('no preview in text', cur('שלום |עולם'), null);
eq('no preview for display', cur('$$' + '\n' + 'x|' + '\n' + '$$'), null);
