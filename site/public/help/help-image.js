// A screenshot for Ask Help, made safe to send: redrawn through a canvas, so only the pixels
// survive (EXIF/GPS, camera, text chunks gone), and scaled to 2048 px at most, the same way the
// composer treats every picture (web/chat/composer.js cleanPicture). Browser only.

import { HELP_LIMITS, hasImageMetadata, toBase64 } from './help-core.js';

const MAX_SIDE = 2048;

export class ScreenshotError extends Error {}

/** A picture File/Blob → { mime, data (base64), url (for the thumbnail; revoke it), name, width, height, bytes }. */
export async function cleanScreenshot(file) {
  if (!file || !/^image\//.test(file.type || '')) throw new ScreenshotError('That isn’t a picture. Attach a screenshot (PNG or JPEG).');
  if (file.size > 40 * 1024 * 1024) throw new ScreenshotError('That picture is too big. Take a smaller screenshot, or crop it.');
  let src = null;
  let url = null;
  try {
    try {
      src = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      url = URL.createObjectURL(file);
      src = new Image();
      src.src = url;
      await src.decode();
    }
    const w0 = src.naturalWidth || src.width;
    const h0 = src.naturalHeight || src.height;
    if (!w0 || !h0) throw new ScreenshotError('That picture couldn’t be read.');
    const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    const encode = (type, quality) => {
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const g = cv.getContext('2d');
      if (type === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); }
      g.drawImage(src, 0, 0, w, h);
      return new Promise((r) => cv.toBlob(r, type, quality));
    };
    // screenshots are sharp-edged text: PNG, unless that's too big
    let blob = await encode('image/png');
    if (!blob || blob.size > HELP_LIMITS.imageBytes * 0.9) blob = await encode('image/jpeg', 0.86);
    if (!blob || blob.size > HELP_LIMITS.imageBytes) throw new ScreenshotError('That screenshot is too big even when shrunk. Crop it to the part that matters.');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (hasImageMetadata(bytes)) throw new ScreenshotError('That picture couldn’t be cleaned. Take a new screenshot.'); // a canvas never writes any: belt and braces
    return {
      mime: blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png',
      data: toBase64(bytes),
      url: URL.createObjectURL(blob),
      name: (file.name || 'Screenshot').replace(/\.[^.]*$/, '').slice(0, 80) || 'Screenshot',
      width: w,
      height: h,
      bytes: bytes.length,
    };
  } finally {
    if (src && typeof src.close === 'function') src.close();
    if (url) URL.revokeObjectURL(url);
  }
}
