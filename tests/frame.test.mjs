// Framing math for Even out a set. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { layout, pickIdx, mode, missing, subj } from "../js/frame.js";

const head = (cx, cy, h) => ({ cx, cy, h, kind: "head" });
let nextId = 1;
const photo = (W, H, { faces = [], poses = [], objects = [] } = {}) => ({
  id: nextId++,
  W,
  H,
  est: { faces, poses, objects },
  pick: null,
  manual: null,
});
const setOf = (photos, extra = {}) => ({ photos, refId: photos[0].id, ratio: "4:5", zoom: null, ...extra });
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

// where the subject sits inside a crop, as shares of the crop
const placed = (p, c, s) => ({ x: (s.cx - c.x) / c.w, y: (s.cy - c.y) / c.h, size: s.h / c.h });

test("every photo gets the reference's subject size and position", () => {
  const ref = photo(3000, 4000, { faces: [head(1500, 1400, 500)] });
  const far = photo(3000, 4000, { faces: [head(1200, 1600, 250)] }); // subject half as big, elsewhere
  const set = setOf([ref, far]);
  const lay = layout(set);
  const a = placed(ref, lay.crops.get(ref.id), ref.est.faces[0]);
  const b = placed(far, lay.crops.get(far.id), far.est.faces[0]);
  near(a.size, b.size);
  near(a.x, b.x);
  near(a.y, b.y);
  near(lay.crops.get(far.id).shift, 0);
});

test("crops have the chosen frame shape", () => {
  const ref = photo(3000, 4000, { faces: [head(1500, 1400, 500)] });
  const other = photo(4000, 3000, { faces: [head(2000, 1200, 400)] });
  for (const [ratio, a] of [
    ["4:5", 0.8],
    ["1:1", 1],
    ["16:9", 1.7778],
  ]) {
    const lay = layout(setOf([ref, other], { ratio }));
    for (const c of lay.crops.values()) near(c.w / c.h, a, 1e-3);
  }
});

test("a photo that runs out of picture slides back inside on its own, size still matches", () => {
  const ref = photo(3000, 4000, { faces: [head(1500, 1400, 500)] });
  const edge = photo(3000, 4000, { faces: [head(150, 1400, 250)] }); // subject at the left edge
  const lay = layout(setOf([ref, edge]));
  const c = lay.crops.get(edge.id);
  assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= edge.W + 1e-6 && c.y + c.h <= edge.H + 1e-6, "crop stays inside");
  assert.ok(c.shift > 0.02, "shift is reported");
  near(placed(edge, c, edge.est.faces[0]).size, placed(ref, lay.crops.get(ref.id), ref.est.faces[0]).size);
  near(lay.zoom, 1); // the rest of the set is not zoomed for it
});

test("a subject too big for its own photo zooms the whole set and names that photo", () => {
  const ref = photo(3000, 4000, { faces: [head(1500, 1400, 200)] });
  const close = photo(3000, 4000, { faces: [head(1500, 1400, 1500)] });
  const lay = layout(setOf([ref, close]));
  assert.ok(lay.fit > 1);
  assert.equal(lay.limiter, 1);
  near(lay.zoom, lay.fit);
});

test("zoom below the tightest fit is ignored", () => {
  const ref = photo(3000, 4000, { faces: [head(1500, 1400, 500)] });
  const other = photo(3000, 4000, { faces: [head(1500, 1400, 400)] });
  assert.equal(layout(setOf([ref, other], { zoom: 0.5 })).zoom, 1);
  near(layout(setOf([ref, other], { zoom: 1.5 })).zoom, 1.5);
});

test("same head count: the same person is picked by left-to-right place", () => {
  const ref = photo(3000, 2000, { faces: [head(2000, 800, 300), head(800, 800, 250)] });
  ref.pick = 1; // the person on the left
  const other = photo(3000, 2000, { faces: [head(900, 900, 320), head(2100, 900, 260)] }); // left one is listed first here
  const set = setOf([ref, other]);
  assert.equal(pickIdx(set, other), 0);
});

test("different head count: falls back to the largest subject", () => {
  const ref = photo(3000, 2000, { faces: [head(2000, 800, 300), head(800, 800, 250)] });
  ref.pick = 1;
  const other = photo(3000, 2000, { faces: [head(900, 900, 320), head(2100, 900, 260), head(1500, 900, 100)] });
  assert.equal(pickIdx(setOf([ref, other]), other), 0);
});

test("faces in every photo: measured by face; a photo without a subject is flagged and gets a fallback", () => {
  const a = photo(3000, 4000, { faces: [head(1500, 1400, 500)] });
  const b = photo(3000, 4000, { faces: [head(1500, 1400, 400)] });
  assert.equal(mode(setOf([a, b])).m, "face");
  const none = photo(3000, 4000);
  const set = setOf([a, none]);
  assert.equal(missing(set, none), true);
  assert.equal(subj(set, none).kind, "head");
  const manual = { cx: 100, cy: 100, h: 50, kind: "head" };
  none.manual = manual;
  assert.equal(missing(set, none), false);
  assert.equal(subj(set, none), manual);
});

test("pose-only photos are calibrated against photos that have both a face and a pose", () => {
  const both = photo(3000, 4000, { faces: [head(1500, 1400, 500)], poses: [head(1500, 1400, 250)] }); // face = 2 × pose
  const poseOnly = photo(3000, 4000, { poses: [head(1500, 1400, 200)] });
  const set = setOf([both, poseOnly]);
  const md = mode(set);
  assert.equal(md.m, "person");
  near(md.k, 2);
  near(subj(set, poseOnly, md).h, 400);
});
