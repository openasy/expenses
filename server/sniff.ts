// What a receipt's file is, from its first bytes: a file is taken only when its bytes are one of the types the file
// allows, whatever name or type it was sent with, so a page renamed to .jpg is refused. A PDF that carries scripts or
// asks to launch something is refused too: an accountant opens these.

const starts = (b: Buffer, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);
const HEIF_BRANDS = ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"];

export function sniff(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (starts(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts(b, [0x52, 0x49, 0x46, 0x46]) && starts(b, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  if (b.toString("latin1", 4, 8) === "ftyp" && HEIF_BRANDS.includes(b.toString("latin1", 8, 12))) return "image/heic";
  if (starts(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  return null;
}

/** Why a PDF is refused, or null. Names in a PDF may be written with #xx escapes, so they are decoded first. */
export function unsafePdf(b: Buffer): string | null {
  const s = b.toString("latin1").replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  if (/\/(JavaScript|JS)\b/.test(s)) return "The PDF carries scripts.";
  if (/\/(Launch|EmbeddedFile|RichMedia)\b/.test(s)) return "The PDF launches or embeds other files.";
  return null;
}

/** Types a browser shows as an image without running anything; everything else is downloaded. */
export const INLINE = new Set(["image/jpeg", "image/png", "image/webp"]);
