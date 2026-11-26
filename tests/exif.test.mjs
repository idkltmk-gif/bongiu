// Date taken: read, written, read back. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readDate, withExif, exifSegment, dateMs } from "../js/exif.js";

// smallest byte layout that looks like a JPEG to withExif: SOI, a JFIF APP0, an ICC APP2, EOI
const jfif = [0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
const icc = [0xff, 0xe2, 0, 14, ...[..."ICC_PROFILE"].map((c) => c.charCodeAt(0)), 0];
const jpeg = (withApp0 = true) =>
  new Blob([new Uint8Array([0xff, 0xd8, ...(withApp0 ? jfif : []), ...icc, 0xff, 0xd9])]);
const bytes = async (b) => new Uint8Array(await b.arrayBuffer());

test("date and time zone survive a write and a read", async () => {
  const dt = { d: "2026:11:26 18:42:07", off: "+07:00" };
  const out = await withExif(jpeg(), dt);
  assert.deepEqual(await readDate(out), dt);
});

test("date without a time zone", async () => {
  const dt = { d: "2024:01:02 03:04:05", off: null };
  assert.deepEqual(await readDate(await withExif(jpeg(false), dt)), dt);
});

test("EXIF goes after SOI and APP0; the colour profile segment is kept", async () => {
  const b = await bytes(await withExif(jpeg(), { d: "2026:11:26 18:42:07", off: null }));
  assert.deepEqual([...b.slice(0, 2)], [0xff, 0xd8]);
  assert.deepEqual([...b.slice(2, 4)], [0xff, 0xe0]);
  const app1 = 2 + jfif.length;
  assert.deepEqual([...b.slice(app1, app1 + 2)], [0xff, 0xe1]);
  const len = (b[app1 + 2] << 8) | b[app1 + 3];
  assert.deepEqual([...b.slice(app1 + 2 + len, app1 + 4 + len)], [0xff, 0xe2], "ICC APP2 follows the new segment");
});

test("segment length field matches its size", () => {
  const seg = exifSegment({ d: "2026:11:26 18:42:07", off: "-05:00" });
  assert.equal((seg[2] << 8) | seg[3], seg.length - 2);
});

test("a PNG blob is returned unchanged", async () => {
  const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]);
  assert.equal(await withExif(png, { d: "2026:11:26 18:42:07", off: null }), png);
});

test("little-endian EXIF (as some cameras write it) is read too", async () => {
  // TIFF II header, IFD0 with one DateTime (0x0132) tag
  const d = "2023:05:06 07:08:09\0";
  const tiff = [0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x32, 0x01, 2, 0, d.length, 0, 0, 0, 26, 0, 0, 0, 0, 0, 0, 0];
  const data = [...d].map((c) => c.charCodeAt(0));
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff, ...data];
  const file = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, app1.length + 2, ...app1, 0xff, 0xd9])]);
  assert.deepEqual(await readDate(file), { d: "2023:05:06 07:08:09", off: null });
});

test("no EXIF: null", async () => {
  assert.equal(await readDate(jpeg()), null);
});

test("dateMs reads the date as local time", () => {
  assert.equal(dateMs({ d: "2026:11:26 18:42:07", off: null }), new Date(2026, 10, 26, 18, 42, 7).getTime());
});
