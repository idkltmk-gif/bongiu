// Copy the look: give a photo the colour grade of a reference photo. Pure, no DOM; tested in tests/look.test.mjs.
//
// A grade is what a camera profile or a film stock does to every photo, whatever is in it:
//  1) a tone curve (how dark the blacks are, how bright the whites, how soft the contrast),
//  2) a tint per tone: the colour that neutral things take in shadows, mid-tones and highlights,
//  3) how saturated colours are.
// Each is measured on both photos in Oklab (a perceptual colour space), so that the target keeps its own content
// (its blue sky stays blue) and only takes the reference's grade. Tints come from near-neutral pixels only:
// a white wall or a grey road shows the grade, a blue sky shows the sky.
// The result is a 3D lookup table, so applying it costs the same for a 12 MP photo as any colour filter.

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const enc = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

// 0–1 encoded RGB → Oklab [L, a, b]
export function toLab(r, g, b) {
  r = lin(r);
  g = lin(g);
  b = lin(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b),
    m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b),
    s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
// Oklab → 0–1 encoded RGB (out of gamut is clipped, keeping the hue by pulling chroma in first)
export function fromLab(L, a, b) {
  for (let k = 0; k < 8; k++) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3,
      m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
      s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
    const out = r < -0.002 || g < -0.002 || bl < -0.002 || r > 1.002 || g > 1.002 || bl > 1.002;
    if (!out || k === 7) return [enc(clamp(r, 0, 1)), enc(clamp(g, 0, 1)), enc(clamp(bl, 0, 1))];
    a *= 0.85;
    b *= 0.85;
  }
}

const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
// weight of shadows / mid-tones / highlights at lightness L (sums to 1)
const bands = (L) => {
  const t = clamp((L - 0.15) / 0.75, 0, 1);
  return [(1 - t) * (1 - t), 2 * t * (1 - t), t * t];
};
// skin: warm hues at moderate chroma. Oklab hue of skin is about 35°–80°.
const skinOf = (a, b) => {
  const C = Math.hypot(a, b);
  if (C < 0.02 || C > 0.17) return 0;
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return smooth(20, 40, h) * (1 - smooth(75, 95, h)) * smooth(0.02, 0.035, C) * (1 - smooth(0.13, 0.17, C));
};

const QS = [0.01, 0.05, 0.15, 0.3, 0.5, 0.7, 0.85, 0.95, 0.99];

// Measures a photo's grade from RGBA pixels (a preview is enough; up to ~250k pixels are sampled).
export function measure(px, w, h) {
  const n = w * h,
    step = Math.max(1, Math.floor(Math.sqrt(n / 250000)));
  const hist = new Float64Array(1001),
    tint = [0, 0, 0].map(() => ({ a: 0, b: 0, w: 0 })),
    all = { a: 0, b: 0, w: 0 };
  // chroma histogram: how strong the photo's strongest colours get. A mean would mostly count how much grey
  // road or white wall is in the picture, not how saturated the grade is.
  const cHist = new Float64Array(401);
  let cW = 0,
    count = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      const [L, a, b] = toLab(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255);
      hist[Math.round(clamp(L, 0, 1) * 1000)]++;
      count++;
      const C = Math.hypot(a, b);
      // near-neutral pixels show the grade's tint; clipped whites and blacks show nothing
      const nw = (1 - smooth(0.025, 0.06, C)) * smooth(0.04, 0.1, L) * (1 - smooth(0.93, 0.985, L));
      if (nw > 0) {
        const bw = bands(L);
        for (let k = 0; k < 3; k++) {
          const ww = nw * bw[k];
          tint[k].a += a * ww;
          tint[k].b += b * ww;
          tint[k].w += ww;
        }
        all.a += a * nw;
        all.b += b * nw;
        all.w += nw;
      }
      if (L > 0.2 && L < 0.92) {
        cHist[Math.min(400, Math.round(C * 1000))]++;
        cW++;
      }
    }
  }
  // lightness at each quantile
  const q = [];
  let acc = 0,
    j = 0;
  for (let k = 0; k <= 1000 && j < QS.length; k++) {
    acc += hist[k];
    while (j < QS.length && acc >= QS[j] * count) q[j++] = k / 1000;
  }
  while (j < QS.length) q[j++] = 1;
  const g = all.w > 1 ? { a: all.a / all.w, b: all.b / all.w } : { a: 0, b: 0 };
  // a band with few neutral pixels leans on the photo's overall neutral tint
  const tints = tint.map((t) => {
    const k = t.w / (t.w + count * 0.004);
    return t.w > 0 ? { a: (t.a / t.w) * k + g.a * (1 - k), b: (t.b / t.w) * k + g.b * (1 - k) } : g;
  });
  let chroma = 0.08;
  if (cW) {
    let c = 0,
      k = 0;
    while (k < 400 && c + cHist[k] < cW * 0.9) c += cHist[k++];
    chroma = Math.max(0.01, k / 1000);
  }
  return { q, tints, chroma, neutral: all.w / count };
}

// Monotone tone curve taking the target's lightness quantiles to the reference's, softened.
// The ends of the curve carry the grade (faded blacks, soft whites) and are copied closely; the middle mostly says
// what is in the photo (a dark jacket, a bright beach), so it moves only a little.
const PULL = [0.8, 0.6, 0.3, 0.25, 0.25, 0.25, 0.3, 0.6, 0.8],
  LIMIT = [0.08, 0.06, 0.035, 0.03, 0.035, 0.04, 0.05, 0.07, 0.08];
function toneCurve(src, ref) {
  const xs = [0, ...src.q, 1],
    ys = [0, ...ref.q.map((v, i) => src.q[i] + clamp((v - src.q[i]) * PULL[i], -LIMIT[i], LIMIT[i])), 1];
  for (let i = 1; i < xs.length; i++) if (xs[i] <= xs[i - 1]) xs[i] = xs[i - 1] + 1e-4;
  for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1]);
  return (L) => {
    if (L <= 0) return L;
    if (L >= 1) return L;
    let i = 1;
    while (i < xs.length - 1 && xs[i] < L) i++;
    const t = (L - xs[i - 1]) / (xs[i] - xs[i - 1] || 1);
    // limit the slope so a very different scene does not get crushed or blown out
    const y = ys[i - 1] + (ys[i] - ys[i - 1]) * t;
    return clamp(y, L * 0.55, L * 1.6 + 0.04);
  };
}

export const LUT_N = 33;

// Builds the grade as a LUT_N³ table of encoded RGB (Float32, 0–1, red fastest).
// strength 0–1.5: 0 = untouched, 1 = the grade as measured, above 1 = pushed further in the same direction. Skin keeps its hue and gets only part of the tint.
export function buildLut(src, ref, strength = 1) {
  const N = LUT_N,
    lut = new Float32Array(N * N * N * 3),
    s = clamp(strength, 0, 1.5);
  const curve = toneCurve(src, ref);
  const sat = clamp((ref.chroma / Math.max(src.chroma, 0.01)) ** 0.75, 0.7, 1.35);
  // tint per band: remove the target's own cast, add the reference's (each capped)
  const cap = (v) => clamp(v, -0.05, 0.05);
  const shift = ref.tints.map((t, k) => ({
    a: cap(t.a) - cap(src.tints[k].a) * 0.8,
    b: cap(t.b) - cap(src.tints[k].b) * 0.8,
  }));
  let o = 0;
  for (let bi = 0; bi < N; bi++)
    for (let gi = 0; gi < N; gi++)
      for (let ri = 0; ri < N; ri++, o += 3) {
        const [L, a, b] = toLab(ri / (N - 1), gi / (N - 1), bi / (N - 1));
        const skin = skinOf(a, b),
          bw = bands(L);
        // faces keep most of their brightness: a reference full of deep shadows should not darken a face
        let L2 = L + (curve(L) - L) * (1 - 0.6 * skin);
        let da = 0,
          db = 0;
        for (let k = 0; k < 3; k++) {
          da += shift[k].a * bw[k];
          db += shift[k].b * bw[k];
        }
        // pale and dark colours carry the tint fully; strong colours less, so they keep their own hue
        const C = Math.hypot(a, b),
          carry = 1 - 0.5 * smooth(0.04, 0.15, C);
        const k = carry * (1 - 0.6 * skin);
        const sk = 1 + (sat - 1) * (1 - 0.5 * skin);
        let a2 = a * sk + da * k,
          b2 = b * sk + db * k;
        // blend with the original by strength
        L2 = L + (L2 - L) * s;
        a2 = a + (a2 - a) * s;
        b2 = b + (b2 - b) * s;
        const rgb = fromLab(L2, a2, b2);
        lut[o] = rgb[0];
        lut[o + 1] = rgb[1];
        lut[o + 2] = rgb[2];
      }
  return lut;
}

// Applies the table to RGBA pixels in place (trilinear), alpha untouched.
export function applyLut(px, lut, N = LUT_N) {
  const M = N - 1,
    f = M / 255,
    NN = N * N;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i] * f,
      g = px[i + 1] * f,
      b = px[i + 2] * f;
    const r0 = r | 0,
      g0 = g | 0,
      b0 = b | 0;
    const r1 = r0 < M ? r0 + 1 : M,
      g1 = g0 < M ? g0 + 1 : M,
      b1 = b0 < M ? b0 + 1 : M;
    const fr = r - r0,
      fg = g - g0,
      fb = b - b0;
    const i000 = (b0 * NN + g0 * N + r0) * 3,
      i100 = (b0 * NN + g0 * N + r1) * 3,
      i010 = (b0 * NN + g1 * N + r0) * 3,
      i110 = (b0 * NN + g1 * N + r1) * 3,
      i001 = (b1 * NN + g0 * N + r0) * 3,
      i101 = (b1 * NN + g0 * N + r1) * 3,
      i011 = (b1 * NN + g1 * N + r0) * 3,
      i111 = (b1 * NN + g1 * N + r1) * 3;
    for (let c = 0; c < 3; c++) {
      const c00 = lut[i000 + c] + (lut[i100 + c] - lut[i000 + c]) * fr,
        c10 = lut[i010 + c] + (lut[i110 + c] - lut[i010 + c]) * fr,
        c01 = lut[i001 + c] + (lut[i101 + c] - lut[i001 + c]) * fr,
        c11 = lut[i011 + c] + (lut[i111 + c] - lut[i011 + c]) * fr;
      const c0 = c00 + (c10 - c00) * fg,
        c1 = c01 + (c11 - c01) * fg;
      px[i + c] = (c0 + (c1 - c0) * fb) * 255 + 0.5;
    }
  }
  return px;
}
