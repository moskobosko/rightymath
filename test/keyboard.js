// Keyboard-fix helpers: any non-Latin layout, and \text{} exemption.
{
  const BS = '\\';
  eq('hebrew letter is foreign', T.isForeignLetter('ש'), true);
  eq('arabic letter is foreign', T.isForeignLetter('ش'), true);
  eq('persian letter is foreign', T.isForeignLetter('پ'), true);
  eq('russian letter is foreign', T.isForeignLetter('ф'), true);
  eq('greek letter is foreign', T.isForeignLetter('α'), true);
  eq('english letter not foreign', T.isForeignLetter('a'), false);
  eq('german umlaut not foreign (Latin script)', T.isForeignLetter('ü'), false);
  eq('french accent not foreign', T.isForeignLetter('é'), false);
  eq('digit not foreign', T.isForeignLetter('5'), false);
  eq('punctuation not foreign', T.isForeignLetter('.'), false);

  eq('plain math: not text group', T.cursorInTextGroup('x^2 + '), false);
  eq('inside \\text{', T.cursorInTextGroup(BS + 'text{אם '), true);
  eq('after \\text{} closed', T.cursorInTextGroup(BS + 'text{אם} + x'), false);
  eq('inside \\textbf{', T.cursorInTextGroup('a ' + BS + 'textbf{'), true);
  eq('inside \\mbox{', T.cursorInTextGroup(BS + 'mbox{'), true);
  eq('\\text with space before brace', T.cursorInTextGroup(BS + 'text {'), true);
  eq('nested braces inside text', T.cursorInTextGroup(BS + 'text{a {b'), true);
  eq('\\frac{ is not text', T.cursorInTextGroup(BS + 'frac{'), false);
  eq('\\mathrm{ is not text', T.cursorInTextGroup(BS + 'mathrm{'), false);
  eq('text group inside subscript', T.cursorInTextGroup('x_{' + BS + 'text{'), true);
  eq('back in math after text group in subscript', T.cursorInTextGroup('x_{' + BS + 'text{a} '), false);
  eq('escaped brace does not open group', T.cursorInTextGroup(BS + 'text' + BS + '{'), false);

  const start = (text) => { const p = text.indexOf('|'); const t = text.replace('|', ''); return T.mathContentStart(T.scanDoc(t), doc(t), p); };
  eq('content start closed inline', start('אם $x|$'), 4);
  eq('content start while typing', start('אם $x|'), 4);
  eq('content start outside', start('אם |$x$'), -1);
}
