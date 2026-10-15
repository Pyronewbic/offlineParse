// Colours sampled from the VERSUS EXPERIENCE logo files: pink #FA6AA3, charcoal #282828.
// test/theme.test.js enforces WCAG 2.2 contrast for every pair the pages rely on.
export const THEME = {
  light: {
    bg: '#F4F4F2',
    surface: '#FFFFFF',
    text: '#282828',
    muted: '#5C5C5C',
    line: '#282828',
    pink: '#FA6AA3',
    onPink: '#282828',
    shadow: '#282828',
    focus: '#1F4FFF',
    error: '#B3002D',
    errorBg: '#FDE7EC',
    danger: '#B3002D',
    onDanger: '#FFFFFF',
    rule: '#DAD8D2',
    hover: '#FFF0F6',
  },
  dark: {
    bg: '#1B1B1D',
    surface: '#26262A',
    text: '#F2F2F2',
    muted: '#A8A8AD',
    line: '#E6E6E6',
    pink: '#FA6AA3',
    onPink: '#1B1B1D',
    shadow: '#000000',
    focus: '#FFE14D',
    error: '#FF7A8A',
    errorBg: '#3A1D24',
    danger: '#FF7A8A',
    onDanger: '#1B1B1D',
    rule: '#3C3C42',
    hover: '#33282E',
  },
};

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function themeCss() {
  const vars = (t) => Object.entries(t).map(([k, v]) => `--${k}:${v}`).join(';');
  return `:root{${vars(THEME.light)};color-scheme:light dark}` +
    `@media (prefers-color-scheme: dark){:root{${vars(THEME.dark)}}}`;
}
