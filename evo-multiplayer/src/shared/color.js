// HSL hue (0..1) -> 0xRRGGBB, shared so server and client agree on colours.
export function hueToRgb(h, s = 0.72, l = 0.56) {
  h = ((h % 1) + 1) % 1;
  const k = (n) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}

export function rgbToCss(rgb) {
  return '#' + (rgb & 0xffffff).toString(16).padStart(6, '0');
}
