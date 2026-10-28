import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ window: { activeTerminal: undefined, terminals: [] } }));

// The registry of running Claude processes, as the global scanner sees it.
const running = new Map<string, number>();
vi.mock('../src/claudeLiveSessions.js', () => ({ liveClaudeSessions: () => running }));

import { AgentStateStore } from '../src/agentStateStore.js';
import { EXTERNAL_SCAN_INTERVAL_MS } from '../src/constants.js';
import { DismissalTracker } from '../src/dismissalTracker.js';
import {
  setDismissalTracker,
  setHookProvider,
  startExternalSessionScanning,
  transcriptTurnFinished,
} from '../src/fileWatcher.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';

/**
 * Watch All Sessions adopts a transcript only while it is active (written in the
 * last few minutes) -- except for a session whose Claude is still running,
 * which shows however long it has been idle, unless the user closed it.
 */
describe('global scan: running Claude sessions', () => {
  let root: string;
  let projectDir: string;
  let tracker: DismissalTracker;
  let agents: AgentStateStore;
  let pollingTimers: Map<number, ReturnType<typeof setInterval>>;

  const HOUR_AGO = (Date.now() - 3_600_000) / 1000;

  function idleTranscript(sessionId: string): string {
    const file = path.join(projectDir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ type: 'user', cwd: '/home/u/prj/bot_mother' })}\n`);
    fs.utimesSync(file, HOUR_AGO, HOUR_AGO);
    return file;
  }

  function scanOnce(): void {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const timer = startExternalSessionScanning(
      projectDir,
      new Set(),
      { current: 1 },
      agents,
      new Map(),
      pollingTimers,
      new Map(),
      new Map(),
      new Map(),
      () => {},
      { current: true },
      { current: true },
    );
    vi.advanceTimersByTime(EXTERNAL_SCAN_INTERVAL_MS);
    clearInterval(timer);
    vi.useRealTimers();
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-live-'));
    projectDir = path.join(root, '-home-u-prj-bot-mother');
    fs.mkdirSync(projectDir);
    setHookProvider({ ...claudeProvider, getAllSessionRoots: () => [root] });
    tracker = new DismissalTracker();
    setDismissalTracker(tracker);
    agents = new AgentStateStore();
    pollingTimers = new Map();
    running.clear();
  });

  afterEach(() => {
    for (const t of pollingTimers.values()) clearInterval(t);
    setHookProvider(claudeProvider);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('adopts an idle transcript whose Claude is running, named by its cwd', () => {
    idleTranscript('sess-live');
    running.set('sess-live', 4242);
    scanOnce();
    const adopted = [...agents.values()];
    expect(adopted).toHaveLength(1);
    expect(adopted[0].isExternal).toBe(true);
    expect(adopted[0].directoryName).toBe('bot_mother');
  });

  it('skips an idle transcript nobody has open', () => {
    idleTranscript('sess-gone');
    scanOnce();
    expect(agents.size).toBe(0);
  });

  it('keeps a running session the user closed away until it writes again', () => {
    const file = idleTranscript('sess-closed');
    running.set('sess-closed', 4242);
    // Closed half an hour ago: past the cooldown, but after its last write.
    tracker.dismiss(file, Date.now() - 1_800_000);
    scanOnce();
    expect(agents.size).toBe(0);

    fs.appendFileSync(file, `${JSON.stringify({ type: 'assistant' })}\n`);
    scanOnce();
    expect(agents.size).toBe(1);
  });
});

describe('transcriptTurnFinished', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-tail-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const transcript = (...records: object[]): string => {
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return file;
  };
  const say = (stop: string | null, ...blocks: string[]) => ({
    type: 'assistant',
    message: { stop_reason: stop, content: blocks.map((type) => ({ type })) },
  });

  it('is finished after the turn_duration marker, metadata after it skipped', () => {
    const file = transcript(
      { type: 'user', message: { content: 'hi' } },
      say('end_turn', 'text'),
      { type: 'system', subtype: 'turn_duration' },
      { type: 'last-prompt' },
      { type: 'system', subtype: 'away_summary' },
    );
    expect(transcriptTurnFinished(file)).toBe(true);
  });

  it('is finished on an end_turn reply without a marker', () => {
    expect(transcriptTurnFinished(transcript(say('end_turn', 'text')))).toBe(true);
  });

  it('is working while a tool runs or a prompt is pending', () => {
    expect(transcriptTurnFinished(transcript(say(null, 'thinking', 'tool_use')))).toBe(false);
    expect(transcriptTurnFinished(transcript(say('end_turn', 'text'), { type: 'user' }))).toBe(
      false,
    );
  });

  it('is unknown without conversational records', () => {
    expect(transcriptTurnFinished(transcript({ type: 'mode' }))).toBeNull();
    expect(transcriptTurnFinished(path.join(dir, 'missing.jsonl'))).toBeNull();
  });
});
