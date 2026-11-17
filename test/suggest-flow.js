// End-to-end flow of the autocomplete popup with a fake editor.
// The fake editor re-runs onTrigger on every edit (like Obsidian does), so this reproduces
// the "picked \infty, popup came back showing only \infty" bug.
{
  const BS = '\\';

  function fakeEditor(text, cursorOffset) {
    const ed = {
      text, cursor: null, suggest: null, retriggers: [],
      getValue() { return this.text; },
      getLine(n) { return this.text.split('\n')[n]; },
      posToOffset(p) { const lines = this.text.split('\n'); let o = 0; for (let i = 0; i < p.line; i++) o += lines[i].length + 1; return o + p.ch; },
      offsetToPos(o) { const before = this.text.slice(0, o).split('\n'); return { line: before.length - 1, ch: before[before.length - 1].length }; },
      replaceRange(s, from, to) {
        const a = this.posToOffset(from), b = this.posToOffset(to);
        this.text = this.text.slice(0, a) + s + this.text.slice(b);
        this.cursor = this.offsetToPos(a + s.length);
        // Obsidian re-checks the trigger synchronously after an edit.
        if (this.suggest) this.retriggers.push(this.suggest.onTrigger(this.cursor, this, null));
      },
      setCursor(p) { this.cursor = p; },
      getCursor() { return this.cursor; },
    };
    ed.cursor = ed.offsetToPos(cursorOffset);
    return ed;
  }

  const plugin = { settings: { latexAutocomplete: true } };
  const pick = (startText, caretMarker, wantLabel) => {
    const at = startText.indexOf(caretMarker);
    const ed = fakeEditor(startText.replace(caretMarker, ''), at);
    const s = new T.LatexSuggest({}, plugin);
    ed.suggest = s;
    const ctx = s.onTrigger(ed.cursor, ed, null);
    if (!ctx) return { opened: false };
    s.context = Object.assign({ editor: ed }, ctx);
    const choice = s.getSuggestions(ctx).find((c) => c.label === wantLabel);
    s.selectSuggestion(choice);
    const after = s.onTrigger(ed.cursor, ed, null); // re-check at final cursor
    return { opened: true, text: ed.text, cursor: ed.posToOffset(ed.cursor), retriggered: ed.retriggers.some(Boolean) || !!after, closed: !!s.closed };
  };

  const r = pick('$' + BS + 'inf|$', '|', BS + 'infty');
  eq('flow: popup opens for \\inf', r.opened, true);
  eq('flow: \\infty inserted', r.text, '$' + BS + 'infty$');
  eq('flow: cursor after \\infty', r.cursor, 7);
  eq('flow: popup does NOT reopen after picking', r.retriggered, false);
  eq('flow: popup closed', r.closed, true);

  const f = pick('אם $' + BS + 'fr|', '|', BS + 'frac{…}{}');
  eq('flow: \\frac template inserted', f.text, 'אם $' + BS + 'frac{}{}');
  eq('flow: cursor inside first brace', f.cursor, 'אם $'.length + 6);
  eq('flow: no reopen inside braces', f.retriggered, false);

  const o = pick('outside ' + BS + 'inf|', '|', BS + 'infty');
  eq('flow: no popup outside math', o.opened, false);

  // Typing more letters after an inserted command should open the popup again.
  {
    const ed = fakeEditor('$' + BS + 'alpha$', 7);
    const s = new T.LatexSuggest({}, plugin);
    s.justInserted = { line: 0, ch: 7, query: 'alpha' };
    eq('flow: suppressed right after insert', s.onTrigger({ line: 0, ch: 7 }, ed, null), null);
    ed.text = '$' + BS + 'alphab$';
    eq('flow: reopens when typing more', !!s.onTrigger({ line: 0, ch: 8 }, ed, null), true);
  }
}
