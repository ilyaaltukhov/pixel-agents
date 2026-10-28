import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TERMINAL_IMAGE_KEEP_MS, TERMINAL_IMAGE_MAX_BYTES } from '../src/constants.js';
import { savePastedImage } from '../src/terminal/pastedImages.js';

describe('savePastedImage', () => {
  let dir: string;
  beforeEach(() => {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-pasted-')), 'pasted');
  });
  afterEach(() => {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it('writes the decoded bytes privately, named for the agent and type', () => {
    const file = savePastedImage(3, 'image/jpeg', Buffer.from('jpeg!').toString('base64'), dir);
    expect(file).not.toBeNull();
    expect(path.basename(file!)).toMatch(/^agent3-\d+-[0-9a-f]{8}\.jpg$/);
    expect(fs.readFileSync(file!, 'utf-8')).toBe('jpeg!');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('refuses empty and oversized images', () => {
    expect(savePastedImage(1, 'image/png', '', dir)).toBeNull();
    const big = Buffer.alloc(TERMINAL_IMAGE_MAX_BYTES + 1).toString('base64');
    expect(savePastedImage(1, 'image/png', big, dir)).toBeNull();
  });

  it('prunes images older than the keep window', () => {
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'agent1-old.png');
    fs.writeFileSync(old, 'x');
    const past = (Date.now() - TERMINAL_IMAGE_KEEP_MS - 60_000) / 1000;
    fs.utimesSync(old, past, past);
    savePastedImage(1, 'image/png', Buffer.from('new').toString('base64'), dir);
    expect(fs.existsSync(old)).toBe(false);
  });
});
