import { crc32, deflateSync } from "node:zlib";
import { decode as decodeJpeg } from "jpeg-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stripHeic, stripJpeg, stripPng, stripWebp, StripError } from "./strip.ts";
import { ALI, jpeg, startApp, tokenOf, type TestApp } from "./test-app.ts";

/** An APP1 EXIF segment, little-endian, with Make, the orientation and a GPS IFD holding a latitude. */
function exifSegment(orientation: number): Buffer {
  const t = Buffer.alloc(120);
  t.write("II", 0, "latin1");
  t.writeUInt16LE(42, 2);
  t.writeUInt32LE(8, 4);
  t.writeUInt16LE(3, 8); // three entries in IFD0
  const entry = (i: number, tag: number, type: number, count: number, value: number) => {
    const at = 10 + i * 12;
    t.writeUInt16LE(tag, at);
    t.writeUInt16LE(type, at + 2);
    t.writeUInt32LE(count, at + 4);
    t.writeUInt32LE(value, at + 8);
  };
  entry(0, 0x010f, 2, 12, 60); // Make, at 60
  entry(1, 0x0112, 3, 1, orientation); // Orientation
  entry(2, 0x8825, 4, 1, 80); // GPS IFD, at 80
  t.writeUInt32LE(0, 46);
  t.write("PhoneCo X12\0", 60, "latin1");
  t.writeUInt16LE(1, 80); // one GPS entry
  t.writeUInt16LE(0x0001, 82); // GPSLatitudeRef
  t.writeUInt16LE(2, 84);
  t.writeUInt32LE(2, 86);
  t.write("N\0", 90, "latin1");
  t.write("GPS 41.0082 28.9784", 96, "latin1");
  return app1(Buffer.concat([Buffer.from("Exif\0\0", "latin1"), t]), 0xe1);
}

function app1(data: Buffer, marker: number): Buffer {
  const h = Buffer.alloc(4);
  h.writeUInt16BE(0xff00 | marker, 0);
  h.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([h, data]);
}

/** The JPEG with EXIF and GPS, XMP, IPTC and a comment put in after its JFIF segment. */
function withMetadata(clean: Buffer, orientation = 6): Buffer {
  const jfifEnd = 2 + 2 + clean.readUInt16BE(4);
  return Buffer.concat([
    clean.subarray(0, jfifEnd),
    exifSegment(orientation),
    app1(Buffer.from("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><exif:GPSLatitude>41,0.4920N</exif:GPSLatitude></x:xmpmeta>", "latin1"), 0xe1),
    app1(Buffer.from("Photoshop 3.0\0 8BIM IPTC city Istanbul", "latin1"), 0xed),
    app1(Buffer.from("taken at home", "latin1"), 0xfe),
    clean.subarray(jfifEnd),
  ]);
}

const has = (b: Buffer, s: string) => b.includes(Buffer.from(s, "latin1"));
const scan = (b: Buffer) => b.subarray(b.indexOf(Buffer.from([0xff, 0xda])));

describe("JPEG", () => {
  it("drops EXIF with GPS, XMP, IPTC and comments, keeps the orientation, and still decodes to the same pixels", () => {
    const clean = jpeg(5);
    const dirty = withMetadata(clean);
    expect(has(dirty, "GPS 41.0082")).toBe(true);
    const out = stripJpeg(dirty);
    for (const s of ["GPS 41.0082", "PhoneCo", "xmpmeta", "8BIM", "taken at home"]) expect(has(out, s), s).toBe(false);
    // Orientation 6 (rotate 90°), alone in a new EXIF segment.
    const exif = out.indexOf(Buffer.from("Exif\0\0", "latin1"));
    expect(exif).toBeGreaterThan(0);
    expect(out.readUInt16BE(exif + 6 + 18)).toBe(6);
    expect(scan(out).equals(scan(clean))).toBe(true);
    const a = decodeJpeg(clean, { useTArray: true });
    const b = decodeJpeg(out, { useTArray: true });
    expect([b.width, b.height]).toEqual([16, 16]);
    expect(Buffer.from(b.data).equals(Buffer.from(a.data))).toBe(true);
  });

  it("adds no EXIF when the photo is upright", () => {
    const out = stripJpeg(withMetadata(jpeg(6), 1));
    expect(has(out, "Exif")).toBe(false);
    expect(decodeJpeg(out).width).toBe(16);
  });

  it("refuses a JPEG it cannot read", () => {
    expect(() => stripJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x40, 0x00, 1, 2]))).toThrow(StripError);
  });
});

describe("PNG and WebP", () => {
  const chunk = (type: string, data: Buffer) => {
    const h = Buffer.alloc(8);
    h.writeUInt32BE(data.length, 0);
    h.write(type, 4, "latin1");
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc32(Buffer.concat([h.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([h, data, c]);
  };

  it("drops PNG's eXIf, text and time chunks and keeps the image's", () => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr.set([8, 2, 0, 0, 0], 8);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("eXIf", Buffer.from("MM\0*GPS 41.0082", "latin1")),
      chunk("tEXt", Buffer.from("Author\0Ali", "latin1")),
      chunk("iTXt", Buffer.from("XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>", "latin1")),
      chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0]))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    const out = stripPng(png);
    for (const s of ["eXIf", "GPS", "tEXt", "iTXt", "xmpmeta"]) expect(has(out, s), s).toBe(false);
    expect(["IHDR", "IDAT", "IEND"].every((s) => has(out, s))).toBe(true);
  });

  it("drops WebP's EXIF and XMP chunks and their flags", () => {
    const riff = (chunks: Buffer[]) => {
      const body = Buffer.concat(chunks);
      const h = Buffer.alloc(12);
      h.write("RIFF", 0, "latin1");
      h.writeUInt32LE(body.length + 4, 4);
      h.write("WEBP", 8, "latin1");
      return Buffer.concat([h, body]);
    };
    const c = (type: string, data: Buffer) => {
      const h = Buffer.alloc(8);
      h.write(type, 0, "latin1");
      h.writeUInt32LE(data.length, 4);
      return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    };
    const vp8x = Buffer.alloc(10);
    vp8x[0] = 0x0c;
    const out = stripWebp(
      riff([c("VP8X", vp8x), c("VP8L", Buffer.from("image", "latin1")), c("EXIF", Buffer.from("GPS 41.0082", "latin1")), c("XMP ", Buffer.from("<x/>"))]),
    );
    expect(has(out, "GPS")).toBe(false);
    expect(has(out, "XMP ")).toBe(false);
    expect(out[20]! & 0x0c).toBe(0);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    expect(has(out, "VP8L")).toBe(true);
  });
});

describe("HEIC", () => {
  const box = (type: string, ...parts: Buffer[]) => {
    const body = Buffer.concat(parts);
    const h = Buffer.alloc(8);
    h.writeUInt32BE(body.length + 8, 0);
    h.write(type, 4, "latin1");
    return Buffer.concat([h, body]);
  };
  const full = (v: number) => Buffer.from([v, 0, 0, 0]);
  const u16 = (n: number) => Buffer.from([n >> 8, n & 255]);
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };

  /** ftyp, meta with an image item and an Exif item, and mdat with their bytes. */
  function heic(exifItem = true): Buffer {
    const image = Buffer.from("HEVC-IMAGE-DATA", "latin1");
    const exif = Buffer.from("\0\0\0\0MM\0*GPS 41.0082", "latin1");
    const build = (mdatAt: number) => {
      const infe = (id: number, type: string) => box("infe", full(2), u16(id), u16(0), Buffer.from(type, "latin1"), Buffer.from([0]));
      const iinf = box("iinf", full(0), u16(exifItem ? 2 : 1), infe(1, "hvc1"), ...(exifItem ? [infe(2, "Exif")] : []));
      const loc = (id: number, off: number, len: number) => Buffer.concat([u16(id), u16(0), u16(1), u32(off), u32(len)]);
      const iloc = box(
        "iloc",
        full(0),
        Buffer.from([0x44, 0x00]),
        u16(exifItem ? 2 : 1),
        loc(1, mdatAt + 8, image.length),
        ...(exifItem ? [loc(2, mdatAt + 8 + image.length, exif.length)] : []),
      );
      const meta = box(
        "meta",
        full(0),
        box("hdlr", full(0), u32(0), Buffer.from("pict", "latin1"), Buffer.alloc(13)),
        iinf,
        iloc,
        box("iprp", box("ipco", box("irot", Buffer.from([1])))),
      );
      const ftyp = box("ftyp", Buffer.from("heic\0\0\0\0mif1heic", "latin1"));
      return Buffer.concat([ftyp, meta]);
    };
    const head = build(0);
    return Buffer.concat([build(head.length), box("mdat", image, exif)]);
  }

  it("overwrites the Exif item's bytes and leaves the image and its rotation", () => {
    const b = heic();
    const out = stripHeic(b);
    expect(out.length).toBe(b.length);
    expect(has(out, "GPS 41.0082")).toBe(false);
    expect(has(out, "HEVC-IMAGE-DATA")).toBe(true);
    expect(has(out, "irot")).toBe(true);
  });

  it("leaves a HEIC without metadata as it is", () => {
    const b = heic(false);
    expect(stripHeic(b).equals(b)).toBe(true);
  });
});

describe("uploads", () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await startApp();
  });
  afterEach(() => app.close());

  it("keeps a photo with GPS without it, and finds it again whatever metadata it came with", async () => {
    const clean = jpeg(8);
    const first = await app.upload(ALI, withMetadata(clean, 6));
    expect(first.status).toBe(201);
    const res = await fetch(`${app.base}/api/v1/receipts/${first.body.id}/file`, { headers: { authorization: `Bearer ${tokenOf(ALI)}` } });
    const kept = Buffer.from(await res.arrayBuffer());
    expect(has(kept, "GPS")).toBe(false);
    expect(has(kept, "PhoneCo")).toBe(false);
    expect(decodeJpeg(kept).width).toBe(16);
    expect(first.body.size).toBe(kept.length);
    // The hash is of what is kept: the same photo with other metadata, is the same receipt.
    const again = await app.upload(ALI, withMetadataOther(clean));
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
  });

  it("refuses an image whose metadata cannot be removed", async () => {
    const r = await app.upload(ALI, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x7f, 0xff]), Buffer.alloc(20)]));
    expect(r.status).toBe(415);
    expect(r.body.detail).toContain("metadata could not be removed");
  });
});

/** The same photo with a different comment and EXIF: stripped, it is the same file. */
function withMetadataOther(clean: Buffer): Buffer {
  const jfifEnd = 2 + 2 + clean.readUInt16BE(4);
  return Buffer.concat([clean.subarray(0, jfifEnd), app1(Buffer.from("another phone", "latin1"), 0xfe), exifSegment(6), clean.subarray(jfifEnd)]);
}
