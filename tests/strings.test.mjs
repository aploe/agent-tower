import test from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, LANGUAGE_NAMES, S, TABLES, setLanguage } from '../public/strings.mjs';
import { stateLine } from '../public/modules/format.mjs';

test('every language has every key, with the same kind of value', () => {
  const keys = Object.keys(TABLES.en).sort();
  for (const lang of LANGUAGES) {
    assert.deepEqual(Object.keys(TABLES[lang]).sort(), keys, lang);
    for (const key of keys) assert.equal(typeof TABLES[lang][key], typeof TABLES.en[key], `${lang}.${key}`);
  }
  assert.deepEqual(Object.keys(LANGUAGE_NAMES), LANGUAGES);
});

test('setLanguage switches S for the next render; an unknown code changes nothing', () => {
  try {
    assert.equal(S.asking(2), '2 asking');
    assert.equal(setLanguage('de'), true);
    assert.equal(S.asking(1), '1 fragt');
    assert.equal(S.asking(2), '2 fragen');
    assert.deepEqual(stateLine({ state: 'waiting' }), { text: 'fertig', tone: 'normal' });
    assert.equal(setLanguage('fr'), false);
    assert.equal(S.working, 'arbeitet');
  } finally {
    setLanguage('en');
  }
  assert.equal(S.working, 'working');
});

test('table values that are objects have the same keys in every language', () => {
  for (const [key, value] of Object.entries(TABLES.en)) {
    if (typeof value !== 'object') continue;
    for (const lang of LANGUAGES) assert.deepEqual(Object.keys(TABLES[lang][key]).sort(), Object.keys(value).sort(), `${lang}.${key}`);
  }
});
