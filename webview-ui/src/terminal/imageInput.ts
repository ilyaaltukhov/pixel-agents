/**
 * Images into the terminal: paste (Cmd/Ctrl+V with an image on the clipboard)
 * and drag-and-drop onto the pane.
 *
 * The agent runs on the server and cannot read this browser's clipboard (its
 * own Ctrl+V image paste reads the server's), so an image is uploaded over the
 * terminal socket instead; the server saves it and the pane pastes the path —
 * what dropping a file into a local terminal does.
 *
 * Big photos are scaled down first: the model sees images at most a couple of
 * thousand pixels across anyway, and a full-resolution phone photo would only
 * make the upload slow (or exceed the server's size cap).
 */

import type { TerminalImageType } from '../../../core/src/terminalFrames.js';
import { isTerminalImageType } from '../../../core/src/terminalFrames.js';

/** Longest side an uploaded image keeps; larger ones are scaled down. */
const IMAGE_MAX_SIDE_PX = 2000;
/** Images at or under this size (and side) are sent untouched. */
const IMAGE_PASSTHROUGH_BYTES = 3 * 1024 * 1024;
const IMAGE_REENCODE_QUALITY = 0.9;

/** Image files carried by a paste or drop, in order. */
export function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

/**
 * Catch image pastes and drops on `host` before xterm sees them (capture
 * phase): xterm would paste only the clipboard's text, i.e. nothing. Plain
 * text pastes pass through untouched. Returns a detach function.
 */
export function attachImageInput(host: HTMLElement, onImage: (image: Blob) => void): () => void {
  const onPaste = (ev: ClipboardEvent) => {
    const files = imageFilesFrom(ev.clipboardData);
    if (files.length === 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    files.forEach(onImage);
  };
  const onDragOver = (ev: DragEvent) => {
    // Without this the browser refuses the drop (or opens the file).
    if (ev.dataTransfer?.types.includes('Files')) ev.preventDefault();
  };
  const onDrop = (ev: DragEvent) => {
    const files = imageFilesFrom(ev.dataTransfer);
    if (files.length === 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    files.forEach(onImage);
  };
  host.addEventListener('paste', onPaste, true);
  host.addEventListener('dragover', onDragOver);
  host.addEventListener('drop', onDrop, true);
  return () => {
    host.removeEventListener('paste', onPaste, true);
    host.removeEventListener('dragover', onDragOver);
    host.removeEventListener('drop', onDrop, true);
  };
}

/** An image ready for the wire: an accepted type, base64, scaled if huge. */
export async function encodeImage(
  image: Blob,
): Promise<{ mime: TerminalImageType; data: string } | null> {
  const ready = await shrinkImage(image);
  if (!isTerminalImageType(ready.type)) return null;
  const buf = new Uint8Array(await ready.arrayBuffer());
  let binary = '';
  // Chunked: String.fromCharCode(...bytes) overflows the call stack on MBs.
  for (let i = 0; i < buf.length; i += 0x8000) {
    binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return { mime: ready.type, data: btoa(binary) };
}

/** Re-encode as JPEG at most IMAGE_MAX_SIDE_PX across when the image is big
 *  or of a type the agent can't take (HEIC, BMP...). The original otherwise. */
async function shrinkImage(image: Blob): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(image);
  } catch {
    return image; // Undecodable here: send as is, the type check decides.
  }
  const longest = Math.max(bitmap.width, bitmap.height);
  if (
    isTerminalImageType(image.type) &&
    image.size <= IMAGE_PASSTHROUGH_BYTES &&
    longest <= IMAGE_MAX_SIDE_PX
  ) {
    bitmap.close();
    return image;
  }
  const scale = Math.min(1, IMAGE_MAX_SIDE_PX / longest);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', IMAGE_REENCODE_QUALITY),
  );
  return blob ?? image;
}
