// LaTeX autocomplete: catalog sanity, ranking, and when the popup triggers.
{
  const BS = '\\';
  const names = (q) => T.rankLatexCommands(q).map((c) => c.name);
  const labels = (q) => T.rankLatexCommands(q).map((c) => c.label);

  eq('catalog is big', T.LATEX_COMMANDS.length > 200, true);
  eq('every insert starts with a backslash', T.LATEX_COMMANDS.every((c) => c.insert.startsWith(BS)), true);
  eq('at most one cursor marker per insert', T.LATEX_COMMANDS.every((c) => c.insert.split('@').length <= 2), true);
  eq('every entry has a description', T.LATEX_COMMANDS.every((c) => c.desc.length > 0), true);

  eq('\\blacksquare found from "black"', names('black')[0], 'blacksquare');
  eq('\\blacksquare found from "qed"', names('qed').includes('qed') && labels('qed').includes(BS + 'blacksquare'), true);
  eq('"box" keyword finds square', names('box').includes('square'), true);
  eq('exact match first: "in"', names('in')[0], 'in');
  eq('"fr" -> frac first', names('fr')[0], 'frac');
  eq('case: "D" -> Delta first', names('D')[0], 'Delta');
  eq('case: "d" -> lowercase first', /^[a-z]/.test(names('d')[0]), true);
  eq('"alp" -> alpha', names('alp')[0], 'alpha');
  eq('"pmat" finds the pmatrix environment', labels('pmat').some((l) => l.includes('pmatrix')), true);
  eq('"implies" both forms', names('impl').slice(0, 2).sort(), ['impliedby', 'implies']);
  eq('empty query shows popular list', names('').slice(0, 3), ['frac', 'sqrt', 'sum']);
  eq('no match -> empty', names('zzzzqq'), []);
  eq('limit respected', T.rankLatexCommands('a').length <= 40, true);

  eq('trigger: after backslash', T.latexQueryBefore('x + ' + BS), '');
  eq('trigger: partial command', T.latexQueryBefore('x + ' + BS + 'fra'), 'fra');
  eq('no trigger: line break \\\\', T.latexQueryBefore('a ' + BS + BS), null);
  eq('trigger after line break: \\\\ \\fr', T.latexQueryBefore('a ' + BS + BS + ' ' + BS + 'fr'), 'fr');
  eq('trigger: \\\\\\fr (break then command)', T.latexQueryBefore('a ' + BS + BS + BS + 'fr'), 'fr');
  eq('no trigger: \\{', T.latexQueryBefore('a ' + BS + '{'), null);
  eq('no trigger: plain text', T.latexQueryBefore('hello'), null);
  eq('no trigger after space', T.latexQueryBefore(BS + 'alpha '), null);

  const d = T.stringDoc('ab\ncd');
  eq('stringDoc line 1', d.lineAt(1).text, 'ab');
  eq('stringDoc line 2', d.lineAt(4).text, 'cd');
  eq('stringDoc at 0', d.lineAt(0).from, 0);
  eq('stringDoc slice', d.sliceString(3, 5), 'cd');

  const insertOf = (label) => T.LATEX_COMMANDS.find((c) => c.label === label);
  eq('frac cursor goes in first brace', insertOf(BS + 'frac{…}{}').insert.indexOf('@'), 6);
}
