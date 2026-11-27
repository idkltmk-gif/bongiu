// bôngiu🤍 app: the three tools (Even out a set, Copy the look, Remove people & objects), their screens, gestures and saving.
// Framing math is in frame.js, colour grade copy in look.js, date-taken EXIF in exif.js; all pure and tested in tests/.
import {
  clamp,
  RATIOS,
  refOf,
  cands,
  pickIdx,
  mode,
  auto,
  fallback,
  subj,
  missing,
  layout,
  centerCrop,
} from "./frame.js";
import { readDate, withExif, dateMs } from "./exif.js";
import { measure, buildLut, applyLut } from "./look.js";

const $ = (id) => document.getElementById(id);
const DETECT = 768,
  MID = 1200,
  MAX_AREA = 16_000_000,
  IG = 1080;
const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

// zoom: null = the reference's own framing (or the tightest zoom every photo allows)
// save: progress of a batched save { sig, next, files } — dropped as soon as anything that changes the output changes
// app: null = home, "align" = Even out a set, "look" = Copy the look, "remove" = Remove people & objects.
// look: strength of Copy the look, 0–1.5 (1 = as measured), shared by every photo. Each tool keeps its own photos (sets).
const state = {
  app: null,
  photos: [],
  refId: null,
  selId: null,
  ratio: "4:5",
  zoom: null,
  cmp: "ref",
  quality: "best",
  fmt: "image/jpeg",
  guides: true,
  editing: false,
  lay: null,
  nextId: 1,
  save: null,
  status: "Loading detection…",
  look: 1,
};
const BATCH_BYTES = 120e6;
const SET = ["photos", "refId", "selId", "zoom", "save", "lay"],
  sets = {};
const fresh = () => ({ photos: [], refId: null, selId: null, zoom: null, save: null, lay: null });
function enter(app) {
  state.app = app;
  Object.assign(state, sets[app] || fresh());
  render();
  if (app === "remove" && state.photos.length) warmEraser();
}
function goHome() {
  if (rm.busy) return toast("Wait for Remove to finish", 1800);
  sets[state.app] = Object.fromEntries(SET.map((k) => [k, state[k]]));
  Object.assign(state, fresh(), { app: null, editing: false });
  clearTimeout(toastT);
  $("toast").hidden = true;
  render();
}
const ref = () => refOf(state);
const sel = () => state.photos.find((p) => p.id === state.selId);
const idx = (p) => state.photos.indexOf(p);

const swOK = "serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost");
if (swOK) navigator.serviceWorker.register("sw.js").catch(() => {});
// The first visit loads the models before the service worker takes over; hand it the list so it keeps them (from the browser cache, no second download).
function keepOffline(extra = []) {
  if (!swOK) return;
  const files = [
    "index.html",
    "style.css",
    "js/app.js",
    "js/frame.js",
    "js/exif.js",
    "manifest.webmanifest",
    "apple-touch-icon.png",
    "icon-192.png",
    "mp/vision_bundle.mjs",
    "mp/vision_wasm_internal.js",
    "mp/vision_wasm_internal.wasm",
    "mp/face_detector.tflite",
    "mp/pose_landmarker_lite.task",
    ...extra,
  ];
  navigator.serviceWorker.ready
    .then((reg) => reg.active?.postMessage({ keep: files.map((f) => new URL(f, location.href).href) }))
    .catch(() => {});
}

/* ---------------- detection: faces, body poses, objects (only when no person) */
const base = new URL("mp/", location.href).href;
const fileset = {
  wasmLoaderPath: base + "vision_wasm_internal.js",
  wasmBinaryPath: base + "vision_wasm_internal.wasm",
};
let vision = null,
  faceDet = null,
  poseDet = null,
  objDet = null;
const ready = (async () => {
  try {
    vision = await import(base + "vision_bundle.mjs");
    [faceDet, poseDet] = await Promise.all([
      vision.FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: base + "face_detector.tflite", delegate: "CPU" },
        runningMode: "IMAGE",
        minDetectionConfidence: 0.45,
      }),
      vision.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: base + "pose_landmarker_lite.task", delegate: "CPU" },
        runningMode: "IMAGE",
        numPoses: 4,
      }).catch((e) => (console.warn(e), null)),
    ]);
    state.status = "";
    keepOffline();
  } catch (e) {
    console.warn(e);
    state.status = "Auto-detect unavailable. Place subjects by hand.";
  }
  if (!state.photos.length) render();
})();
async function objectDetector() {
  if (objDet || !vision) return objDet;
  try {
    objDet = await vision.ObjectDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: base + "object_detector.tflite", delegate: "CPU" },
      runningMode: "IMAGE",
      scoreThreshold: 0.35,
      maxResults: 5,
    });
  } catch (e) {
    console.warn(e);
  }
  if (objDet) keepOffline(["mp/object_detector.tflite"]);
  return objDet;
}
function sub(t) {
  $("sub").textContent = t;
}
let toastT = 0;
function toast(msg, ms = 2600, action) {
  const t = $("toast"),
    b = $("toastAct");
  $("toastMsg").textContent = msg;
  t.hidden = false;
  b.hidden = !action;
  if (action) {
    b.textContent = action.label;
    b.onclick = () => {
      t.hidden = true;
      action.fn();
    };
  }
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), ms);
}

function loadImg(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file),
      img = new Image();
    img.onload = () => res({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      rej(new Error(`Couldn't open ${file.name}`));
    };
    img.src = url;
  });
}
const release = ({ img, url }) => {
  img.src = "";
  URL.revokeObjectURL(url);
};
function scaled(src, W, H, long) {
  const s = Math.min(1, long / Math.max(W, H)),
    c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(W * s));
  c.height = Math.max(1, Math.round(H * s));
  const x = c.getContext("2d");
  x.imageSmoothingQuality = "high";
  x.drawImage(src, 0, 0, c.width, c.height);
  return { c, s };
}
const big = (arr) => {
  if (!arr.length) return arr;
  const m = arr[0].h;
  return arr.filter((d) => d.h >= m * 0.3);
};
async function makePhoto(file, find = true) {
  const loaded = await loadImg(file),
    { img } = loaded;
  const W = img.naturalWidth,
    H = img.naturalHeight,
    small = scaled(img, W, H, DETECT),
    mid = scaled(img, W, H, MID);
  release(loaded); // keep only small copies in memory; the full photo is decoded again at save time
  // pick: null = automatic (same person as on the reference when the head count matches)
  // mid0 = clean preview; mid = preview with removals applied; edits = removals in original pixel coordinates
  const p = {
    id: state.nextId++,
    file,
    name: file.name.replace(/\.[^.]+$/, "") || "photo",
    W,
    H,
    mid,
    mid0: mid,
    edits: [],
    thumb: "",
    date: await readDate(file),
    est: null,
    pick: null,
    manual: null,
  };
  p.thumb = thumbOf(p);
  p.est = find ? await detect(small.c, 1 / small.s) : { faces: [], poses: [], objects: [] };
  small.c.width = 0;
  return p;
}
const thumbOf = (p) => scaled(p.mid.c, p.mid.c.width, p.mid.c.height, 180).c.toDataURL("image/jpeg", 0.8);
async function detect(c, k) {
  const est = { faces: [], poses: [], objects: [] },
    breathe = () => new Promise((r) => setTimeout(r, 0)); // let the screen update between models
  await ready;
  await breathe();
  if (faceDet) {
    try {
      est.faces = big(
        (faceDet.detect(c).detections || [])
          .map(({ boundingBox: b }) => ({
            cx: (b.originX + b.width / 2) * k,
            cy: (b.originY + b.height / 2) * k,
            h: b.height * k,
            kind: "head",
          }))
          .sort((a, b) => b.h - a.h),
      );
    } catch (e) {
      console.warn(e);
    }
    await breathe();
  }
  if (poseDet) {
    try {
      const w = c.width * k,
        h = c.height * k;
      est.poses = big(
        (poseDet.detect(c).landmarks || [])
          .flatMap((lm) => {
            if ((lm[11].visibility ?? 1) < 0.3 || (lm[12].visibility ?? 1) < 0.3) return [];
            const nx = lm[0].x * w,
              ny = lm[0].y * h,
              sx = ((lm[11].x + lm[12].x) / 2) * w,
              sy = ((lm[11].y + lm[12].y) / 2) * h,
              d = Math.hypot(sx - nx, sy - ny);
            return d > 4 ? [{ cx: nx, cy: ny, h: d * 0.9, kind: "head" }] : []; // nose->shoulders ≈ 1.1 head boxes; calibrated against faces when possible
          })
          .sort((a, b) => b.h - a.h),
      );
    } catch (e) {
      console.warn(e);
    }
  }
  if (!est.faces.length && !est.poses.length) {
    const od = await objectDetector();
    if (od) {
      try {
        est.objects = big(
          (od.detect(c).detections || [])
            .filter((x) => x.categories?.[0]?.categoryName !== "person")
            .map(({ boundingBox: b }) => ({
              cx: (b.originX + b.width / 2) * k,
              cy: (b.originY + b.height / 2) * k,
              h: b.height * k,
              w: b.width * k,
              kind: "object",
            }))
            .sort((a, b) => b.h * b.w - a.h * a.w),
        );
      } catch (e) {
        console.warn(e);
      }
    }
  }
  return est;
}

/* ---------------- drawing (preview uses the 1600 px copy, save uses the original) */
function fitBox(a) {
  const st = $("stage"),
    W = st.clientWidth - 24,
    H = st.clientHeight - 16;
  let w = W,
    h = w / a;
  if (h > H) {
    h = H;
    w = h * a;
  }
  return [Math.max(40, Math.floor(w)), Math.max(40, Math.floor(h))];
}
function paint(p, c, canvas, w, h) {
  const d = Math.min(2, devicePixelRatio || 1);
  canvas.width = Math.round(w * d);
  canvas.height = Math.round(h * d);
  const x = canvas.getContext("2d"),
    s = p.mid.s;
  x.imageSmoothingQuality = "high";
  x.drawImage(p.mid.c, c.x * s, c.y * s, c.w * s, c.h * s, 0, 0, canvas.width, canvas.height);
}
let cmp = 0.5;
function setCmp(v) {
  cmp = clamp(v, 0, 1);
  $("cAfter").style.clipPath = `inset(0 0 0 ${cmp * 100}%)`;
  $("handle").style.left = cmp * 100 + "%";
}

function note(p, lay) {
  // one line, the most useful thing to know about this photo
  const c = lay.crops.get(p.id),
    n = cands(p).length;
  if (missing(state, p, lay.md)) return "No subject found. Tap Set subject.";
  if (p.id === state.refId)
    return lay.limiter >= 0 && lay.zoom <= lay.fit * 1.001
      ? `Zoomed in so photo ${lay.limiter + 1} fits`
      : "Other photos match this one";
  if (c.shift > 0.02) return `Moved ${Math.round(c.shift * 100)}% to stay inside the photo`;
  if (n > 1 && p.pick === null && !p.manual)
    return `${n} ${cands(p)[0].kind === "object" ? "objects" : "people"} found. Matching the reference.`;
  if (state.quality === "best" && c.w < IG) return `Low resolution: ${Math.round(c.w)} px wide`;
  return "";
}
function render() {
  const n = state.photos.length,
    R = ref(),
    ok = !!R && n > 1,
    p = sel(),
    app = state.app;
  $("home").hidden = !!app;
  $("app").classList.toggle("rm", app === "remove");
  $("lgroup").hidden = !app || !!state.editing;
  $("cancelBtn").hidden = !state.editing;
  $("saveBtn").hidden = !app || !!state.editing;
  $("doneBtn").hidden = !state.editing;
  if (!app) {
    $("title").textContent = "";
    sub("");
    for (const id of ["empty", "view", "eraser", "editor", "controls", "stripWrap"]) $(id).hidden = true;
    return;
  }
  $("lookRow").hidden = true;
  $("adjustBtn").hidden = app !== "align";
  if (app === "remove") return renderRemove();
  if (app === "look") return renderLook();
  steps("Pick the reference: the photo you like most", "Add the photos to fix", "Choose a frame, then Save");
  $("saveBtn").disabled = !ok;
  $("title").textContent = state.editing
    ? "Adjust subject"
    : ok && p
      ? p.id === state.refId
        ? "Reference"
        : `Photo ${idx(p) + 1} of ${n}`
      : "Even out a set";
  if (!ok) sub(state.status);
  $("empty").hidden = ok || state.editing;
  $("steps").hidden = false;
  $("emptyFine").textContent = "Photos stay on this device.";
  $("st1").className = R ? "done" : "";
  $("st2").className = n > 1 ? "done" : "";
  $("emptyH").textContent = R ? "Now add the photos to fix" : "Make a photo set look even";
  $("emptyP").textContent = R
    ? "Add one or more photos from the same set. They will match your reference."
    : "Every photo copies the subject size and position of your favourite one.";
  $("emptyCta").textContent = R ? "Add photos to fix" : "Choose reference photo";
  $("controls").hidden = !ok && !state.editing;
  $("stripWrap").hidden = !R;
  $("stripHint").hidden = n < 3 || state.editing || store.get("ef-reordered") === "1";
  $("ratios").hidden = $("zoomRow").hidden = !!state.editing;
  $("editRow").hidden = !state.editing;
  $("eraseRow").hidden = true;
  if (state.editing) {
    drawStrip();
    return drawEditor();
  }
  $("editor").hidden = $("eraser").hidden = true;
  $("view").hidden = !ok;
  if (!ok) {
    state.lay = null;
    drawStrip();
    syncSave();
    return;
  }
  drawRatios();
  stage();
}
function steps(...t) {
  t.forEach((x, i) => ($(`st${i + 1}`).lastElementChild.textContent = x));
}
// Copy the look: same set-up as Even out a set (a reference, then the photos to change), no framing
function renderLook() {
  const n = state.photos.length,
    R = ref(),
    ok = !!R && n > 1,
    p = sel();
  $("saveBtn").disabled = !ok;
  $("title").textContent =
    ok && p ? (p.id === state.refId ? "Reference" : `Photo ${idx(p) + 1} of ${n}`) : "Copy the look";
  $("empty").hidden = ok;
  $("steps").hidden = false;
  steps("Pick the reference: the photo whose colours you love", "Add the photos to change", "Set the strength, then Save");
  $("st1").className = R ? "done" : "";
  $("st2").className = n > 1 ? "done" : "";
  $("emptyH").textContent = R ? "Now add the photos to change" : "Copy a photo's look";
  $("emptyP").textContent = R
    ? "They take the colours and tones of your reference. What's in them stays the same."
    : "Pick a photo whose colours you love: a film shot, a friend's photo, a screenshot.";
  $("emptyCta").textContent = R ? "Add photos" : "Choose reference photo";
  $("emptyFine").textContent = "Photos stay on this device.";
  $("controls").hidden = !ok;
  $("stripWrap").hidden = !R;
  $("stripHint").hidden = true;
  $("ratios").hidden = $("zoomRow").hidden = $("editRow").hidden = $("eraseRow").hidden = true;
  $("lookRow").hidden = false;
  $("editor").hidden = $("eraser").hidden = true;
  $("view").hidden = !ok;
  state.lay = null;
  if (!ok) {
    sub("");
    drawStrip();
    syncSave();
    return;
  }
  stageLook();
}
const lookOf = (p) => {
  if (!p.look) {
    const c = p.mid.c;
    p.look = measure(c.getContext("2d").getImageData(0, 0, c.width, c.height).data, c.width, c.height);
  }
  return p.look;
};
let lutKey = "",
  lutVal = null;
function lutFor(p) {
  const R = ref(),
    key = `${p.id}:${R.id}:${state.look}`;
  if (key !== lutKey) {
    lutVal = buildLut(lookOf(p), lookOf(R), state.look);
    lutKey = key;
  }
  return lutVal;
}
// grades a canvas in place, a band of rows at a time so a 12 MP photo never needs a second full copy
function gradeCanvas(c, lut) {
  const x = c.getContext("2d"),
    band = Math.max(1, Math.floor(2_000_000 / c.width));
  for (let y = 0; y < c.height; y += band) {
    const h = Math.min(band, c.height - y),
      d = x.getImageData(0, y, c.width, h);
    applyLut(d.data, lut);
    x.putImageData(d, 0, y);
  }
}
// the reference, shown whole on top of this photo while held (it can have another shape)
function paintContain(p, canvas, w, h) {
  const d = Math.min(2, devicePixelRatio || 1);
  canvas.width = Math.round(w * d);
  canvas.height = Math.round(h * d);
  const x = canvas.getContext("2d"),
    k = Math.min(canvas.width / p.W, canvas.height / p.H),
    dw = p.W * k,
    dh = p.H * k;
  x.fillStyle = "#000";
  x.fillRect(0, 0, canvas.width, canvas.height);
  x.imageSmoothingQuality = "high";
  x.drawImage(p.mid.c, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
}
function stageLook() {
  const p = sel(),
    R = ref(),
    full = { x: 0, y: 0, w: p.W, h: p.H },
    [w, h] = fitBox(p.W / p.H),
    v = $("view");
  v.style.width = w + "px";
  v.style.height = h + "px";
  $("guides").innerHTML = "";
  paint(p, full, $("cAfter"), w, h);
  if (p.id === state.refId) {
    $("cAfter").style.clipPath = "none";
    $("handle").hidden = $("tagL").hidden = $("cBefore").hidden = $("cGhost").hidden = true;
    $("tagR").textContent = "Reference";
    sub("Other photos take this photo's look");
  } else {
    gradeCanvas($("cAfter"), lutFor(p));
    paint(p, full, $("cBefore"), w, h);
    paintContain(R, $("cGhost"), w, h);
    $("handle").hidden = $("tagL").hidden = $("cBefore").hidden = $("cGhost").hidden = false;
    $("tagL").firstElementChild.textContent = "Original";
    $("tagR").textContent = "New look";
    setCmp(cmp);
    sub("Drag across to compare. Hold to see the reference.");
  }
  $("tagL").classList.toggle("fixed", true);
  drawStrip();
  syncSave();
}
let lookRaf = 0;
function setLook(v) {
  state.look = clamp(Math.round(v) / 100, 0, 1.5);
  $("lookAmt").value = Math.round(state.look * 100);
  $("lookVal").textContent = `${Math.round(state.look * 100)}%`;
  cancelAnimationFrame(lookRaf);
  lookRaf = requestAnimationFrame(() => state.app === "look" && sel() && !$("view").hidden && stageLook());
}
$("lookAmt").oninput = () => setLook(+$("lookAmt").value);
$("lookLess").onclick = () => setLook(state.look * 100 - 10);
$("lookMore").onclick = () => setLook(state.look * 100 + 10);
// Remove: the photo under the brush fills the screen; the strip switches photos; removals stay until undone
function renderRemove() {
  const n = state.photos.length,
    p = sel();
  $("title").textContent = n > 1 ? `Photo ${idx(p) + 1} of ${n}` : "Remove";
  $("empty").hidden = !!n;
  $("steps").hidden = true;
  $("emptyH").textContent = "Remove people and objects";
  $("emptyP").textContent = "Tap what you don't want, or paint over it. The gap is filled from what's around it.";
  $("emptyCta").textContent = "Choose photos";
  $("emptyFine").textContent = "Photos stay on this device. The first use downloads about 45 MB.";
  $("view").hidden = $("editor").hidden = true;
  $("controls").hidden = $("stripWrap").hidden = !n;
  $("ratios").hidden = $("zoomRow").hidden = $("editRow").hidden = $("stripHint").hidden = true;
  $("eraseRow").hidden = !n;
  drawStrip();
  if (!n) {
    $("eraser").hidden = true;
    sub("");
    syncSave();
    return;
  }
  if (rm.pid !== p.id) {
    if (rm.pid !== null) rmZoomByPhoto.set(rm.pid, { ...rmZoom });
    setSel(null);
    Object.assign(rm, { pid: p.id, start: 0, hist: [], before: false });
    Object.assign(rmZoom, rmZoomByPhoto.get(p.id) || { s: 1, x: 0, y: 0 });
  }
  rm.ready = !!inpaint;
  drawEraser();
}
const targets = () =>
  state.app === "remove"
    ? state.photos.filter((p) => p.edits.length)
    : state.app === "look"
      ? state.photos.filter((p) => p.id !== state.refId)
      : state.photos;
const cropOf = (p, lay) => (state.app !== "align" ? { x: 0, y: 0, w: p.W, h: p.H } : lay.crops.get(p.id));
// anything that changes the saved files restarts a batched save
const span = (a, b) => (a === b ? `${a}` : `${a}–${b}`);
const signature = () =>
  JSON.stringify([
    state.ratio,
    state.lay?.zoom.toFixed(4),
    state.quality,
    state.fmt,
    state.refId,
    state.app === "look" && state.look,
    state.photos.map((p) => [p.id, p.pick, p.edits.length, p.manual && [p.manual.cx, p.manual.cy, p.manual.h]]),
  ]);
function syncSave() {
  if (state.save && state.save.sig !== signature()) state.save = null;
  const b = $("saveBtn"),
    n = targets().length;
  if (state.app === "remove" && !state.save?.files) b.disabled = !n;
  b.textContent = !state.save
    ? state.app === "remove" && n && state.photos.length > 1
      ? `Save ${n}`
      : "Save"
    : state.save.files
      ? "Tap to save"
      : `Save ${span(state.save.next + 1, n)}`;
}
function stage() {
  const lay = (state.lay = layout(state)),
    [w, h] = fitBox(lay.a),
    v = $("view"),
    p = sel(),
    isRef = p.id === state.refId;
  v.style.width = w + "px";
  v.style.height = h + "px";
  $("tagL").classList.remove("fixed");
  paint(p, lay.crops.get(p.id), $("cAfter"), w, h);
  if (isRef) {
    $("cAfter").style.clipPath = "none";
    $("handle").hidden = $("tagL").hidden = $("cBefore").hidden = $("cGhost").hidden = true;
    $("tagR").textContent = "Reference";
  } else {
    const R = ref(),
      rc = lay.crops.get(R.id);
    paint(R, rc, $("cGhost"), w, h);
    if (state.cmp === "ref") paint(R, rc, $("cBefore"), w, h);
    else paint(p, centerCrop(p, lay.a), $("cBefore"), w, h);
    $("handle").hidden = $("tagL").hidden = $("cBefore").hidden = $("cGhost").hidden = false;
    $("tagL").firstElementChild.textContent = state.cmp === "ref" ? "Reference" : "Original";
    $("tagR").textContent = state.cmp === "ref" ? `Photo ${idx(p) + 1}` : "Fixed";
    setCmp(cmp);
  }
  const g = $("guides");
  g.innerHTML = "";
  if (state.guides) {
    for (const y of [lay.ty - lay.r / 2, lay.ty + lay.r / 2]) {
      const d = document.createElement("div");
      d.className = "g";
      d.style.top = y * 100 + "%";
      g.appendChild(d);
    }
    const d = document.createElement("div");
    d.className = "g v";
    d.style.left = lay.tx * 100 + "%";
    g.appendChild(d);
  }
  const miss = missing(state, p, lay.md),
    a = $("adjustBtn");
  a.classList.toggle("warn", miss);
  a.classList.toggle("glass", !miss);
  a.lastElementChild.textContent = miss
    ? "Set subject"
    : cands(p).length > 1 && !p.manual
      ? "Choose subject"
      : "Adjust subject";
  const z = $("zoom"),
    zmax = Math.max(3, lay.fit * 1.5);
  z.min = lay.fit;
  z.max = zmax;
  z.value = lay.zoom;
  z.setAttribute(
    "aria-label",
    lay.fit > 1.001
      ? `Subject size. Far left is the tightest fit photo ${lay.limiter + 1} allows`
      : "Subject size. Far left matches the reference framing",
  );
  $("zoomOut").disabled = lay.zoom <= lay.fit * 1.001;
  $("zoomIn").disabled = lay.zoom >= zmax * 0.999;
  sub(note(p, lay));
  drawStrip();
  syncSave();
}

/* compare: drag sideways to move the divider; touch and hold to lay the reference over this photo (like holding in Photos) */
(() => {
  const el = $("view");
  let on = false,
    decided = false,
    ghost = false,
    sx = 0,
    sy = 0,
    t = 0;
  const at = (e) => {
    const r = el.getBoundingClientRect();
    setCmp((e.clientX - r.left) / r.width);
  };
  const setGhost = (v) => {
    ghost = v;
    el.classList.toggle("ghost", v);
    $("tagR").textContent = v
      ? "Reference on top"
      : state.app === "look"
        ? "New look"
        : state.cmp === "ref"
          ? `Photo ${idx(sel()) + 1}`
          : "Fixed";
  };
  const stop = () => {
    clearTimeout(t);
    on = false;
    if (ghost) setGhost(false);
  };
  el.addEventListener("pointerdown", (e) => {
    if (sel()?.id === state.refId || e.target.closest("button")) return;
    on = true;
    decided = false;
    sx = e.clientX;
    sy = e.clientY;
    if (e.pointerType !== "touch") el.setPointerCapture(e.pointerId);
    t = setTimeout(() => {
      if (on && !decided) {
        setGhost(true);
        navigator.vibrate?.(8);
      }
    }, 260);
  });
  el.addEventListener("pointermove", (e) => {
    if (!on || ghost) return;
    if (!decided) {
      const dx = Math.abs(e.clientX - sx),
        dy = Math.abs(e.clientY - sy);
      if (dx < 6 && dy < 6) return;
      clearTimeout(t);
      if (dy > dx) {
        on = false;
        return;
      }
      decided = true;
      el.setPointerCapture(e.pointerId);
    }
    at(e);
  });
  el.addEventListener("pointerup", (e) => {
    if (on && !decided && !ghost) at(e);
    stop();
  });
  el.addEventListener("pointercancel", stop);
  el.addEventListener("contextmenu", (e) => e.preventDefault());
})();
$("tagL").onclick = () => {
  if (state.app !== "align") return;
  state.cmp = state.cmp === "ref" ? "orig" : "ref";
  stage();
};

/* ---------------- ratios + zoom */
function drawRatios() {
  const box = $("ratios");
  box.innerHTML = "";
  for (const [v, label, r] of RATIOS) {
    const b = document.createElement("button");
    b.className = "ratio";
    b.setAttribute("aria-pressed", v === state.ratio);
    b.setAttribute("aria-label", v === "orig" ? "Original shape" : `${label} frame`);
    const a = r || ref().W / ref().H,
      M = 22,
      w = a >= 1 ? M : Math.round(M * a),
      h = a >= 1 ? Math.round(M / a) : M;
    const s = document.createElement("span");
    s.className = "shape" + (v === "orig" ? " orig" : "");
    s.style.width = w + "px";
    s.style.height = h + "px";
    const t = document.createElement("span");
    t.textContent = label;
    b.append(s, t);
    b.onclick = () => {
      state.ratio = v;
      state.zoom = null;
      render();
    };
    box.appendChild(b);
  }
}
let raf = 0;
const later = () => {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(stage);
};
const curZoom = () => state.lay?.zoom ?? 1;
$("zoom").oninput = () => {
  state.zoom = +$("zoom").value;
  later();
};
$("zoomOut").onclick = () => {
  state.zoom = curZoom() - 0.05;
  later();
}; // layout() never goes below the reference framing
$("zoomIn").onclick = () => {
  state.zoom = Math.min(+$("zoom").max, curZoom() + 0.05);
  later();
};

/* ---------------- strip: tap to view, × to remove (with undo), hold and drag to reorder */
function drawStrip() {
  const s = $("strip"),
    al = state.app === "align",
    md = al && state.photos.length ? mode(state) : null;
  s.innerHTML = "";
  state.photos.forEach((p, i) => {
    const b = document.createElement("div");
    b.className = "th" + (p.id === state.selId ? " on" : "");
    b.dataset.id = p.id;
    b.setAttribute("role", "button");
    b.tabIndex = 0;
    b.setAttribute("aria-label", (p.id === state.refId ? "Reference, " : "") + `photo ${i + 1}`);
    const im = document.createElement("img");
    im.src = p.thumb;
    im.alt = "";
    b.appendChild(im);
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = i + 1;
    b.appendChild(n);
    if (p.id === state.refId) {
      const r = document.createElement("span");
      r.className = "lbl ref";
      r.textContent = "REF";
      b.appendChild(r);
    } else if (!al && p.edits.length) {
      const r = document.createElement("span");
      r.className = "lbl ed";
      r.textContent = "EDITED";
      b.appendChild(r);
      b.setAttribute("aria-label", b.getAttribute("aria-label") + ", edited");
    }
    const isSel = p.id === state.selId && p.id !== state.refId && !state.editing;
    const c = al && state.lay?.crops.get(p.id),
      check = c && p.id !== state.refId && (c.shift > 0.02 || (state.quality === "best" && c.w < IG));
    if (al && missing(state, p, md) && !isSel) {
      const m = document.createElement("span");
      m.className = "miss";
      m.textContent = "!";
      b.appendChild(m);
    } else if (check && !isSel) {
      const m = document.createElement("span");
      m.className = "dot";
      b.appendChild(m);
      b.setAttribute("aria-label", b.getAttribute("aria-label") + ", has a note");
    }
    if (p.id === state.refId && state.app !== "remove" && !state.editing) {
      // one tap on the reference's thumbnail icon picks a new reference
      // (Copy the look replaces the old one; in Even out a set the old one stays as a photo of the set)
      const sw = document.createElement("button");
      sw.className = "swap";
      sw.setAttribute("aria-label", "Change reference");
      sw.innerHTML = `<svg class="i" viewBox="0 0 24 24"><path d="M4 9a8 8 0 0 1 14-3l2 2M20 4v4h-4M20 15a8 8 0 0 1-14 3l-2-2M4 20v-4h4"/></svg>`;
      sw.onclick = (e) => {
        e.stopPropagation();
        if (!rm.busy) $("refFile").click();
      };
      b.appendChild(sw);
    } else if (isSel) {
      const x = document.createElement("button");
      x.className = "x";
      x.setAttribute("aria-label", `Remove photo ${i + 1}`);
      x.innerHTML = `<svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
      x.onclick = (e) => {
        e.stopPropagation();
        removePhoto(p);
      };
      b.appendChild(x);
    }
    b.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        state.selId = p.id;
        render();
      }
    };
    s.appendChild(b);
  });
  const needRef = state.app !== "remove";
  if ((needRef ? state.refId : state.photos.length) && !state.editing) {
    const add = document.createElement("button");
    add.className = "th add";
    add.setAttribute("aria-label", al ? "Add photos to fix" : "Add photos");
    add.innerHTML = `<svg class="i" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>`;
    add.onclick = () => {
      if (!rm.busy) $(needRef ? "moreFile" : "rmFile").click();
    };
    s.appendChild(add);
  }
}
function removePhoto(p) {
  const i = idx(p);
  state.photos.splice(i, 1);
  state.selId = (state.photos[Math.max(0, i - 1)] || {}).id ?? null;
  render();
  toast(`Photo ${i + 1} removed`, 5000, {
    label: "Undo",
    fn: () => {
      state.photos.splice(i, 0, p);
      state.selId = p.id;
      render();
    },
  });
}
(() => {
  // long-press reorder (touch + mouse); a quick tap selects
  const strip = $("strip");
  let t = 0,
    item = null,
    dragging = false,
    sx = 0,
    sy = 0,
    moved = false;
  const start = (x, y, target) => {
    item = target.closest(".th:not(.add)");
    if (!item || target.closest(".x, .swap") || state.editing || rm.busy) {
      item = null;
      return;
    }
    sx = x;
    sy = y;
    moved = false;
    dragging = false;
    t = setTimeout(() => {
      dragging = true;
      item.classList.add("lift");
      navigator.vibrate?.(10);
    }, 380);
  };
  const move = (x, y, e) => {
    if (!item) return;
    if (!dragging) {
      if (Math.abs(x - sx) > 8 || Math.abs(y - sy) > 8) {
        clearTimeout(t);
        moved = true;
        item = null;
      }
      return;
    }
    e.preventDefault();
    const els = [...strip.querySelectorAll(".th:not(.add)")],
      id = +item.dataset.id;
    const to = els.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return x < r.left + r.width / 2;
    });
    const from = state.photos.findIndex((p) => p.id === id),
      dest = to === -1 ? state.photos.length - 1 : to > from ? to - 1 : to;
    if (dest !== from) {
      const [p] = state.photos.splice(from, 1);
      state.photos.splice(dest, 0, p);
      drawStrip();
      item = strip.querySelector(`.th[data-id="${id}"]`);
      item.classList.add("lift");
    }
  };
  const end = () => {
    clearTimeout(t);
    if (item && !dragging && !moved) {
      state.selId = +item.dataset.id;
      render();
    } else if (dragging) {
      store.set("ef-reordered", "1");
      render();
      toast("Order updated. Photos save in this order.", 1800);
    }
    item = null;
    dragging = false;
  };
  strip.addEventListener("touchstart", (e) => start(e.touches[0].clientX, e.touches[0].clientY, e.target), {
    passive: true,
  });
  strip.addEventListener("touchmove", (e) => move(e.touches[0].clientX, e.touches[0].clientY, e), { passive: false });
  strip.addEventListener("touchend", end);
  strip.addEventListener("touchcancel", () => {
    clearTimeout(t);
    item = null;
    dragging = false;
    render();
  });
  strip.addEventListener("mousedown", (e) => start(e.clientX, e.clientY, e.target));
  window.addEventListener("mousemove", (e) => move(e.clientX, e.clientY, e));
  window.addEventListener("mouseup", () => {
    if (item) end();
  });
})();

/* ---------------- subject editor: drag the ring, or tap another detected person */
let edSnap = null;
function openEditor() {
  const p = sel();
  edSnap = { manual: p.manual, pick: p.pick };
  state.editing = "subject";
  render();
}
function drawEditor() {
  const p = sel(),
    ed = $("editor"),
    cv = $("edCan"),
    s = subj(state, p),
    box = $("edBox");
  $("view").hidden = $("eraser").hidden = true;
  ed.hidden = false;
  const [w, h] = fitBox(p.W / p.H),
    key = p.id + ":" + w;
  ed.style.width = w + "px";
  ed.style.height = h + "px";
  cv.style.width = w + "px";
  cv.style.height = h + "px";
  if (cv.dataset.key !== key) {
    const d = Math.min(2, devicePixelRatio || 1);
    cv.width = Math.round(w * d);
    cv.height = Math.round(h * d);
    const x = cv.getContext("2d");
    x.imageSmoothingQuality = "high";
    x.drawImage(p.mid.c, 0, 0, cv.width, cv.height);
    cv.dataset.key = key;
  }
  const k = w / p.W,
    isObj = s.kind === "object";
  const place = (el, c) => {
    const ch = c.h * k,
      cw = c.kind === "object" ? (c.w || c.h) * k : ch;
    el.style.width = cw + "px";
    el.style.height = ch + "px";
    el.style.left = c.cx * k - cw / 2 + "px";
    el.style.top = c.cy * k - ch / 2 + "px";
  };
  box.classList.toggle("head", !isObj);
  place(box, s);
  const list = cands(p),
    cl = $("edCands");
  cl.innerHTML = "";
  if (list.length > 1)
    list.forEach((c, i) => {
      if (!p.manual && i === pickIdx(state, p)) return;
      const b = document.createElement("button");
      b.className = "cand" + (c.kind === "object" ? " obj" : "");
      b.setAttribute("aria-label", `Use ${c.kind === "object" ? "object" : "person"} ${i + 1}`);
      place(b, c);
      b.onclick = () => {
        p.pick = i;
        p.manual = null;
        drawEditor();
      };
      cl.appendChild(b);
    });
  $("editHint").textContent =
    list.length > 1
      ? `Tap a dashed ring to switch ${isObj ? "object" : "person"}, or drag.`
      : isObj
        ? "Drag onto the subject. The dot resizes."
        : "Drag onto the head. The dot resizes.";
  $("edReset").hidden = !auto(state, p) || !p.manual;
}
(() => {
  let drag = null,
    sx = 0,
    sy = 0,
    f0 = null;
  const down = (m) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    drag = m;
    sx = e.clientX;
    sy = e.clientY;
    f0 = { ...subj(state, sel()) };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e) => {
    if (!drag) return;
    const p = sel(),
      k = $("editor").clientWidth / p.W,
      dx = (e.clientX - sx) / k,
      dy = (e.clientY - sy) / k;
    if (drag === "move") p.manual = { ...f0, cx: clamp(f0.cx + dx, 0, p.W), cy: clamp(f0.cy + dy, 0, p.H) };
    else {
      const f = clamp((f0.h + Math.max(dx, dy) * 2) / f0.h, 0.1, 10);
      p.manual = { ...f0, h: clamp(f0.h * f, 12, p.H), w: f0.w ? f0.w * f : undefined };
    }
    drawEditor();
  };
  for (const [el, m] of [
    [$("edBox"), "move"],
    [$("edRz"), "size"],
  ]) {
    el.addEventListener("pointerdown", down(m));
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", () => (drag = null));
    el.addEventListener("pointercancel", () => (drag = null));
  }
})();
$("adjustBtn").onclick = (e) => {
  e.stopPropagation();
  openEditor();
};
$("edReset").onclick = () => {
  sel().manual = null;
  drawEditor();
};
$("doneBtn").onclick = () => {
  const p = sel();
  if (!p.manual && !auto(state, p)) p.manual = { ...fallback(p) };
  state.editing = false;
  render();
};
$("cancelBtn").onclick = () => {
  Object.assign(sel(), edSnap);
  state.editing = false;
  render();
};

/* ---------------- remove people and objects: select first (tap = MediaPipe Magic Touch, drag = brush), then Remove (MI-GAN fill) */
// Each removal is stored as a patch in original pixel coordinates with a soft-edged alpha mask and the photo's measured grain.
// Only the patch area is replaced; every other pixel of the photo stays untouched.
let segmenter = null,
  inpaint = null,
  eraserLoading = null,
  warm = null;
const ER_MAX = 1024,
  BRUSH = [
    ["small", 8],
    ["medium", 16],
    ["large", 30],
  ]; // brush radius in screen points
function loadScript(src) {
  return new Promise((res, rej) => {
    const t = document.createElement("script");
    t.src = src;
    t.onload = res;
    t.onerror = () => rej(new Error("Couldn't load " + src));
    document.head.appendChild(t);
  });
}
function loadEraser() {
  return (eraserLoading ??= (async () => {
    await ready;
    if (!vision) throw new Error("Remove needs the detection engine, which did not load.");
    if (!window.ort) await loadScript(base + "ort.wasm.min.js");
    ort.env.wasm.wasmPaths = base;
    ort.env.wasm.numThreads = 1;
    [segmenter, inpaint] = await Promise.all([
      vision.InteractiveSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: base + "magic_touch.tflite", delegate: "CPU" },
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      }),
      ort.InferenceSession.create(base + "migan_pipeline_v2.onnx", { executionProviders: ["wasm"] }),
    ]);
    // the first run compiles the model (several seconds in Safari): do it now, on a tiny image, while the user picks what to remove
    const N = 64,
      im = new Uint8Array(3 * N * N).fill(128),
      keep = new Uint8Array(N * N).fill(255);
    for (let y = 24; y < 40; y++) keep.fill(0, y * N + 24, y * N + 40);
    warm = inpaint
      .run({ image: new ort.Tensor("uint8", im, [1, 3, N, N]), mask: new ort.Tensor("uint8", keep, [1, 1, N, N]) })
      .catch(() => {});
    keepOffline(["mp/ort.wasm.min.js", "mp/ort-wasm-simd.wasm", "mp/magic_touch.tflite", "mp/migan_pipeline_v2.onnx"]);
  })().catch((e) => {
    eraserLoading = null;
    throw e;
  }));
}
function drawEdits(x, p, ox, oy, k) {
  for (const e of p.edits) x.drawImage(e.patch, (e.x - ox) * k, (e.y - oy) * k, e.w * k, e.h * k);
}
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 2; // ~ normal, sd 1
function addGrain(out, p, ox, oy, k) {
  // at save time, at the final resolution, so filled areas are not smoother than the photo
  const W = out.canvas.width,
    H = out.canvas.height;
  for (const e of p.edits) {
    const g = e.grain * Math.min(1, k);
    if (g < 0.4) continue;
    const dx = Math.max(0, Math.floor((e.x - ox) * k)),
      dy = Math.max(0, Math.floor((e.y - oy) * k));
    const dw = Math.min(W, Math.ceil((e.x + e.w - ox) * k)) - dx,
      dh = Math.min(H, Math.ceil((e.y + e.h - oy) * k)) - dy;
    if (dw <= 0 || dh <= 0) continue;
    const a = document.createElement("canvas");
    a.width = dw;
    a.height = dh;
    a.getContext("2d").drawImage(e.patch, (e.x - ox) * k - dx, (e.y - oy) * k - dy, e.w * k, e.h * k);
    const al = a.getContext("2d").getImageData(0, 0, dw, dh).data,
      im = out.getImageData(dx, dy, dw, dh),
      d = im.data;
    for (let i = 0; i < al.length; i += 4) {
      if (!al[i + 3]) continue;
      const n = gauss() * g * (al[i + 3] / 255);
      d[i] += n;
      d[i + 1] += n;
      d[i + 2] += n;
    }
    out.putImageData(im, dx, dy);
    a.width = 0;
  }
}
function rebuildMid(p) {
  if (p.mid !== p.mid0 && !p.mid.shared) p.mid.c.width = 0;
  if (!p.edits.length) {
    p.mid = p.mid0;
  } else {
    const c = document.createElement("canvas");
    c.width = p.mid0.c.width;
    c.height = p.mid0.c.height;
    const x = c.getContext("2d");
    x.imageSmoothingQuality = "high";
    x.drawImage(p.mid0.c, 0, 0);
    drawEdits(x, p, 0, 0, p.mid0.s);
    p.mid = { c, s: p.mid0.s };
  }
  p.thumb = thumbOf(p);
}

// state: sel = red selection at preview (mid) resolution; hist = earlier selections for Undo
const rm = { pid: null, start: 0, busy: "", before: false, sel: null, any: false, hist: [], brush: 1, ready: false };
function erNote() {
  sub(
    !rm.ready
      ? "Loading Remove… first time about 45 MB"
      : rm.before
        ? "Before"
        : rm.busy
          ? rm.busy
          : rm.any
            ? "Tap Remove. Tap red to take it away."
            : sel()?.edits.length
              ? "Hold the photo to see before"
              : "Tap what to remove, or paint over it",
  );
}
// zoom of the Remove view: scale and offset in screen points (two fingers pinch and pan; a trackpad pinches and scrolls)
const rmZoom = { s: 1, x: 0, y: 0 },
  ZMAX = 6,
  rmZoomByPhoto = new Map(); // rmZoomByPhoto: zoom kept for each photo
function animZoom() {
  const e = $("erIn");
  e.classList.add("anim");
  clearTimeout(animZoom.t);
  animZoom.t = setTimeout(() => e.classList.remove("anim"), 260);
}
function setZoom(s, x, y) {
  const el = $("eraser"),
    w = el.clientWidth,
    h = el.clientHeight;
  rmZoom.s = clamp(s, 1, ZMAX);
  rmZoom.x = clamp(x, w - w * rmZoom.s, 0);
  rmZoom.y = clamp(y, h - h * rmZoom.s, 0);
  $("erIn").style.transform = `translate(${rmZoom.x}px, ${rmZoom.y}px) scale(${rmZoom.s})`;
  $("erFit").hidden = rmZoom.s < 1.02;
}
async function warmEraser() {
  // starts the ~45 MB download as soon as the tool has photos
  try {
    await loadEraser();
    if (state.app === "remove") render();
  } catch (e) {
    console.warn(e);
    toast(e.message || "Remove could not load. Check the connection and try again.", 4000);
  }
}
function drawEraser() {
  const p = sel(),
    el = $("eraser"),
    cv = $("erCan"),
    mk = $("erMask");
  $("view").hidden = $("editor").hidden = true;
  el.hidden = false;
  const [w, h] = fitBox(p.W / p.H);
  el.style.width = w + "px";
  el.style.height = h + "px";
  // drawn at preview resolution (not screen size) so it stays sharp when zoomed in
  const src = rm.before ? p.mid0 : p.mid,
    key = p.id + ":" + src.c.width + ":" + p.edits.length + rm.before;
  if (cv.dataset.v !== key) {
    cv.width = src.c.width;
    cv.height = src.c.height;
    cv.dataset.v = key;
    cv.getContext("2d").drawImage(src.c, 0, 0);
  }
  setZoom(rmZoom.s, rmZoom.x, rmZoom.y);
  if (mk.width !== cv.width || mk.height !== cv.height) {
    mk.width = cv.width;
    mk.height = cv.height;
  }
  const mx = mk.getContext("2d");
  mx.clearRect(0, 0, mk.width, mk.height);
  if (rm.sel && !rm.before) mx.drawImage(rm.sel, 0, 0, mk.width, mk.height);
  $("erBusy").hidden = !rm.busy;
  const [name, r] = BRUSH[rm.brush],
    dot = $("erBrush").firstElementChild;
  dot.style.width = dot.style.height = Math.round(r * 0.9) + "px";
  $("erBrush").setAttribute("aria-label", `Brush size: ${name}`);
  $("erUndo").disabled = !!rm.busy || !rm.ready || (!rm.hist.length && p.edits.length <= rm.start);
  $("erGo").disabled = !!rm.busy || !rm.ready || !rm.any;
  erNote();
  syncSave();
}
function blank(p) {
  const c = document.createElement("canvas");
  c.width = p.mid.c.width;
  c.height = p.mid.c.height;
  return c;
}
function pack(c) {
  if (!c) return null;
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data,
    a = new Uint8Array(c.width * c.height);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
  return { w: c.width, h: c.height, a };
}
function unpack(s) {
  if (!s) return null;
  const c = document.createElement("canvas");
  c.width = s.w;
  c.height = s.h;
  const x = c.getContext("2d"),
    im = x.createImageData(s.w, s.h);
  for (let i = 0; i < s.a.length; i++)
    if (s.a[i]) {
      im.data[i * 4] = 255;
      im.data[i * 4 + 1] = 59;
      im.data[i * 4 + 2] = 48;
      im.data[i * 4 + 3] = s.a[i];
    }
  x.putImageData(im, 0, 0);
  return c;
}
function setSel(c) {
  if (rm.sel && rm.sel !== c) rm.sel.width = 0;
  rm.sel = c;
  rm.any = !!(c && alphaBox(c, 4));
}
function snapshot(p) {
  const c = blank(p);
  if (rm.sel) c.getContext("2d").drawImage(rm.sel, 0, 0);
  rm.hist.push(pack(rm.sel));
  if (rm.hist.length > 20) rm.hist.shift();
  if (rm.sel) rm.sel.width = 0;
  rm.sel = c;
  return c.getContext("2d");
}
function alphaBox(c, step = 1) {
  // bounding box and pixel count of the opaque part of a canvas
  const { width: W, height: H } = c,
    d = c.getContext("2d").getImageData(0, 0, W, H).data;
  let x0 = W,
    y0 = H,
    x1 = -1,
    y1 = -1,
    n = 0;
  for (let y = 0; y < H; y += step)
    for (let x = 0; x < W; x += step)
      if (d[(y * W + x) * 4 + 3] > 127) {
        n++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, n: n * step * step };
}
const isSelected = (nx, ny) => {
  if (!rm.sel) return false;
  const d = rm.sel
    .getContext("2d")
    .getImageData(Math.floor(nx * rm.sel.width), Math.floor(ny * rm.sel.height), 1, 1).data;
  return d[3] > 127;
};
// grow a mask so edges, hair and soft shadows go too (a little more downward, where shadows usually fall)
function grow(src, r) {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  const x = c.getContext("2d");
  for (const f of [1 / 3, 2 / 3, 1])
    for (let a = 0; a < 16; a++) {
      const t = (a / 16) * 2 * Math.PI,
        dy = Math.sin(t) * r * f;
      x.drawImage(src, Math.cos(t) * r * f, dy > 0 ? dy * 1.5 : dy);
    }
  x.drawImage(src, 0, 0);
  return c;
}
// the thing under the finger, grown to include its edges; null when the model only found background
function segmentAt(p, nx, ny) {
  const res = segmenter.segment(p.mid.c, { keypoint: { x: nx, y: ny } });
  try {
    const m = res.confidenceMasks[0],
      W = m.width,
      H = m.height,
      v = m.getAsFloat32Array();
    const start = Math.min(H - 1, Math.floor(ny * H)) * W + Math.min(W - 1, Math.floor(nx * W));
    if (v[start] < 0.5) return null;
    // only the connected piece under the finger (no stray specks), and how sure the model is about it
    const on = new Uint8Array(W * H),
      st = [start];
    on[start] = 1;
    let n = 0,
      sure = 0,
      edge = 0;
    while (st.length) {
      const j = st.pop(),
        x = j % W,
        y = (j / W) | 0;
      n++;
      if (v[j] > 0.9) sure++;
      if (!x || !y || x === W - 1 || y === H - 1) edge++;
      for (const k of [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, y > 0 ? j - W : -1, y < H - 1 ? j + W : -1])
        if (k >= 0 && !on[k] && v[k] >= 0.5) {
          on[k] = 1;
          st.push(k);
        }
    }
    // background patches (sky, sand, wall) come back large, unsure, or running along the photo's edges
    if (n > W * H * 0.35 || sure < n * 0.7 || edge > 2 * (W + H) * 0.15) return null;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const x = c.getContext("2d"),
      img = x.createImageData(W, H);
    for (let i = 0; i < on.length; i++)
      if (on[i]) {
        img.data[i * 4] = 255;
        img.data[i * 4 + 1] = 59;
        img.data[i * 4 + 2] = 48;
        img.data[i * 4 + 3] = 255;
      }
    x.putImageData(img, 0, 0);
    const out = blank(p);
    out.getContext("2d").drawImage(c, 0, 0, out.width, out.height);
    c.width = 0;
    const b = alphaBox(out, 2),
      long = Math.max(out.width, out.height);
    const pad = Math.max(3, long * 0.004, Math.max(b.w, b.h) * 0.045),
      g = grow(out, pad);
    if (!standsOut(p, out, g)) return null;
    // contact shadow: a flat band under the base, wider than the thing, where shadows usually fall
    const gx = g.getContext("2d");
    gx.fillStyle = "rgb(255,59,48)";
    gx.beginPath();
    gx.ellipse(b.x + b.w / 2, b.y + b.h, b.w * 1.1 + pad, Math.max(pad, b.h * 0.07), 0, 0, 2 * Math.PI);
    gx.fill();
    return g;
  } finally {
    res.close?.();
  }
}
// a real thing looks different from what is right around it; a patch of sky or wall does not
function standsOut(p, inner, grown) {
  const W = inner.width,
    H = inner.height,
    a = inner.getContext("2d").getImageData(0, 0, W, H).data,
    g = grown.getContext("2d").getImageData(0, 0, W, H).data;
  const px = p.mid.c.getContext("2d").getImageData(0, 0, W, H).data,
    si = [0, 0, 0, 0],
    so = [0, 0, 0, 0];
  for (let i = 0; i < W * H; i += 3) {
    const t = a[i * 4 + 3] > 127 ? si : g[i * 4 + 3] > 127 ? so : null;
    if (!t) continue;
    t[0] += px[i * 4];
    t[1] += px[i * 4 + 1];
    t[2] += px[i * 4 + 2];
    t[3]++;
  }
  if (!si[3] || !so[3]) return true;
  return Math.hypot(si[0] / si[3] - so[0] / so[3], si[1] / si[3] - so[1] / so[3], si[2] / si[3] - so[2] / so[3]) > 14;
}
function clearPatchAt(nx, ny) {
  // remove the red area under the finger
  const W = rm.sel.width,
    H = rm.sel.height,
    x = snapshot(sel()),
    im = x.getImageData(0, 0, W, H),
    d = im.data;
  const st = [Math.floor(ny * H) * W + Math.floor(nx * W)];
  while (st.length) {
    const j = st.pop();
    if (d[j * 4 + 3] <= 127) continue;
    d[j * 4 + 3] = 0;
    const jx = j % W;
    if (jx > 0) st.push(j - 1);
    if (jx < W - 1) st.push(j + 1);
    if (j >= W) st.push(j - W);
    if (j < W * (H - 1)) st.push(j + W);
  }
  x.putImageData(im, 0, 0);
}
async function tapAt(nx, ny) {
  const p = sel();
  rm.busy = "Selecting…";
  drawEraser();
  await new Promise((r) => setTimeout(r, 20));
  try {
    if (isSelected(nx, ny))
      clearPatchAt(nx, ny); // tap red = take that area away
    else {
      const m = segmentAt(p, nx, ny);
      if (m) snapshot(p).drawImage(m, 0, 0);
      else toast("That looks like background. Paint over the thing instead.", 3000);
    }
  } catch (e) {
    console.warn(e);
    toast("Couldn't select there. Paint over it instead.", 3000);
  }
  rm.any = !!(rm.sel && alphaBox(rm.sel, 4));
  rm.busy = "";
  drawEraser();
}

// separate selected areas are filled one by one, each with its own context, so a far-apart pair does not become one blurry square
function areas(sel) {
  const c = document.createElement("canvas"); // ~1 cell per 12 px; cells within 2 of each other count as one area
  c.width = Math.max(1, Math.round(sel.width / 12));
  c.height = Math.max(1, Math.round(sel.height / 12));
  const x = c.getContext("2d");
  x.drawImage(sel, 0, 0, c.width, c.height);
  const d = x.getImageData(0, 0, c.width, c.height).data,
    cw = c.width,
    ch = c.height,
    seen = new Uint8Array(cw * ch),
    out = [];
  const on = (i) => d[i * 4 + 3] > 8;
  for (let i = 0; i < cw * ch; i++) {
    if (!on(i) || seen[i]) continue;
    let x0 = cw,
      y0 = ch,
      x1 = 0,
      y1 = 0;
    const st = [i];
    seen[i] = 1;
    while (st.length) {
      const j = st.pop(),
        jx = j % cw,
        jy = (j / cw) | 0;
      x0 = Math.min(x0, jx);
      x1 = Math.max(x1, jx);
      y0 = Math.min(y0, jy);
      y1 = Math.max(y1, jy);
      for (let oy = -2; oy <= 2; oy++)
        for (let ox = -2; ox <= 2; ox++) {
          const nx = jx + ox,
            ny = jy + oy,
            k = ny * cw + nx;
          if (nx >= 0 && ny >= 0 && nx < cw && ny < ch && !seen[k] && on(k)) {
            seen[k] = 1;
            st.push(k);
          }
        }
    }
    const k = sel.width / cw;
    out.push({ x: x0 * k, y: y0 * k, w: (x1 - x0 + 1) * k, h: (y1 - y0 + 1) * k });
  }
  c.width = 0;
  return out;
}
function measureGrain(img, R, p) {
  // photo noise next to the area, at full resolution (robust: median absolute Laplacian)
  const S0 = 64,
    vals = [],
    spots = [
      [R.x, R.y],
      [R.x + R.w - S0, R.y],
      [R.x, R.y + R.h - S0],
      [R.x + R.w - S0, R.y + R.h - S0],
    ];
  const c = document.createElement("canvas");
  c.width = c.height = S0;
  const x = c.getContext("2d", { willReadFrequently: true });
  for (const [sx0, sy0] of spots) {
    const sx = clamp(Math.round(sx0), 0, p.W - S0),
      sy = clamp(Math.round(sy0), 0, p.H - S0);
    if (isSelected((sx + S0 / 2) / p.W, (sy + S0 / 2) / p.H)) continue;
    x.drawImage(img, sx, sy, S0, S0, 0, 0, S0, S0);
    const d = x.getImageData(0, 0, S0, S0).data,
      L = (i) => d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11,
      a = [];
    for (let yy = 1; yy < S0 - 1; yy += 2)
      for (let xx = 1; xx < S0 - 1; xx += 2) {
        const i = (yy * S0 + xx) * 4;
        a.push(Math.abs(4 * L(i) - L(i - 4) - L(i + 4) - L(i - S0 * 4) - L(i + S0 * 4)));
      }
    a.sort((m, n) => m - n);
    vals.push((1.4826 * a[a.length >> 1]) / Math.sqrt(20));
  }
  c.width = 0;
  vals.sort((m, n) => m - n);
  return vals.length ? Math.min(10, vals[vals.length >> 1]) : 0;
}
// The model fills at about 512 px; bigger areas come back blocky and a shade off. Inside the hole only:
// 1) smooth at the model's own scale, 2) shift the colour so the hole's rim matches the photo just outside it.
function cleanFill(out, px, mm, w, h) {
  const n = w * h,
    f = new Uint8ClampedArray(n * 4),
    hole = (i) => mm[i * 4 + 3] > 127;
  for (let i = 0; i < n; i++) {
    f[i * 4] = out[i];
    f[i * 4 + 1] = out[n + i];
    f[i * 4 + 2] = out[2 * n + i];
    f[i * 4 + 3] = 255;
  }
  const long = Math.max(w, h);
  if (long > 560) {
    const a = document.createElement("canvas");
    a.width = w;
    a.height = h;
    const ax = a.getContext("2d");
    ax.putImageData(new ImageData(f, w, h), 0, 0);
    const k = 512 / long,
      b = document.createElement("canvas");
    b.width = Math.max(1, Math.round(w * k));
    b.height = Math.max(1, Math.round(h * k));
    const bx = b.getContext("2d");
    bx.imageSmoothingQuality = "high";
    bx.drawImage(a, 0, 0, b.width, b.height);
    ax.imageSmoothingQuality = "high";
    ax.clearRect(0, 0, w, h);
    ax.drawImage(b, 0, 0, w, h);
    const sm = ax.getImageData(0, 0, w, h).data;
    for (let i = 0; i < n; i++)
      if (hole(i)) {
        f[i * 4] = sm[i * 4];
        f[i * 4 + 1] = sm[i * 4 + 1];
        f[i * 4 + 2] = sm[i * 4 + 2];
      }
    a.width = b.width = 0;
  }
  // colour: measure how far the fill is off at the rim (hole pixel vs the photo 2 px outside it), then spread
  // that difference smoothly inward (a membrane), so sky stays sky-coloured and sand stays sand-coloured
  const G = Math.max(1, Math.ceil(long / 96)),
    gw = Math.ceil(w / G),
    gh = Math.ceil(h / G),
    m = gw * gh;
  const val = new Float32Array(m * 3),
    cnt = new Float32Array(m),
    inH = new Uint8Array(m);
  const w2 = 2 * w;
  for (let y = 2; y < h - 2; y++)
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      if (mm[i * 4 + 3] <= 127) continue;
      const g = ((y / G) | 0) * gw + ((x / G) | 0);
      inH[g] = 1;
      const j =
        mm[(i - 2) * 4 + 3] <= 127
          ? i - 2
          : mm[(i + 2) * 4 + 3] <= 127
            ? i + 2
            : mm[(i - w2) * 4 + 3] <= 127
              ? i - w2
              : mm[(i + w2) * 4 + 3] <= 127
                ? i + w2
                : -1;
      if (j < 0) continue;
      val[g * 3] += px[j * 4] - f[i * 4];
      val[g * 3 + 1] += px[j * 4 + 1] - f[i * 4 + 1];
      val[g * 3 + 2] += px[j * 4 + 2] - f[i * 4 + 2];
      cnt[g]++;
    }
  const fixed = new Uint8Array(m);
  for (let g = 0; g < m; g++)
    if (cnt[g]) {
      fixed[g] = 1;
      for (let ch = 0; ch < 3; ch++) val[g * 3 + ch] = clamp(val[g * 3 + ch] / cnt[g], -40, 40);
    }
  const NB = new Int32Array(m * 4).fill(-1); // neighbour cells, computed once
  for (let g = 0; g < m; g++) {
    const gx = g % gw;
    if (gx > 0) NB[g * 4] = g - 1;
    if (gx < gw - 1) NB[g * 4 + 1] = g + 1;
    if (g >= gw) NB[g * 4 + 2] = g - gw;
    if (g < m - gw) NB[g * 4 + 3] = g + gw;
  }
  const free = [];
  for (let g = 0; g < m; g++) if (inH[g] && !fixed[g]) free.push(g);
  for (let it = 0; it < 300; it++)
    for (const g of free) {
      let a0 = 0,
        a1 = 0,
        a2 = 0,
        k = 0;
      for (let e = 0; e < 4; e++) {
        const q = NB[g * 4 + e];
        if (q >= 0 && inH[q]) {
          a0 += val[q * 3];
          a1 += val[q * 3 + 1];
          a2 += val[q * 3 + 2];
          k++;
        }
      }
      if (k) {
        val[g * 3] = a0 / k;
        val[g * 3 + 1] = a1 / k;
        val[g * 3 + 2] = a2 / k;
      }
    }
  for (let pass = 0; pass < 2; pass++)
    for (let g = 0; g < m; g++) {
      // cells outside the hole borrow a neighbour's value, so the smooth upscale does not pull edges to 0
      if (inH[g]) continue;
      for (let e = 0; e < 4; e++) {
        const q = NB[g * 4 + e];
        if (q >= 0 && inH[q]) {
          val[g * 3] = val[q * 3];
          val[g * 3 + 1] = val[q * 3 + 1];
          val[g * 3 + 2] = val[q * 3 + 2];
          inH[g] = 2;
          break;
        }
      }
    }
  const gc = document.createElement("canvas");
  gc.width = gw;
  gc.height = gh;
  const gx = gc.getContext("2d"),
    gi = gx.createImageData(gw, gh);
  for (let g = 0; g < m; g++) {
    for (let ch = 0; ch < 3; ch++) gi.data[g * 4 + ch] = 128 + val[g * 3 + ch] * 3;
    gi.data[g * 4 + 3] = 255;
  }
  gx.putImageData(gi, 0, 0);
  const uc = document.createElement("canvas");
  uc.width = w;
  uc.height = h;
  const ux = uc.getContext("2d");
  ux.imageSmoothingQuality = "high";
  ux.drawImage(gc, 0, 0, w, h);
  const off = ux.getImageData(0, 0, w, h).data;
  for (let i = 0; i < n; i++)
    if (mm[i * 4 + 3] > 127) {
      f[i * 4] += (off[i * 4] - 128) / 3;
      f[i * 4 + 1] += (off[i * 4 + 1] - 128) / 3;
      f[i * 4 + 2] += (off[i * 4 + 2] - 128) / 3;
    }
  gc.width = uc.width = 0;
  return f;
}
async function fillArea(p, img, b) {
  // b: area in preview (mid) pixels
  const s = p.mid.s,
    m = Math.max(b.w, b.h) * 0.6 + 24; // context around the area helps the fill
  const R = { x: Math.floor(Math.max(0, (b.x - m) / s)), y: Math.floor(Math.max(0, (b.y - m) / s)) };
  R.w = Math.ceil(Math.min(p.W, (b.x + b.w + m) / s) - R.x);
  R.h = Math.ceil(Math.min(p.H, (b.y + b.h + m) / s) - R.y);
  const k = Math.min(1, ER_MAX / Math.max(R.w, R.h)),
    sw = Math.max(8, Math.round(R.w * k)),
    sh = Math.max(8, Math.round(R.h * k));
  const src = document.createElement("canvas");
  src.width = sw;
  src.height = sh;
  const sx = src.getContext("2d", { willReadFrequently: true });
  sx.imageSmoothingQuality = "high";
  drawDown(sx, img, R.x, R.y, R.w, R.h, 0, 0, sw, sh);
  drawEdits(sx, p, R.x, R.y, sw / R.w);
  const grain = measureGrain(img, R, p);
  const mc = document.createElement("canvas");
  mc.width = sw;
  mc.height = sh;
  const mx = mc.getContext("2d", { willReadFrequently: true });
  mx.drawImage(rm.sel, b.x, b.y, b.w, b.h, (b.x / s - R.x) * k, (b.y / s - R.y) * k, (b.w / s) * k, (b.h / s) * k);
  const px = sx.getImageData(0, 0, sw, sh).data,
    mm = mx.getImageData(0, 0, sw, sh).data,
    n = sw * sh;
  const im = new Uint8Array(3 * n),
    keep = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    im[i] = px[i * 4];
    im[n + i] = px[i * 4 + 1];
    im[2 * n + i] = px[i * 4 + 2];
    keep[i] = mm[i * 4 + 3] > 127 ? 0 : 255;
  }
  await warm; // a session runs one job at a time
  const out = (
    await inpaint.run({
      image: new ort.Tensor("uint8", im, [1, 3, sh, sw]),
      mask: new ort.Tensor("uint8", keep, [1, 1, sh, sw]),
    })
  ).result.data;
  // soft edge outside the selection: the mask shrunk and grown again
  const f = Math.max(2, Math.round(Math.min(sw, sh) / 64)),
    sm = document.createElement("canvas");
  sm.width = Math.max(1, Math.round(sw / f));
  sm.height = Math.max(1, Math.round(sh / f));
  const smx = sm.getContext("2d");
  smx.imageSmoothingQuality = "high";
  smx.drawImage(mc, 0, 0, sm.width, sm.height);
  mx.clearRect(0, 0, sw, sh);
  mx.imageSmoothingQuality = "high";
  mx.drawImage(sm, 0, 0, sw, sh);
  const soft = mx.getImageData(0, 0, sw, sh).data,
    patch = sx.createImageData(sw, sh),
    fill = cleanFill(out, px, mm, sw, sh);
  for (let i = 0; i < n; i++) {
    patch.data[i * 4] = fill[i * 4];
    patch.data[i * 4 + 1] = fill[i * 4 + 1];
    patch.data[i * 4 + 2] = fill[i * 4 + 2];
    patch.data[i * 4 + 3] = Math.max(soft[i * 4 + 3], mm[i * 4 + 3] > 127 ? 255 : 0);
  }
  const pc = document.createElement("canvas");
  pc.width = sw;
  pc.height = sh;
  pc.getContext("2d").putImageData(patch, 0, 0);
  src.width = mc.width = sm.width = 0;
  p.edits.push({ ...R, patch: pc, grain });
}
async function removeSelected() {
  const p = sel();
  if (rm.busy || !rm.any) return;
  const list = areas(rm.sel);
  if (!list.length) return;
  rm.busy = "Removing…";
  drawEraser();
  await new Promise((r) => setTimeout(r, 30));
  const before = p.edits.length;
  let loaded = null;
  try {
    loaded = await loadImg(p.file); // the original is decoded only for this step, then released
    for (let i = 0; i < list.length; i++) {
      if (list.length > 1) {
        rm.busy = `Removing ${i + 1} of ${list.length}…`;
        erNote();
      }
      await fillArea(p, loaded.img, list[i]);
    }
    setSel(null);
    rm.hist = [];
  } catch (e) {
    console.warn(e);
    p.edits.length = before;
    toast("Couldn't remove that. Try a smaller area.", 3200);
  } finally {
    if (loaded) release(loaded);
  }
  rebuildMid(p);
  rm.busy = "";
  drawEraser();
  drawStrip();
}
(() => {
  // one finger: tap = select (tap red = take it away), drag = paint, hold still = before. Two fingers: pinch and pan.
  const el = $("eraser"),
    pts = new Map();
  let on = false,
    painting = false,
    pinch = null,
    sx = 0,
    sy = 0,
    t = 0,
    last = null,
    ctx = null,
    lastTap = null,
    pend = 0;
  const local = (e) => {
    const r = el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const photoRect = () => $("erIn").getBoundingClientRect();
  const toMid = (e) => {
    const r = photoRect(),
      p = sel();
    return [((e.clientX - r.left) / r.width) * p.mid.c.width, ((e.clientY - r.top) / r.height) * p.mid.c.height];
  };
  const dab = (a, b) => {
    const p = sel(),
      rad = (p.mid.c.width / photoRect().width) * BRUSH[rm.brush][1]; // same size on screen at any zoom
    ctx.strokeStyle = "rgb(255,59,48)";
    ctx.lineWidth = rad * 2;
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(...(a || b));
    ctx.lineTo(...b);
    ctx.stroke();
    drawEraser();
  };
  const startPinch = () => {
    clearTimeout(t);
    if (painting) setSel(unpack(rm.hist.pop())); // the stroke the first finger began was the start of a pinch
    rm.before = false;
    on = painting = false;
    const [a, b] = [...pts.values()];
    pinch = {
      d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1,
      m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
      s: rmZoom.s,
      x: rmZoom.x,
      y: rmZoom.y,
    };
    drawEraser();
  };
  el.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    pts.set(e.pointerId, local(e));
    try {
      el.setPointerCapture(e.pointerId);
    } catch {}
    if (pts.size === 2) return startPinch();
    if (pts.size > 2 || pinch || rm.busy || !rm.ready) return;
    on = true;
    painting = false;
    sx = e.clientX;
    sy = e.clientY;
    last = null;
    t = setTimeout(() => {
      if (on && !painting) {
        rm.before = true;
        drawEraser();
      }
    }, 350);
  });
  el.addEventListener("pointermove", (e) => {
    if (pts.has(e.pointerId)) pts.set(e.pointerId, local(e));
    if (pinch) {
      if (pts.size < 2) return;
      const [a, b] = [...pts.values()],
        m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const s = clamp((pinch.s * Math.hypot(a[0] - b[0], a[1] - b[1])) / pinch.d, 1, ZMAX),
        k = s / pinch.s;
      return setZoom(s, m[0] - (pinch.m[0] - pinch.x) * k, m[1] - (pinch.m[1] - pinch.y) * k);
    }
    if (!on || rm.before) return;
    if (!painting && Math.hypot(e.clientX - sx, e.clientY - sy) < 8) return;
    if (!painting) {
      painting = true;
      clearTimeout(t);
      ctx = snapshot(sel());
      last = toMid({ clientX: sx, clientY: sy });
      dab(null, last);
    }
    const pt = toMid(e);
    dab(last, pt);
    last = pt;
  });
  const up = (e, cancel) => {
    pts.delete(e.pointerId);
    if (pinch) {
      if (!pts.size) pinch = null;
      return;
    }
    if (!on) return;
    on = false;
    clearTimeout(t);
    if (rm.before) {
      rm.before = false;
      drawEraser();
      return;
    }
    if (painting) {
      rm.any = true;
      drawEraser();
      return;
    }
    if (cancel) return;
    const now = performance.now(),
      [lx, ly] = local(e);
    if (lastTap && now - lastTap.t < 300 && Math.hypot(lx - lastTap.x, ly - lastTap.y) < 30) {
      // double tap: zoom in there, or back to fit
      clearTimeout(pend);
      lastTap = null;
      animZoom();
      if (rmZoom.s > 1.05) setZoom(1, 0, 0);
      else {
        const s = 2.5;
        setZoom(s, lx - (lx - rmZoom.x) * (s / rmZoom.s), ly - (ly - rmZoom.y) * (s / rmZoom.s));
      }
      return;
    }
    lastTap = { t: now, x: lx, y: ly };
    const r = photoRect(),
      nx = clamp((e.clientX - r.left) / r.width, 0, 1),
      ny = clamp((e.clientY - r.top) / r.height, 0, 1);
    clearTimeout(pend);
    pend = setTimeout(() => tapAt(nx, ny), 260);
  };
  el.addEventListener("pointerup", (e) => up(e, false));
  el.addEventListener("pointercancel", (e) => up(e, true));
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  el.addEventListener("gesturestart", (e) => e.preventDefault()); // Safari: keep the page itself from zooming
  el.addEventListener(
    "wheel",
    (e) => {
      // trackpad: pinch (ctrl + wheel) zooms at the pointer, two-finger scroll pans
      e.preventDefault();
      const [mx, my] = local(e);
      if (e.ctrlKey) {
        const s = clamp(rmZoom.s * Math.exp(-e.deltaY / 100), 1, ZMAX),
          k = s / rmZoom.s;
        setZoom(s, mx - (mx - rmZoom.x) * k, my - (my - rmZoom.y) * k);
      } else setZoom(rmZoom.s, rmZoom.x - e.deltaX, rmZoom.y - e.deltaY);
    },
    { passive: false },
  );
})();
$("erFit").onclick = () => {
  animZoom();
  setZoom(1, 0, 0);
};
$("erUndo").onclick = () => {
  const p = sel();
  if (rm.hist.length) setSel(unpack(rm.hist.pop()));
  else if (p.edits.length > rm.start) {
    p.edits.pop();
    rebuildMid(p);
    drawStrip();
  }
  drawEraser();
};
$("erGo").onclick = removeSelected;
$("erBrush").onclick = () => {
  rm.brush = (rm.brush + 1) % BRUSH.length;
  drawEraser();
  toast(`Brush: ${BRUSH[rm.brush][0]}`, 1200);
};

/* ---------------- Remove -> Even out a set: the same photos, removals included, become (or join) that tool's set */
async function toAlign() {
  if (rm.busy) return toast("Wait for Remove to finish", 1800);
  const src = state.photos.slice();
  if (!src.length) return;
  sets.remove = Object.fromEntries(SET.map((k) => [k, state[k]]));
  Object.assign(state, sets.align || fresh(), { app: "align", editing: false, save: null, zoom: null });
  const hadRef = !!state.refId;
  render();
  for (let i = 0; i < src.length; i++) {
    toast(`Finding the subject ${i + 1} of ${src.length}…`, 15000);
    const p = src[i],
      mid = p.mid;
    mid.shared = true; // both tools use the same preview: no second copy in memory
    const sm = scaled(mid.c, mid.c.width, mid.c.height, DETECT);
    const est = await detect(sm.c, 1 / (mid.s * sm.s));
    sm.c.width = 0;
    const q = { ...p, id: state.nextId++, mid, edits: p.edits.slice(), est, pick: null, manual: null };
    state.photos.push(q);
    if (!state.refId) state.refId = q.id;
  }
  state.selId = state.photos[state.photos.length - 1].id;
  render();
  if (previewMB() > BIG_MB) return warnIfBig();
  toast(
    hadRef
      ? `${src.length} photo${src.length > 1 ? "s" : ""} added to your set`
      : state.photos.length > 1
        ? "Photo 1 is the reference. Change it in ⋯."
        : "Now add the photos to fix",
    4000,
  );
}
$("optAlign").onclick = () => {
  $("menu").hidden = true;
  toAlign();
};

// rough memory of all previews kept by both tools (each canvas counted once)
function previewMB() {
  const seen = new Set();
  let b = 0;
  for (const ps of [state.photos, ...Object.values(sets).map((x) => x?.photos || [])])
    for (const p of ps)
      for (const m of [p.mid0, p.mid])
        if (m?.c.width && !seen.has(m.c)) {
          seen.add(m.c);
          b += m.c.width * m.c.height * 4;
        }
  return b / 1e6;
}
const BIG_MB = 260;
function warnIfBig() {
  if (previewMB() > BIG_MB) toast("That's a lot of photos for Safari. Save what you have, then start a new set.", 6000);
}

/* ---------------- adding photos */
$("emptyCta").onclick = () => {
  if (state.app === "remove") {
    loadEraser().catch(() => {});
    return $("rmFile").click();
  }
  (ref() ? $("moreFile") : $("refFile")).click();
};
$("goAlign").onclick = () => enter("align");
$("goRemove").onclick = () => enter("remove");
$("goLook").onclick = () => {
  enter("look");
  setLook(state.look * 100);
};
$("backBtn").onclick = goHome;
$("rmFile").onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  let first = null;
  for (let i = 0; i < files.length; i++) {
    toast(files.length > 1 ? `Reading ${i + 1} of ${files.length}…` : "Reading photo…", 15000);
    try {
      const p = await makePhoto(files[i], false);
      state.photos.push(p);
      first ??= p;
    } catch (err) {
      toast(err.message);
    }
  }
  $("toast").hidden = true;
  if (first) state.selId = first.id;
  render();
  warmEraser();
  warnIfBig();
};
$("refFile").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  toast("Reading photo…", 15000);
  try {
    const look = state.app === "look",
      p = await makePhoto(f, !look),
      old = look ? ref() : null,
      keep = old && sel() && sel().id !== old.id ? sel().id : null;
    // Copy the look: a new reference replaces the old one (it is never saved), the photo on screen stays on screen
    if (old) state.photos.splice(idx(old), 1);
    state.photos.unshift(p);
    state.refId = p.id;
    state.selId = keep ?? p.id;
    state.zoom = null;
    toast(
      look
        ? old
          ? "Reference changed"
          : "Reference set"
        : missing(state, p)
        ? "No subject found. You can place it by hand."
        : cands(p).length > 1
          ? `${cands(p).length} people found. Using the largest.`
          : "Reference set",
    );
  } catch (err) {
    toast(err.message);
  }
  render();
};
$("moreFile").onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  let last = null;
  for (let i = 0; i < files.length; i++) {
    toast(`Reading ${i + 1} of ${files.length}…`, 15000);
    try {
      last = await makePhoto(files[i], state.app === "align");
      state.photos.push(last);
    } catch (err) {
      toast(err.message);
    }
  }
  if (last) state.selId = last.id;
  state.zoom = null;
  if (state.app === "look") {
    toast("Drag across to compare. Hold to see the reference.", 4200);
    render();
    return warnIfBig();
  }
  const md = mode(state),
    miss = state.photos.filter((p) => p.id !== state.refId && missing(state, p, md)).length,
    multi = state.photos.filter((p) => cands(p).length > 1).length;
  toast(
    missing(state, ref(), md)
      ? "Set the subject on the reference first (photo 1)."
      : miss
        ? `${miss} photo${miss > 1 ? "s" : ""} marked ! need the subject placed by hand.`
        : multi
          ? `${multi} photo${multi > 1 ? "s have" : " has"} several people. Tap Choose subject to switch.`
          : "Drag across to compare. Touch and hold to lay the reference on top.",
    4200,
  );
  render();
};

/* ---------------- options sheet */
function syncMenu() {
  $("qGroup")
    .querySelectorAll(".opt")
    .forEach((b) => b.setAttribute("aria-pressed", b.dataset.q === state.quality));
  $("fGroup")
    .querySelectorAll(".opt")
    .forEach((b) => b.setAttribute("aria-pressed", b.dataset.f === state.fmt));
  $("optGuides").setAttribute("aria-pressed", state.guides);
  $("optGuides").hidden = state.app !== "align";
  $("optRef").hidden = state.app === "remove" || !sel() || sel().id === state.refId || state.photos.length < 2;
  $("optNew").hidden = !state.photos.length;
  $("optAlign").hidden = state.app !== "remove" || !state.photos.length;
  $("optNew").firstElementChild.textContent = state.app !== "remove" ? "Start a new photo set" : "Start over";
}
$("moreBtn").onclick = () => {
  syncMenu();
  $("menu").hidden = false;
};
$("menuClose").onclick = () => ($("menu").hidden = true);
$("menu").onclick = (e) => {
  if (e.target === $("menu")) $("menu").hidden = true;
};
$("qGroup")
  .querySelectorAll(".opt")
  .forEach(
    (b) =>
      (b.onclick = () => {
        state.quality = b.dataset.q;
        syncMenu();
        if (state.lay) stage();
      }),
  );
$("fGroup")
  .querySelectorAll(".opt")
  .forEach(
    (b) =>
      (b.onclick = () => {
        state.fmt = b.dataset.f;
        syncMenu();
        syncSave();
      }),
  );
$("optGuides").onclick = () => {
  state.guides = !state.guides;
  syncMenu();
  if (state.lay) stage();
};
$("optRef").onclick = () => {
  state.refId = state.selId;
  state.zoom = null;
  $("menu").hidden = true;
  toast("This photo is now the reference");
  render();
};
let armed = 0;
$("optNew").onclick = () => {
  const b = $("optNew");
  if (Date.now() - armed > 3000) {
    armed = Date.now();
    b.firstElementChild.textContent = "Tap again to remove all photos";
    return;
  }
  if (rm.busy) return;
  Object.assign(state, fresh(), { editing: false });
  setSel(null);
  Object.assign(rm, { pid: null, hist: [] });
  rmZoomByPhoto.clear();
  $("menu").hidden = true;
  render();
};
addEventListener("resize", () => {
  if (state.app === "remove" && sel()) drawEraser();
  else if (state.editing) drawEditor();
  else if (state.app === "look" && sel() && !$("view").hidden) stageLook();
  else if (state.lay && !$("view").hidden) stage();
});

/* ---------------- save: pixel-exact crops from the original, Display P3 where supported, date taken kept, iOS share sheet */
// Save in Display P3 (iPhone photos are P3) only where the exported file carries the Display P3 profile.
// A P3 file without its profile is read as sRGB and its colours shift, so any browser that drops it gets sRGB.
// Checked once per file type. Safari 26 embeds the profile in both JPEG and PNG.
const P3_OK = { "image/jpeg": false, "image/png": false };
const p3Checked = (async () => {
  if (!matchMedia("(color-gamut: p3)").matches) return;
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 8;
    const x = c.getContext("2d", { colorSpace: "display-p3" });
    if (x?.getContextAttributes?.().colorSpace !== "display-p3") return;
    x.fillStyle = "color(display-p3 1 0 0)";
    x.fillRect(0, 0, 8, 8);
    for (const type of Object.keys(P3_OK)) {
      const blob = await new Promise((r) => c.toBlob(r, type, 0.9));
      const head = new Uint8Array(await blob.slice(0, 8192).arrayBuffer());
      P3_OK[type] = hasP3Profile(head);
    }
  } catch (e) {
    console.warn(e);
  }
})();
function hasP3Profile(b) {
  // the ICC profile's description says "Display P3" (ASCII, or UTF-16 in newer profiles)
  let ascii = "";
  for (const ch of b) if (ch >= 32 && ch < 127) ascii += String.fromCharCode(ch);
  return /ICC_PROFILE|iCCP/.test(ascii) && ascii.includes("Display P3");
}
function render2d(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const x = c.getContext("2d", P3_OK[state.fmt] ? { colorSpace: "display-p3" } : undefined) || c.getContext("2d");
  x.imageSmoothingQuality = "high";
  return { c, x };
}
function drawDown(x, src, sx, sy, sw, sh, dx, dy, dw, dh) {
  // halve step by step for a clean downscale
  let tmp = null;
  while (sw / 2 >= dw * 1.05 && (sw / 2) * (sh / 2) <= MAX_AREA) {
    const t = render2d(Math.round(sw / 2), Math.round(sh / 2));
    t.x.drawImage(src, sx, sy, sw, sh, 0, 0, t.c.width, t.c.height);
    if (tmp) tmp.width = 0;
    tmp = src = t.c;
    sx = sy = 0;
    sw = t.c.width;
    sh = t.c.height;
  }
  x.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
  if (tmp) tmp.width = 0;
}
async function exportCanvas(p, crop) {
  const c = { w: Math.min(p.W, Math.round(crop.w)), h: Math.min(p.H, Math.round(crop.h)) };
  c.x = clamp(Math.round(crop.x), 0, p.W - c.w);
  c.y = clamp(Math.round(crop.y), 0, p.H - c.h);
  let w = state.quality === "ig" ? IG : c.w,
    h = Math.round((w * c.h) / c.w);
  if (w * h > MAX_AREA) {
    const k = Math.sqrt(MAX_AREA / (w * h));
    w = Math.floor(w * k);
    h = Math.floor(h * k);
  }
  await p3Checked;
  const loaded = await loadImg(p.file);
  try {
    if (loaded.img.naturalWidth !== p.W || loaded.img.naturalHeight !== p.H)
      throw new Error(`Photo ${idx(p) + 1} could not be read again`);
    const out = render2d(w, h);
    drawDown(out.x, loaded.img, c.x, c.y, c.w, c.h, 0, 0, w, h);
    drawEdits(out.x, p, c.x, c.y, w / c.w); // removals go only where they were made; every other pixel is the original
    if (p.edits.length) addGrain(out.x, p, c.x, c.y, w / c.w);
    if (state.app === "look") gradeCanvas(out.c, lutFor(p));
    return out.c;
  } finally {
    release(loaded);
  }
}
// Builds photos from `from` until about BATCH_BYTES, so a big set never sits in memory at once.
async function buildBatch(from) {
  const lay = state.app === "align" ? layout(state) : null,
    list = targets(),
    files = [],
    ext = state.fmt === "image/png" ? "png" : "jpg",
    n = list.length;
  let bytes = 0,
    i = from;
  for (; i < n && (files.length === 0 || bytes < BATCH_BYTES); i++) {
    $("saveBtn").textContent = `${i + 1}/${n}`;
    await new Promise((r) => setTimeout(r, 16));
    const p = list[i],
      c = await exportCanvas(p, cropOf(p, lay));
    let blob = await new Promise((r) => c.toBlob(r, state.fmt, state.fmt === "image/png" ? undefined : 0.95));
    c.width = 0;
    if (!blob || !blob.size) throw new Error(`Photo ${i + 1} could not be made. Try Instagram size in ⋯.`);
    if (state.fmt === "image/jpeg" && p.date) blob = await withExif(blob, p.date);
    bytes += blob.size;
    const name =
      state.app === "align"
        ? `${String(i + 1).padStart(2, "0")}_${p.name}`
        : `${p.name}_${state.app === "look" ? "look" : "edited"}`;
    files.push(
      new File([blob], `${name}.${ext}`, { type: state.fmt, lastModified: p.date ? dateMs(p.date) : Date.now() }),
    );
  }
  return { files, from, to: i };
}
async function share(files) {
  if (navigator.canShare?.({ files })) return navigator.share({ files });
  for (const f of files) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    a.click();
    await new Promise((r) => setTimeout(r, 300));
  }
}
function saved(batch) {
  const n = targets().length,
    { from, to } = batch;
  const next = state.app === "remove" && state.photos.length > 1 ? { label: "Even out", fn: toAlign } : undefined;
  if (to >= n) {
    state.save = null;
    toast(
      from === 0
        ? n === 1
          ? "Photo handed to iOS. Check Photos."
          : `All ${n} of ${n} photos handed to iOS. Check Photos.`
        : `Photo${to - from > 1 ? "s" : ""} ${span(from + 1, n)} handed to iOS. All ${n} done.`,
      next ? 6000 : 4000,
      next,
    );
  } else {
    state.save = { sig: signature(), next: to, files: null };
    toast(`Photo${to - from > 1 ? "s" : ""} ${span(from + 1, to)} of ${n} handed to iOS. Tap Save for the rest.`, 5000);
  }
  syncSave();
}
$("saveBtn").onclick = async () => {
  const b = $("saveBtn");
  if (state.save && state.save.sig !== signature()) state.save = null;
  try {
    if (state.save?.files) {
      const batch = state.save.files;
      await share(batch.files);
      return saved(batch);
    }
    b.disabled = true;
    const batch = await buildBatch(state.save?.next ?? 0);
    b.disabled = false;
    try {
      await share(batch.files);
      saved(batch);
    } catch (e) {
      if (e.name === "AbortError") {
        syncSave();
        toast("Not saved");
        return;
      }
      // Safari can drop the tap permission while photos are prepared: keep them and ask for one more tap
      state.save = { sig: signature(), next: batch.from, files: batch };
      syncSave();
      toast(`${batch.files.length} photos ready. Tap “Tap to save”.`, 4000);
    }
  } catch (e) {
    console.warn(e);
    b.disabled = false;
    syncSave();
    if (e.name === "AbortError") toast("Not saved");
    else toast(e.message || "Couldn't save. Try Instagram size in ⋯.", 4000);
  }
};
