/**
 * Claude Code's live-process registry: ~/.claude/sessions/<pid>.json, one file
 * per running interactive Claude ({pid, sessionId, cwd, ...}).
 *
 * Transcript activity says when a session last DID something; this says which
 * sessions are still RUNNING. The global scanner uses it to adopt a session
 * that is open but idle (its transcript untouched for hours, so the activity
 * filter would skip it), and the tmux console uses it to find the process
 * behind an agent.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function claudeSessionsDir(): string {
  return path.join(os.homedir(), '.claude', 'sessions');
}

/** sessionId -> pid for every registry entry whose process is alive. */
export function liveClaudeSessions(sessionsDir: string = claudeSessionsDir()): Map<string, number> {
  const live = new Map<string, number>();
  let files: string[];
  try {
    files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return live;
  }
  for (const file of files) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf-8')) as {
        pid?: unknown;
        sessionId?: unknown;
      };
      if (typeof entry.pid !== 'number' || typeof entry.sessionId !== 'string') continue;
      // The registry can outlive a crashed process; signal 0 only probes.
      process.kill(entry.pid, 0);
      live.set(entry.sessionId, entry.pid);
    } catch {
      // Unreadable, half-written, or a dead pid: not live.
    }
  }
  return live;
}

/**
 * Pid of the live Claude process running one of these sessions. Several ids
 * because an agent can know its session both by sessionId and by transcript
 * name (they differ after /clear).
 */
export function findClaudePid(
  sessionIds: readonly string[],
  sessionsDir: string = claudeSessionsDir(),
): number | null {
  const live = liveClaudeSessions(sessionsDir);
  for (const id of sessionIds) {
    const pid = live.get(id);
    if (pid !== undefined) return pid;
  }
  return null;
}
