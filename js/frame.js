// Even out a set: which subject each photo uses, and the crop that gives every photo the reference's
// subject size and position. Pure functions of a photo set { photos, refId, ratio, zoom } (no DOM),
// so they run in Node for tests (tests/frame.test.mjs).
//
// A photo here needs: { id, W, H, est: { faces, poses, objects }, pick, manual }.
// A subject is { cx, cy, h, kind: "head" | "object", w? } in original pixels.

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// [value, label, width / height]; 0 = the reference's own shape
export const RATIOS = [
  ["orig", "Orig", 0],
  ["4:5", "4:5", 0.8],
  ["1:1", "1:1", 1],
  ["3:4", "3:4", 0.75],
  ["9:16", "9:16", 0.5625],
  ["3:2", "3:2", 1.5],
  ["16:9", "16:9", 1.7778],
];

export const refOf = (set) => set.photos.find((p) => p.id === set.refId);

// detected subjects of one kind, best kind first: faces, then body poses, then objects
export const cands = (p) => (p.est.faces.length ? p.est.faces : p.est.poses.length ? p.est.poses : p.est.objects);

const leftToRight = (list) => list.map((_, i) => i).sort((a, b) => list[a].cx - list[b].cx);

// Index of the subject this photo uses. Automatic: the same person as on the reference, found by the
// same place in left-to-right order, but only when both photos have the same head count.
export function pickIdx(set, p) {
  const list = cands(p);
  if (list.length < 2) return 0;
  if (p.pick !== null) return clamp(p.pick, 0, list.length - 1);
  const ref = refOf(set);
  if (ref && ref !== p) {
    const refList = cands(ref);
    if (refList.length === list.length) return leftToRight(list)[leftToRight(refList).indexOf(pickIdx(set, ref))];
  }
  return 0;
}

const faceOf = (set, p) => p.est.faces[pickIdx(set, p)] || null;

// the body pose closest to the chosen face (or the chosen pose when there is no face)
function poseOf(set, p) {
  const poses = p.est.poses;
  if (!poses.length) return null;
  const f = faceOf(set, p);
  if (!f) return poses[pickIdx(set, p)] || poses[0];
  const dist = (c) => Math.hypot(c.cx - f.cx, c.cy - f.cy);
  return poses.reduce((a, c) => (dist(c) < dist(a) ? c : a));
}

const objectOf = (set, p) => (p.est.faces.length || p.est.poses.length ? null : p.est.objects[pickIdx(set, p)] || null);

// How a body-based head estimate compares with a real face box: the median ratio over photos that have both.
function calibration(set) {
  const r = set.photos
    .map((p) => [faceOf(set, p), poseOf(set, p)])
    .filter(([f, q]) => f && q)
    .map(([f, q]) => f.h / q.h)
    .sort((a, b) => a - b);
  return r.length ? r[r.length >> 1] : null;
}

// One measuring rule for the whole set, so every photo is measured the same way:
// face boxes if every photo has one, else faces or calibrated poses, else objects, else whatever each photo has.
export function mode(set) {
  const ps = set.photos;
  if (ps.every((p) => faceOf(set, p))) return { m: "face" };
  if (ps.every((p) => faceOf(set, p) || poseOf(set, p))) {
    const k = calibration(set);
    return k === null && ps.every((p) => poseOf(set, p)) ? { m: "pose" } : { m: "person", k: k ?? 1 };
  }
  if (ps.every((p) => objectOf(set, p))) return { m: "object" };
  return { m: "mixed", k: calibration(set) ?? 1 };
}

// the detected subject for this photo under the set's measuring rule, or null
export function auto(set, p, md = mode(set)) {
  const f = faceOf(set, p);
  const q = poseOf(set, p);
  const scaledPose = q && { ...q, h: q.h * (md.k ?? 1) };
  if (md.m === "face") return f;
  if (md.m === "pose") return q;
  if (md.m === "person") return f || scaledPose;
  if (md.m === "object") return objectOf(set, p);
  return f || scaledPose || objectOf(set, p);
}

// where a head usually is when nothing was found
export const fallback = (p) => ({ cx: p.W / 2, cy: p.H * 0.38, h: Math.min(p.W, p.H) * 0.14, kind: "head" });
export const subj = (set, p, md) => p.manual || auto(set, p, md) || fallback(p);
export const missing = (set, p, md) => !p.manual && !auto(set, p, md);

export function aspect(set) {
  const r = RATIOS.find((x) => x[0] === set.ratio);
  const ref = refOf(set);
  return r[2] || ref.W / ref.H;
}

// Copy the reference's subject size and position into every photo.
// Size always matches exactly. Position matches too, unless a photo runs out of picture:
// then that photo alone slides back inside (never a blurred fill, never zooming the whole set for it).
// zoom: 1 = the reference's own framing; fit > 1 only when a subject is too big for its own photo at that size.
// Returns crops in original pixels, keyed by photo id; shift = how far a crop had to slide, as a share of its size.
export function layout(set) {
  const md = mode(set);
  const a = aspect(set);
  const ref = refOf(set);
  const r0 = subj(set, ref, md);
  const ch0 = Math.min(ref.H, ref.W / a);
  const cw0 = ch0 * a;
  const x0 = (ref.W - cw0) / 2;
  const y0 = (ref.H - ch0) / 2;
  const tx = clamp((r0.cx - x0) / cw0, 0.05, 0.95);
  const ty = clamp((r0.cy - y0) / ch0, 0.05, 0.95);
  const base = r0.h / ch0;
  const subs = new Map();
  let fit = 1;
  let limiter = -1;
  set.photos.forEach((p, i) => {
    const s = subj(set, p, md);
    const v = s.h / Math.min(p.H, p.W / a) / base;
    subs.set(p.id, s);
    if (v > fit * 1.001) {
      fit = v;
      limiter = i;
    }
  });
  const zoom = Math.max(fit, set.zoom ?? fit);
  const r = base * zoom;
  const crops = new Map();
  set.photos.forEach((p) => {
    const s = subs.get(p.id);
    const h = Math.min(p.H, s.h / r);
    const w = Math.min(p.W, h * a);
    const ix = s.cx - tx * w;
    const iy = s.cy - ty * h;
    const x = clamp(ix, 0, Math.max(0, p.W - w));
    const y = clamp(iy, 0, Math.max(0, p.H - h));
    crops.set(p.id, { x, y, w, h, shift: Math.hypot((x - ix) / w, (y - iy) / h) });
  });
  return { md, a, tx, ty, r, zoom, fit, crops, limiter };
}

// the largest crop of this shape, centred
export const centerCrop = (p, a) => {
  const h = Math.min(p.H, p.W / a);
  const w = h * a;
  return { x: (p.W - w) / 2, y: (p.H - h) / 2, w, h };
};
