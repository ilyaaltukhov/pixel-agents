/**
 * Images pasted (or dropped) into a browser terminal.
 *
 * The agent runs on this machine and cannot read the browser's clipboard, so
 * the image travels over the terminal socket, lands here as a file, and its
 * path is pasted into the terminal instead -- which is exactly what dropping a
 * file into a local terminal does, and Claude Code attaches an image path
 * pasted that way.
 *
 * Files are private to the operator (0700 dir, 0600 files) and pruned after
 * TERMINAL_IMAGE_KEEP_MS, so the directory never grows without bound.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { TerminalImageType } from '../../../core/src/terminalFrames.js';
import { TERMINAL_IMAGE_KEEP_MS, TERMINAL_IMAGE_MAX_BYTES } from '../constants.js';

const EXTENSIONS: Record<TerminalImageType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export function pastedImagesDir(): string {
  return path.join(os.homedir(), '.pixel-agents', 'pasted');
}

/**
 * Save a base64 image for an agent. Returns its absolute path, or null when
 * the data is empty or too large (the frame is then simply dropped).
 */
export function savePastedImage(
  agentId: number,
  mime: TerminalImageType,
  base64: string,
  dir: string = pastedImagesDir(),
): string | null {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0 || bytes.length > TERMINAL_IMAGE_MAX_BYTES) return null;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  pruneOldImages(dir);
  const name = `agent${agentId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${EXTENSIONS[mime]}`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return file;
}

function pruneOldImages(dir: string): void {
  const cutoff = Date.now() - TERMINAL_IMAGE_KEEP_MS;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {
      // Raced with another prune, or not ours to delete: leave it.
    }
  }
}
