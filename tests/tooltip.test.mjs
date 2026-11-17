import { test } from 'node:test';
import assert from 'node:assert/strict';
import { place } from '../public/modules/tooltip.mjs';

const view = { width: 400, height: 600 };
const tip = { width: 120, height: 24 };
const at = (left, top, size = 16) => ({ left, top, right: left + size, bottom: top + size });

test('place: above the target, centred on it', () => {
  assert.deepEqual(place(at(100, 300), tip, view), { left: 48, top: 270, side: 'above' });
});

test('place: below when there is no room above', () => {
  assert.deepEqual(place(at(100, 10), tip, view), { left: 48, top: 32, side: 'below' });
});

test('place: never past the left or right edge', () => {
  assert.equal(place(at(2, 300), tip, view).left, 6);
  assert.equal(place(at(390, 300, 10), tip, view).left, 400 - 120 - 6);
});

test('place: beside the target when the window is one header high', () => {
  const header = { width: 400, height: 44 };
  assert.deepEqual(place(at(330, 14), tip, header), { left: 330 - 6 - 120, top: 10, side: 'left' });
  assert.deepEqual(place(at(10, 14), tip, header), { left: 10 + 16 + 6, top: 10, side: 'right' });
});
