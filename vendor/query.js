/* What a typed search actually asks for.
 *
 * Until now every space-separated word had to appear somewhere, as a substring, and that was the
 * whole language. It is a good default and it cannot say two things people kept needing: that words
 * belong together, and that something should be left out.
 *
 *   die cut          both words, anywhere        — unchanged
 *   "die cut"        that phrase, in that order
 *   riso -calendar   riso, but not the calendars
 *   -"flat lay"      everything except that phrase
 *
 * Pure and DOM-free so it can be tested directly, which is the same reason `reconcile.js` sits
 * apart from the code that calls it. The parsing is the part that goes wrong — an unbalanced quote,
 * a bare dash, a phrase with a dash inside it — so the parsing is what the tests are about.
 */

/**
 * Split a query into terms. Each is `{ text, negated, phrase }`.
 *
 * Deliberately forgiving. This runs on every keystroke, which means it spends most of its life
 * looking at half-typed input: `"die` is a person midway through typing `"die cut"`, and refusing
 * to parse it would make the results flicker to empty as they type. An unclosed quote simply runs
 * to the end.
 */
/* One spelling for both sides of the comparison.
 *
 * WHY THIS EXISTS. `"die cut"` returned nothing from an archive with twelve die-cut things in it,
 * because ten of the twelve say *die-cut* and a phrase was a plain substring test. The example was
 * printed on the shortcuts panel, so the app was documenting a search that could not work — and it
 * was found by measuring the counts rather than by reading, because the query still returned
 * sixteen results and looked fine. Every one of them had come from the meaning half.
 *
 * Runs of anything that is not a letter or a number collapse to one space, on the query and on the
 * haystack alike. `\p{L}` rather than `a-z`, or the first accented filename in the archive would
 * become two words — this has to be about punctuation, not about the Latin alphabet.
 *
 * It applies to plain terms too, not only phrases. That direction only ever loosens: anything that
 * matched before still matches, because both sides are folded the same way. `sit-stand` now finds
 * `sit stand` and the reverse, which is what somebody typing either one meant.
 *
 * The cost is paid once per file (`haystack` caches) and once per keystroke (here), never per file
 * per keystroke — which is the shape that matters at ten thousand items. */
export const normalize = s =>
  String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function parseQuery(raw) {
  const s = String(raw || '');
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;

    let negated = false;
    // A leading dash negates — but only when something follows it. A bare `-`, or the dash in
    // `sit-stand`, is part of the word.
    if (s[i] === '-' && i + 1 < s.length && !/\s/.test(s[i + 1])) { negated = true; i++; }

    let text = '', phrase = false;
    if (s[i] === '"') {
      phrase = true;
      i++;
      const close = s.indexOf('"', i);
      text = close === -1 ? s.slice(i) : s.slice(i, close);
      i = close === -1 ? s.length : close + 1;
    } else {
      const start = i;
      while (i < s.length && !/\s/.test(s[i])) i++;
      text = s.slice(start, i);
    }

    text = normalize(text);
    /* Dropped when there is nothing in it, and when it is nothing but dashes.
       A lone `-` is the halfway point of typing `-calendar`, and taking it literally means a
       substring search for a hyphen — which matches nearly every path in the archive, so the
       results flash to almost-everything and then snap back on the next keystroke. It carries no
       information either way, so it is not a term. */
    if (text && !/^-+$/.test(text)) out.push({ text, negated, phrase });
  }
  return out;
}

/**
 * Does one item's searchable text satisfy every term?
 *
 * `hay` is already normalized by the caller — it is cached per file and this runs once per file
 * per keystroke, so folding it here would be the most repeated wasted work in the app.
 */
export function matchesQuery(hay, terms) {
  /* A WORD AND ITS ORDINARY ENDINGS. Three rules were measured against the real archive before
     this one was chosen, because each of the obvious two is wrong in a different direction.
       anywhere in a word  `red` finds 86, of which 57 are centeRED, scatteRED, blurRED,
                           numbeRED, layeRED, rendeRED — two thirds of a colour search returning
                           descriptions of texture. This is what shipped until 2026-08-16.
       whole word only     `logo` finds 1 instead of 9, `book` 1 instead of 6, `pack` 1 instead
                           of 5, `print` 22 instead of 57. Plurals and tenses are not optional in
                           a language people type at.
       word + endings      `desk` 22 and not `desktop`. `print` 57. `logo` 9 and not `logotype`.
                           `red` 29. `riso` 70, unchanged.
     So a term matches a word it begins, provided what is left is an ordinary inflection and not
     the start of another word. `desktop` is desk plus a noun; `printed` is print plus a tense.
     A correction worth keeping: the argument for the prefix rule was that `riso` had to reach
     `risograph`. It never did — `riso` is 70 under every rule, because it matches the folder name
     in the path. That was asserted without being measured, and the measurement is what killed it.
     Split once per file rather than a regular expression per term per file: the haystack is already
     normalized to single spaces, so this is a walk over words that were going to be compared
     anyway. */
  const words = hay.split(' ');
  for (const t of terms) {
    const hit = hasTerm(words, t.text);
    if (t.negated ? hit : !hit) return false;
  }
  return true;
}

/* One rule for one word and for several, because a phrase is a run of words and the last of them
   inflects exactly like a lone one — `"die cut"` should find `die cuts` for the same reason `print`
   finds `prints`. The first version of this split the haystack and asked whether any single word
   started with the term, which no word can do when the term contains a space: every phrase test in
   the suite went red at once, which is the good kind of failure. */
function hasTerm(words, text) {
  const want = text.split(' ');
  const last = want.length - 1;
  outer:
  for (let i = 0; i + last < words.length; i++) {
    for (let k = 0; k < last; k++) if (words[i + k] !== want[k]) continue outer;
    const w = words[i + last], tail = want[last];
    if (w.startsWith(tail) && INFLECTION.test(w.slice(tail.length))) return true;
  }
  return false;
}
/* The endings that are still the same word. Deliberately short: every entry is a suffix English
   adds to a stem, and nothing here is the beginning of a different noun. Adding to it is how this
   rule slides back toward matching anywhere, so the bar for a new one is that it changes a word's
   form rather than its meaning. */
const INFLECTION = /^(s|es|ed|d|ing|er|ers|ings|y|ies)?$/;

/* A query of only negations still means something — "everything except this" — so it is not the
   same as an empty query, and the caller must not shortcut on "no positive terms". Stated here
   because the obvious optimisation is to skip filtering when nothing positive was typed, and that
   would silently drop the exclusion. */
export const hasTerms = terms => terms.length > 0;
