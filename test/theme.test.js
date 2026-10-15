import assert from 'node:assert/strict';
import { test } from 'node:test';
import { THEME, contrast } from '../src/theme.js';

const TEXT = 4.5;
const UI = 3;

test('contrast() matches known WCAG reference values', () => {
  assert.equal(contrast('#000000', '#FFFFFF').toFixed(2), '21.00');
  assert.equal(contrast('#FFFFFF', '#FFFFFF').toFixed(2), '1.00');
  assert.equal(contrast('#767676', '#FFFFFF').toFixed(2), '4.54');
});

for (const [mode, t] of Object.entries(THEME)) {
  test(`${mode} theme meets WCAG 2.2 AA for every pair the pages use`, () => {
    const pairs = [
      ['text on bg', t.text, t.bg, TEXT],
      ['text on surface', t.text, t.surface, TEXT],
      ['muted on bg', t.muted, t.bg, TEXT],
      ['muted on surface', t.muted, t.surface, TEXT],
      ['button text on pink', t.onPink, t.pink, TEXT],
      ['delete button text', t.onDanger, t.danger, TEXT],
      ['delete button on bg', t.danger, t.bg, UI],
      ['error on surface', t.error, t.surface, TEXT],
      ['error on bg', t.error, t.bg, TEXT],
      ['text on error background', t.text, t.errorBg, TEXT],
      ['error badge glyph', t.surface, t.error, UI],
      ['outline on surface', t.line, t.surface, UI],
      ['outline on bg', t.line, t.bg, UI],
      ['focus ring on bg', t.focus, t.bg, UI],
      ['focus ring on surface', t.focus, t.surface, UI],
    ];
    for (const [label, fg, bg, min] of pairs) {
      const ratio = contrast(fg, bg);
      assert.ok(ratio >= min, `${mode} ${label}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${min}:1`);
    }
  });
}

test('white text on the brand pink would fail, which is why buttons use charcoal', () => {
  assert.ok(contrast('#FFFFFF', THEME.light.pink) < TEXT);
});
