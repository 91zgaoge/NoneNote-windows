import { bytesToBase64 } from "../core/base64.ts";
import type { ImageData } from "../core/attachment/analyzer.ts";
import type { Attachment } from "../core/types.ts";

/** Longest edge of the vision payload (Android VisionImagePrep parity). */
const MAX_EDGE = 1568;

/** White-backed JPEG raster of a bitmap source, downscaled to MAX_EDGE. */
async function rasterToJpeg(
  source: ImageBitmap | OffscreenCanvas,
  w: number,
  h: number,
): Promise<ImageData> {
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = new OffscreenCanvas(cw, ch);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d unavailable");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(source as CanvasImageSource, 0, 0, cw, ch);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { mime: "image/jpeg", dataUrl: `data:image/jpeg;base64,${bytesToBase64(bytes)}` };
}

/**
 * Canvas-based VisionImagePrep for the webview: images are decoded and
 * downscaled; PDFs get their first page rastered via pdfjs (a scanned-PDF
 * vision pass). Null means "no usable image for this attachment" — the
 * analyzer then skips the vision call silently, like Android.
 */
export async function visionPrep(a: Attachment, bytes: Uint8Array): Promise<ImageData | null> {
  try {
    if (a.mime === "application/pdf") {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const task = pdfjs.getDocument({
        data: bytes.slice(),
        useWorkerFetch: false,
        isEvalSupported: false,
      } as Parameters<typeof pdfjs.getDocument>[0]);
      const doc = await task.promise;
      try {
        const page = await doc.getPage(1);
        const base = page.getViewport({ scale: 1 });
        // Raster above the display scale so small print stays legible.
        const scale = Math.min(4, (MAX_EDGE * 2) / Math.max(base.width, base.height));
        const viewport = page.getViewport({ scale });
        const canvas = new OffscreenCanvas(
          Math.max(1, Math.round(viewport.width)),
          Math.max(1, Math.round(viewport.height)),
        );
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({
          canvas,
          canvasContext: ctx as unknown as CanvasRenderingContext2D,
          viewport,
        } as unknown as Parameters<typeof page.render>[0]).promise;
        const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
        const out = new Uint8Array(await blob.arrayBuffer());
        return { mime: "image/jpeg", dataUrl: `data:image/jpeg;base64,${bytesToBase64(out)}` };
      } finally {
        await task.destroy();
      }
    }
    const blob = new Blob([bytes as unknown as BlobPart], { type: a.mime || "image/png" });
    const bmp = await createImageBitmap(blob);
    try {
      return await rasterToJpeg(bmp, bmp.width, bmp.height);
    } finally {
      bmp.close();
    }
  } catch {
    return null;
  }
}
