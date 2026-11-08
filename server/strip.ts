// Removes what a photo says about the person who took it before a receipt is kept: EXIF (with the GPS position, the
// phone and the time), XMP, IPTC and comments. Only the image and what is needed to show it stay: the JPEG's JFIF,
// colour profile and Adobe segments, PNG's colour and size chunks, WebP's colour profile. A photo's orientation is
// kept: a JPEG keeps a new EXIF segment with the orientation tag alone, and HEIC keeps its rotation, which is a property
// of the image there, not EXIF. Pure TypeScript, no native library: the files are rewritten box by box, and the image
// data itself is copied byte for byte.
//
// HEIC cannot be rewritten without moving its image data (item locations are byte offsets), so its EXIF and XMP items
// are overwritten with zeros in place instead. A HEIC whose metadata cannot be found that way is refused.

export class StripError extends Error {}

// ------------------------------------------------------------------ JPEG

/** The EXIF orientation (1 to 8) in an APP1 segment's data, or null. */
function exifOrientation(d: Buffer): number | null {
  if (d.length < 14 || d.toString("latin1", 0, 6) !== "Exif\0\0") return null;
  const t = d.subarray(6);
  const le = t.toString("latin1", 0, 2) === "II";
  if (!le && t.toString("latin1", 0, 2) !== "MM") return null;
  const u16 = (at: number) => (le ? t.readUInt16LE(at) : t.readUInt16BE(at));
  const u32 = (at: number) => (le ? t.readUInt32LE(at) : t.readUInt32BE(at));
  const ifd = u32(4);
  if (ifd + 2 > t.length) return null;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const at = ifd + 2 + i * 12;
    if (at + 12 > t.length) return null;
    if (u16(at) === 0x0112) {
      const v = u16(at + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

/** An APP1 segment holding only the orientation tag. */
function orientationSegment(o: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write("MM", 0, "latin1");
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4); // IFD0 follows the header
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(0x0112, 10); // Orientation
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14); // one value
  tiff.writeUInt16BE(o, 18); // the value, left-aligned in the 4 bytes
  tiff.writeUInt32BE(0, 22); // no next IFD
  const data = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xffe1, 0);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
}

export function stripJpeg(b: Buffer): Buffer {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new StripError("Not a JPEG.");
  const keep: Buffer[] = [b.subarray(0, 2)];
  let orientation: number | null = null;
  let at = 2;
  let jfifAt = -1;
  for (;;) {
    if (at + 4 > b.length) throw new StripError("The JPEG ends before its image data.");
    if (b[at] !== 0xff) throw new StripError("The JPEG's segments cannot be read.");
    const marker = b[at + 1]!;
    if (marker === 0xff) {
      at++; // fill byte
      continue;
    }
    // Start of scan: the image data and everything after it are copied as they are.
    if (marker === 0xda) {
      keep.push(b.subarray(at));
      break;
    }
    if (marker === 0xd9) throw new StripError("The JPEG has no image data.");
    const len = b.readUInt16BE(at + 2);
    if (len < 2 || at + 2 + len > b.length) throw new StripError("A JPEG segment runs past the end of the file.");
    const seg = b.subarray(at, at + 2 + len);
    const data = b.subarray(at + 4, at + 2 + len);
    const isApp = marker >= 0xe0 && marker <= 0xef;
    if (marker === 0xe1) orientation ??= exifOrientation(data);
    const keepIt =
      !isApp && marker !== 0xfe
        ? true // tables, frame headers and the rest of the image's own segments
        : (marker === 0xe0 && data.toString("latin1", 0, 5) === "JFIF\0") ||
          (marker === 0xe2 && data.toString("latin1", 0, 12) === "ICC_PROFILE\0") ||
          (marker === 0xee && data.toString("latin1", 0, 5) === "Adobe");
    if (keepIt) {
      if (marker === 0xe0 && jfifAt < 0) jfifAt = keep.length;
      keep.push(seg);
    }
    at += 2 + len;
  }
  // The orientation goes right after SOI and JFIF, where readers look for EXIF.
  if (orientation !== null && orientation !== 1) keep.splice(jfifAt >= 0 ? jfifAt + 1 : 1, 0, orientationSegment(orientation));
  return Buffer.concat(keep);
}

// ------------------------------------------------------------------ PNG

const PNG_DROP = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);

export function stripPng(b: Buffer): Buffer {
  const keep: Buffer[] = [b.subarray(0, 8)];
  let at = 8;
  while (at < b.length) {
    if (at + 12 > b.length) throw new StripError("A PNG chunk runs past the end of the file.");
    const len = b.readUInt32BE(at);
    const type = b.toString("latin1", at + 4, at + 8);
    const end = at + 12 + len;
    if (end > b.length) throw new StripError("A PNG chunk runs past the end of the file.");
    if (!PNG_DROP.has(type)) keep.push(b.subarray(at, end));
    at = end;
    if (type === "IEND") break;
  }
  return Buffer.concat(keep);
}

// ------------------------------------------------------------------ WebP

export function stripWebp(b: Buffer): Buffer {
  const keep: Buffer[] = [];
  let at = 12;
  while (at < b.length) {
    if (at + 8 > b.length) throw new StripError("A WebP chunk runs past the end of the file.");
    const type = b.toString("latin1", at, at + 4);
    const len = b.readUInt32LE(at + 4);
    const end = at + 8 + len + (len % 2);
    if (at + 8 + len > b.length) throw new StripError("A WebP chunk runs past the end of the file.");
    if (type !== "EXIF" && type !== "XMP ") {
      const chunk = Buffer.from(b.subarray(at, Math.min(end, b.length)));
      // The extended header says which chunks follow: EXIF and XMP no longer do.
      if (type === "VP8X" && len >= 1) chunk[8] = chunk[8]! & ~0x0c;
      keep.push(chunk);
    }
    at = end;
  }
  const body = Buffer.concat(keep);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(body.length + 4, 4);
  head.write("WEBP", 8, "latin1");
  return Buffer.concat([head, body]);
}

// ------------------------------------------------------------------ HEIC

interface Box {
  type: string;
  start: number;
  body: number;
  end: number;
}

function boxes(b: Buffer, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = b.readUInt32BE(at);
    const type = b.toString("latin1", at + 4, at + 8);
    let body = at + 8;
    if (size === 1) {
      if (at + 16 > to) throw new StripError("A HEIC box runs past its end.");
      size = Number(b.readBigUInt64BE(at + 8));
      body = at + 16;
    } else if (size === 0) size = to - at;
    if (size < body - at || at + size > to) throw new StripError("A HEIC box runs past its end.");
    out.push({ type, start: at, body, end: at + size });
    at += size;
  }
  return out;
}

const uint = (b: Buffer, at: number, size: number): number =>
  size === 0 ? 0 : size === 2 ? b.readUInt16BE(at) : size === 4 ? b.readUInt32BE(at) : size === 8 ? Number(b.readBigUInt64BE(at)) : NaN;

export function stripHeic(input: Buffer): Buffer {
  const b = Buffer.from(input);
  const meta = boxes(b, 0, b.length).find((x) => x.type === "meta");
  if (!meta) return b;
  const inner = boxes(b, meta.body + 4, meta.end); // meta is a full box: version and flags first
  const iinf = inner.find((x) => x.type === "iinf");
  const iloc = inner.find((x) => x.type === "iloc");
  if (!iinf) return b;
  // Which items are EXIF or XMP.
  const drop = new Set<number>();
  const iv = b[iinf.body]!;
  const first = iinf.body + 4 + (iv === 0 ? 2 : 4);
  for (const infe of boxes(b, first, iinf.end).filter((x) => x.type === "infe")) {
    const v = b[infe.body]!;
    if (v < 2) continue; // versions 0 and 1 carry no item type
    let at = infe.body + 4;
    const id = v === 2 ? b.readUInt16BE(at) : b.readUInt32BE(at);
    at += (v === 2 ? 2 : 4) + 2; // item id, protection index
    const type = b.toString("latin1", at, at + 4);
    at += 4;
    const nameEnd = b.indexOf(0, at);
    if (type === "Exif") drop.add(id);
    if (type === "mime" && nameEnd >= 0 && nameEnd < infe.end) {
      const ctEnd = b.indexOf(0, nameEnd + 1);
      const contentType = b.toString("latin1", nameEnd + 1, ctEnd < 0 || ctEnd > infe.end ? infe.end : ctEnd);
      if (/xmp|rdf\+xml/i.test(contentType)) drop.add(id);
    }
  }
  if (!drop.size) return b;
  if (!iloc) throw new StripError("The HEIC's metadata cannot be found to remove it.");
  // Where those items' bytes are, and overwrite them.
  const v = b[iloc.body]!;
  let at = iloc.body + 4;
  const offsetSize = b[at]! >> 4;
  const lengthSize = b[at]! & 15;
  const baseSize = b[at + 1]! >> 4;
  const indexSize = v === 1 || v === 2 ? b[at + 1]! & 15 : 0;
  at += 2;
  const count = v < 2 ? b.readUInt16BE(at) : b.readUInt32BE(at);
  at += v < 2 ? 2 : 4;
  let cleared = 0;
  for (let i = 0; i < count; i++) {
    const id = v < 2 ? b.readUInt16BE(at) : b.readUInt32BE(at);
    at += v < 2 ? 2 : 4;
    let method = 0;
    if (v === 1 || v === 2) {
      method = b.readUInt16BE(at) & 15;
      at += 2;
    }
    at += 2; // data reference index
    const base = uint(b, at, baseSize);
    at += baseSize;
    const extents = b.readUInt16BE(at);
    at += 2;
    for (let e = 0; e < extents; e++) {
      at += indexSize;
      const off = uint(b, at, offsetSize);
      at += offsetSize;
      const len = uint(b, at, lengthSize);
      at += lengthSize;
      if (!drop.has(id)) continue;
      if (method !== 0) throw new StripError("The HEIC keeps its metadata in a way that cannot be removed in place.");
      const from = base + off;
      const to = len === 0 ? b.length : from + len;
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > b.length || from >= to)
        throw new StripError("The HEIC's metadata is outside the file.");
      b.fill(0, from, to);
      cleared++;
    }
    if (at > iloc.end) throw new StripError("The HEIC's item locations cannot be read.");
  }
  if (!cleared) throw new StripError("The HEIC's metadata cannot be found to remove it.");
  return b;
}

/** The file without its metadata, for the types receipts may be. PDFs are returned as they are. */
export function stripMetadata(b: Buffer, type: string): Buffer {
  try {
    if (type === "image/jpeg") return stripJpeg(b);
    if (type === "image/png") return stripPng(b);
    if (type === "image/webp") return stripWebp(b);
    if (type === "image/heic") return stripHeic(b);
    return b;
  } catch (err) {
    if (err instanceof StripError) throw err;
    throw new StripError(`The image cannot be read: ${(err as Error).message}`);
  }
}
