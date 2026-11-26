// Date taken: read from the original photo's EXIF, written back into saved JPEGs (a canvas export has no EXIF).
// Only the date and its time zone are written; location, camera and other tags are not carried over.
// No DOM, so it runs in Node for tests (tests/exif.test.mjs).
//
// A date is { d: "YYYY:MM:DD hh:mm:ss", off: "+07:00" | null }.

const TAG_EXIF_IFD = 0x8769;
const TAG_DATETIME = 0x0132;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME_DIGITIZED = 0x9004;
const TAG_OFFSET_ORIGINAL = 0x9011;
const TAG_OFFSET_DIGITIZED = 0x9012;
const TYPE_ASCII = 2;

// b: file bytes, t: where the TIFF header starts
export function parseTiff(b, t) {
  if (t + 8 > b.length) return null;
  const le = b[t] === 0x49;
  if (!le && b[t] !== 0x4d) return null;
  const u16 = (o) => (le ? b[t + o] | (b[t + o + 1] << 8) : (b[t + o] << 8) | b[t + o + 1]);
  const u32 = (o) =>
    (le
      ? b[t + o] | (b[t + o + 1] << 8) | (b[t + o + 2] << 16) | (b[t + o + 3] << 24)
      : (b[t + o] << 24) | (b[t + o + 1] << 16) | (b[t + o + 2] << 8) | b[t + o + 3]) >>> 0;
  if (u16(2) !== 42) return null;
  const ifd = (o) => {
    const m = new Map();
    if (t + o + 2 > b.length) return m;
    const n = u16(o);
    for (let i = 0; i < n && i < 200; i++) {
      const e = o + 2 + i * 12;
      if (t + e + 12 > b.length) break;
      m.set(u16(e), { type: u16(e + 2), cnt: u32(e + 4), v: e + 8 });
    }
    return m;
  };
  const ascii = (m, tag) => {
    const x = m.get(tag);
    if (!x || x.type !== TYPE_ASCII) return null;
    const o = x.cnt > 4 ? u32(x.v) : x.v;
    let s = "";
    for (let i = 0; i < x.cnt && t + o + i < b.length; i++) {
      const c = b[t + o + i];
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  const ifd0 = ifd(u32(4));
  let d = null;
  let off = null;
  const ex = ifd0.get(TAG_EXIF_IFD);
  if (ex) {
    const m = ifd(u32(ex.v));
    d = ascii(m, TAG_DATETIME_ORIGINAL);
    off = ascii(m, TAG_OFFSET_ORIGINAL);
  }
  d = d || ascii(ifd0, TAG_DATETIME);
  if (!d || !/^\d{4}:\d\d:\d\d \d\d:\d\d:\d\d/.test(d)) return null;
  return { d: d.slice(0, 19), off: off && /^[+-]\d\d:\d\d$/.test(off) ? off : null };
}

// file: a File or Blob. Finds the "Exif\0\0" header anywhere (JPEG APP1, or inside HEIC).
export async function readDate(file) {
  try {
    const b = new Uint8Array(await file.arrayBuffer());
    for (let i = b.indexOf(0x45); i >= 0 && i < b.length - 12; i = b.indexOf(0x45, i + 1)) {
      if (b[i + 1] === 0x78 && b[i + 2] === 0x69 && b[i + 3] === 0x66 && b[i + 4] === 0 && b[i + 5] === 0) {
        const r = parseTiff(b, i + 6);
        if (r) return r;
      }
    }
  } catch (e) {
    console.warn(e);
  }
  return null;
}

// A complete JPEG APP1 segment: orientation 1 (the canvas is already upright) and the date tags.
export function exifSegment(dt) {
  const ascii = (s) => [...s].map((c) => c.charCodeAt(0)).concat(0);
  const tags = [
    [TAG_DATETIME_ORIGINAL, ascii(dt.d)],
    [TAG_DATETIME_DIGITIZED, ascii(dt.d)],
  ];
  if (dt.off) tags.push([TAG_OFFSET_ORIGINAL, ascii(dt.off)], [TAG_OFFSET_DIGITIZED, ascii(dt.off)]);
  const exifAt = 8 + 2 + 2 * 12 + 4;
  const dataAt = exifAt + 2 + tags.length * 12 + 4;
  const out = [];
  const data = [];
  const u16 = (v) => out.push((v >> 8) & 255, v & 255);
  const u32 = (v) => out.push((v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255);
  out.push(0x4d, 0x4d, 0, 42); // big-endian TIFF
  u32(8);
  // IFD0: orientation = 1, pointer to the EXIF IFD
  u16(2);
  (u16(0x0112), u16(3), u32(1), u16(1), u16(0));
  (u16(TAG_EXIF_IFD), u16(4), u32(1), u32(exifAt));
  u32(0);
  // EXIF IFD: the date tags, values stored after it
  u16(tags.length);
  for (const [tag, val] of tags) {
    (u16(tag), u16(TYPE_ASCII), u32(val.length), u32(dataAt + data.length));
    data.push(...val);
    if (data.length % 2) data.push(0);
  }
  u32(0);
  out.push(...data);
  const len = out.length + 8;
  return new Uint8Array([0xff, 0xe1, len >> 8, len & 255, 0x45, 0x78, 0x69, 0x66, 0, 0, ...out]);
}

// Insert the EXIF segment right after SOI (and after a JFIF APP0 if there is one). Other segments,
// such as the ICC colour profile, are kept as they are. Non-JPEG blobs come back unchanged.
export async function withExif(blob, dt) {
  const b = new Uint8Array(await blob.arrayBuffer());
  if (b[0] !== 0xff || b[1] !== 0xd8) return blob;
  const at = b[2] === 0xff && b[3] === 0xe0 ? 4 + ((b[4] << 8) | b[5]) : 2;
  return new Blob([b.subarray(0, at), exifSegment(dt), b.subarray(at)], { type: "image/jpeg" });
}

// the date as local time in ms, for the saved file's lastModified
export const dateMs = (dt) => {
  const m = dt.d.match(/(\d+):(\d+):(\d+) (\d+):(\d+):(\d+)/);
  return new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
};
