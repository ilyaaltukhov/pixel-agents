import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findClaudePid, liveClaudeSessions } from '../src/claudeLiveSessions.js';
import { parseTmuxEnviron, tmuxAttachArgs } from '../src/terminal/tmuxConsole.js';

describe('parseTmuxEnviron', () => {
  it('reads the socket path and pane id', () => {
    const environ = [
      'HOME=/home/u',
      'TMUX=/tmp/tmux-1000/default,23423,0',
      'TMUX_PANE=%4',
      '',
    ].join('\0');
    expect(parseTmuxEnviron(environ)).toEqual({
      socketPath: '/tmp/tmux-1000/default',
      paneId: '%4',
      homeSessionId: '$0',
    });
  });

  it('is null outside tmux', () => {
    expect(parseTmuxEnviron(['HOME=/home/u', 'TERM=xterm'].join('\0'))).toBeNull();
  });

  it('is null for a malformed pane id', () => {
    expect(parseTmuxEnviron(['TMUX=/tmp/s,1,0', 'TMUX_PANE=4'].join('\0'))).toBeNull();
  });
});

describe('findClaudePid', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sessions-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const register = (pid: number, sessionId: string): void => {
    fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId }));
  };

  it('finds the live process running the session', () => {
    register(process.pid, 'sess-a');
    expect(findClaudePid(['other', 'sess-a'], dir)).toBe(process.pid);
  });

  it('skips a registry entry whose process is gone', () => {
    // Max pid on Linux is 2^22; this one cannot be alive.
    register(2 ** 22 + 1, 'sess-a');
    expect(findClaudePid(['sess-a'], dir)).toBeNull();
  });

  it('lists every live session', () => {
    register(process.pid, 'sess-a');
    register(2 ** 22 + 1, 'sess-dead');
    expect([...liveClaudeSessions(dir)]).toEqual([['sess-a', process.pid]]);
  });

  it('ignores half-written entries and a missing directory', () => {
    fs.writeFileSync(path.join(dir, '1.json'), '{"pid":');
    expect(findClaudePid(['sess-a'], dir)).toBeNull();
    expect(findClaudePid(['sess-a'], path.join(dir, 'missing'))).toBeNull();
  });
});

describe('tmuxAttachArgs', () => {
  it('groups with the target session and selects the window in its own session', () => {
    const args = tmuxAttachArgs(
      { socketPath: '/tmp/s', paneId: '%1', sessionId: '$2', windowIndex: '3' },
      'pixel-agents-7-x',
    );
    expect(args).toEqual([
      '-S',
      '/tmp/s',
      'new-session',
      '-t',
      '$2',
      '-s',
      'pixel-agents-7-x',
      ';',
      'set-option',
      'destroy-unattached',
      'on',
      ';',
      'select-window',
      '-t',
      'pixel-agents-7-x:3',
    ]);
  });
});
