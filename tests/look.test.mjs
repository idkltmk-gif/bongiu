// Colour grade copy (Copy the look). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { toLab, fromLab, measure, buildLut, applyLut } from "../js/look.js";

// a test "photo": a smooth gradient of many colours
function photo(w, h, f) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4,
        [r, g, b] = f(x / (w - 1), y / (h - 1));
      px[i] = r * 255;
      px[i + 1] = g * 255;
      px[i + 2] = b * 255;
      px[i + 3] = 255;
    }
  return px;
}
const scene = (x, y) => [0.2 + 0.6 * x, 0.15 + 0.7 * y, 0.3 + 0.4 * (1 - x) * y];
const maxDiff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) if (i % 4 !== 3) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

test("Oklab round trip keeps colours", () => {
  for (const c of [[0, 0, 0], [1, 1, 1], [0.5, 0.2, 0.9], [0.9, 0.6, 0.4]]) {
    const back = fromLab(...toLab(...c));
    back.forEach((v, i) => assert.ok(Math.abs(v - c[i]) < 1e-4, `${c} → ${back}`));
  }
});

test("a photo graded to itself barely changes", () => {
  const px = photo(120, 90, scene),
    m = measure(px, 120, 90),
    out = applyLut(new Uint8ClampedArray(px), buildLut(m, m, 1));
  assert.ok(maxDiff(px, out) <= 3, `max change ${maxDiff(px, out)}`);
});

test("strength 0 leaves the photo as it is", () => {
  const a = photo(80, 60, scene),
    b = photo(80, 60, (x, y) => [0.6 * x, 0.3 + 0.2 * y, 0.8]),
    out = applyLut(new Uint8ClampedArray(a), buildLut(measure(a, 80, 60), measure(b, 80, 60), 0));
  assert.ok(maxDiff(a, out) <= 2, `max change ${maxDiff(a, out)}`);
});

test("greys take the reference's warm tint", () => {
  const grey = photo(100, 100, (x, y) => [0.2 + 0.6 * y, 0.2 + 0.6 * y, 0.2 + 0.6 * y]),
    warm = photo(100, 100, (x, y) => [0.25 + 0.6 * y, 0.2 + 0.6 * y, 0.12 + 0.6 * y]),
    out = applyLut(new Uint8ClampedArray(grey), buildLut(measure(grey, 100, 100), measure(warm, 100, 100)));
  const i = (50 * 100 + 50) * 4;
  assert.ok(out[i] > out[i + 2] + 4, `mid grey became ${out[i]},${out[i + 1]},${out[i + 2]}`);
});

test("a very different scene is not crushed: mid-tones move a little at most", () => {
  const bright = photo(100, 100, (x, y) => [0.6 + 0.35 * x, 0.6 + 0.35 * y, 0.7]),
    dark = photo(100, 100, (x, y) => [0.05 + 0.3 * x, 0.05 + 0.3 * y, 0.1]),
    m1 = measure(bright, 100, 100),
    out = applyLut(new Uint8ClampedArray(bright), buildLut(m1, measure(dark, 100, 100)));
  const m2 = measure(out, 100, 100);
  assert.ok(m1.q[4] - m2.q[4] <= 0.045, `median lightness ${m1.q[4]} → ${m2.q[4]}`);
});

test("strength above 100% pushes further the same way", () => {
  const grey = photo(100, 100, (x, y) => [0.2 + 0.6 * y, 0.2 + 0.6 * y, 0.2 + 0.6 * y]),
    warm = photo(100, 100, (x, y) => [0.25 + 0.6 * y, 0.2 + 0.6 * y, 0.12 + 0.6 * y]),
    m1 = measure(grey, 100, 100),
    m2 = measure(warm, 100, 100),
    i = (50 * 100 + 50) * 4,
    warmth = (s) => {
      const o = applyLut(new Uint8ClampedArray(grey), buildLut(m1, m2, s));
      return o[i] - o[i + 2];
    };
  assert.ok(warmth(1.5) > warmth(1) + 2, `100%: ${warmth(1)}, 150%: ${warmth(1.5)}`);
});
