import { CHAT_IMAGE_LIMITS } from '@widebed/shared';

/** Is this file a photo (rather than a document)? */
export const isPhoto = (f: File) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(f.name);

/**
 * Shrinks a photo in the browser before it is sent: longest side 1600 px, JPEG.
 * Phone photos (4–8 MB) become about 200–400 KB, so they fit inside the chat (no file storage).
 */
export async function shrinkPhoto(file: File): Promise<{ blob: Blob; name: string }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  } catch {
    throw new Error(`${file.name} can’t be opened as a photo here. Use JPG or PNG (iPhone: Settings → Camera → Formats → Most Compatible).`);
  }
  const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
  let side = CHAT_IMAGE_LIMITS.maxSide;
  for (const quality of [0.82, 0.72, 0.62, 0.62, 0.55]) {
    const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#fff'; // transparent PNGs get a white background
    g.fillRect(0, 0, w, h);
    g.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality));
    if (blob && blob.size <= CHAT_IMAGE_LIMITS.maxBytes - 4096) {
      bitmap.close();
      return { blob, name };
    }
    side = Math.round(side * 0.8);
  }
  bitmap.close();
  throw new Error(`${file.name} is too detailed to send. Try a smaller photo or a screenshot.`);
}
