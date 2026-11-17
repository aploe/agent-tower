import test from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, say, setLanguage, tables } from '../src/messages.mjs';

test('every language knows every message', () => {
  const keys = Object.keys(tables.en).sort();
  for (const lang of LANGUAGES) assert.deepEqual(Object.keys(tables[lang]).sort(), keys, lang);
  assert.deepEqual(LANGUAGES, ['en', 'de']);
});

test('say follows setLanguage; an unknown code means English', () => {
  try {
    assert.equal(say('windowsShowName', { n: 2, name: 'shop' }), '2 windows show "shop"; the title does not say which one');
    setLanguage('de');
    assert.equal(say('windowsShowName', { n: 2, name: 'shop' }), '2 Fenster zeigen "shop"; welches gemeint ist, sagt der Titel nicht');
    assert.equal(say('noJump'), 'Für diese Session gibt es keinen Sprung');
    setLanguage('fr');
    assert.equal(say('noJump'), 'This session cannot be opened from here');
  } finally {
    setLanguage('en');
  }
});
