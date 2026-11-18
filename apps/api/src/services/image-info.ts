/**
 * Recognises a picture from its first bytes (never trusts the file name or browser)
 * and reads its width and height. Only JPEG, PNG, WebP and GIF are accepted.
 */
export interface ImageInfo {
  mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  width: number;
  height: number;
}

export function imageInfo(b: Buffer): ImageInfo | null {
  if (b.length < 24) return null;
  // PNG: signature, then IHDR width/height
  if (b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) {
    return { mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  // GIF
  if (b.toString('latin1', 0, 4) === 'GIF8') return { mime: 'image/gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  // WebP (RIFF....WEBP + VP8 / VP8L / VP8X)
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8 ' && b.length >= 30) return { mime: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L' && b.length >= 25) {
      const bits = b.readUInt32LE(21);
      return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X' && b.length >= 30) return { mime: 'image/webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    return null;
  }
  // JPEG: walk the markers to the frame header (SOFn)
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
        i += marker === 0xff ? 1 : 2;
        continue;
      }
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: 'image/jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return null;
  }
  return null;
}
