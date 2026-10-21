// Every locale carries the same keys, and every key is used somewhere.
//
// Needs no browser and no server, so it is the cheapest check here and worth
// running first.
//
// Two failures it catches, both of which have happened here:
//   a string added to en.js and seven other files, leaving one locale to fall
//   back to a key name shown to a reader
//   a key added to all nine and referenced nowhere, which is dead weight that
//   later reads as a feature somebody forgot to finish
import { readFileSync, readdirSync } from 'node:fs';

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Relative to this file, not an absolute path into one machine. The suites
// this replaces hardcoded a sandbox path and could not be run anywhere else.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = `${ROOT}/js/locales`;
const files = readdirSync(DIR).filter(f => f.endsWith('.js')).sort();

const keysOf = (src) => {
  const found = new Set();
  // 'some.key': — the shape every line in these files uses.
  for (const m of src.matchAll(/^\s*'([^']+)'\s*:/gm)) found.add(m[1]);
  return found;
};

const locales = Object.fromEntries(
  files.map(f => [f.replace('.js', ''), keysOf(readFileSync(`${DIR}/${f}`, 'utf8'))]));
const names = Object.keys(locales);
const reference = 'en';
if (!locales[reference]) { console.log('FAIL no en.js to compare against'); process.exit(1); }

const problems = [];
for (const name of names) {
  if (name === reference) continue;
  const missing = [...locales[reference]].filter(k => !locales[name].has(k));
  // A locale may carry plural categories English does not have. Czech and
  // Polish both use `.few` for 2-4, which pluralForm() in js/i18n.js asks for
  // and tn() falls back from when it is absent — so `base.few` is legitimate
  // wherever English has `base.one` or `base.other`. The first version of this
  // flagged twelve of them in each language as errors.
  const pluralExtra = (k) => {
    const m = /^(.*)\.(few|many|two|zero)$/.exec(k);
    return m && (locales[reference].has(`${m[1]}.one`)
              || locales[reference].has(`${m[1]}.other`));
  };
  const extra = [...locales[name]].filter(k => !locales[reference].has(k) && !pluralExtra(k));
  if (missing.length) problems.push(`${name} is missing ${missing.length}: ${missing.slice(0, 6).join(', ')}`);
  if (extra.length) problems.push(`${name} has ${extra.length} en.js does not: ${extra.slice(0, 6).join(', ')}`);
}

// Which keys the source actually asks for. Read as text rather than executed,
// because a key can be reached through t(), data-i18n, tOr() or a template.
const source = ['app.js', 'index.html', 'guide.html', 'admin.html',
                ...readdirSync(`${ROOT}/js`).filter(f => f.endsWith('.js')).map(f => `js/${f}`)]
  .map(f => { try { return readFileSync(`${ROOT}/${f}`, 'utf8'); } catch { return ''; } })
  .join('\n');

const used = [...locales[reference]].filter(k => {
  if (source.includes(`'${k}'`) || source.includes(`"${k}"`)) return true;
  // A plural form is never named in full: tn('reports.window.days', n) builds
  // '.one' or '.other' from the base. Without this the count said 47 keys were
  // unreferenced when every one of them was reachable, which is noise that
  // would hide a genuinely dead key.
  const plural = /^(.*)\.(one|other|few|many|two|zero)$/.exec(k);
  if (plural && (source.includes(`'${plural[1]}'`) || source.includes(`"${plural[1]}"`))) return true;
  // Built from a prefix at runtime: `paused.${slug}`, `level.${n}`.
  const prefix = k.slice(0, k.lastIndexOf('.') + 1);
  return prefix.length > 1
    && (source.includes('`' + prefix + '${') || source.includes(`'${prefix}' +`));
});
const unused = [...locales[reference]].filter(k => !used.includes(k));

if (problems.length) {
  for (const p of problems) console.log('  FAIL ' + p);
  console.log(`locale-test            FAILED: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`locale-test            all ${names.length} locales consistent`
  + ` · ${locales[reference].size} keys · ${used.length} used in source`
  + (unused.length ? ` · ${unused.length} unreferenced: ${unused.slice(0, 5).join(', ')}` : ''));
