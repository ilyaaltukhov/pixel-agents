/**
 * Tmux console: a terminal for an EXTERNAL agent that lives in a tmux pane.
 *
 * External agents are Claude sessions this server only observes -- started in
 * the operator's own terminal, so there is no PTY to stream and the drawer had
 * nothing to show for them. When that terminal is a tmux pane, the session IS
 * reachable: this module finds the pane and runs a tmux client attached to it
 * inside a server-side PTY, which from then on is an ordinary agent terminal
 * (same drawer tab, same /terminal route and privilege gate, same snapshot
 * replay on reconnect).
 *
 * Finding the pane takes no hooks and no heuristics:
 *   agent sessionId -> ~/.claude/sessions/<pid>.json (Claude Code keeps one per
 *   live interactive process: {pid, sessionId, cwd, ...}) -> that process's
 *   environment (/proc/<pid>/environ) -> TMUX (server socket) + TMUX_PANE.
 * A Claude that is not in tmux, not on Linux, or already gone resolves to null
 * and its agent simply stays watch-only.
 *
 * The client runs in a GROUPED session (`new-session -t <target>`): it shares
 * the target's windows but keeps its own current window, so selecting the
 * agent's window here never switches what the operator's own client shows. It
 * is created with destroy-unattached, so when the PTY dies (tab closed, agent
 * removed, server stopped) tmux drops it and nothing lingers in `tmux ls`.
 * Disposing the PTY only ever kills that client -- never the Claude process.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AgentStateStore } from '../agentStateStore.js';
import { findClaudePid } from '../claudeLiveSessions.js';
import type { AgentState } from '../types.js';
import type { PtySessionManager } from './ptySessionManager.js';

export interface TmuxPane {
  /** Server socket from the process's TMUX variable (`<socket>,<pid>,<idx>`). */
  socketPath: string;
  /** `%N` from TMUX_PANE. */
  paneId: string;
  /** `$N` of the session that owns the pane. */
  sessionId: string;
  windowIndex: string;
}

export interface TmuxConsoleDeps {
  store: AgentStateStore;
  ptyManager: PtySessionManager;
}

/** Agent ids whose PTY is a tmux console (as opposed to a launched agent). */
const consoles = new Set<number>();
/** Attaches in flight: focus clicks arrive in bursts, one spawn is enough. */
const pending = new Set<number>();

/** Whether this agent's terminal is a tmux console, i.e. closing it must not
 *  close the agent. */
export function isTmuxConsole(agentId: number): boolean {
  return consoles.has(agentId);
}

export interface TmuxEnviron {
  socketPath: string;
  paneId: string;
  /** `$N` of the session the pane was created in (TMUX's last field), or null. */
  homeSessionId: string | null;
}

/** TMUX and TMUX_PANE out of a NUL-separated /proc environ dump. */
export function parseTmuxEnviron(environ: string): TmuxEnviron | null {
  let tmux: string | undefined;
  let pane: string | undefined;
  for (const entry of environ.split('\0')) {
    if (entry.startsWith('TMUX=')) tmux = entry.slice('TMUX='.length);
    else if (entry.startsWith('TMUX_PANE=')) pane = entry.slice('TMUX_PANE='.length);
  }
  const [socketPath, , sessionIndex] = tmux?.split(',') ?? [];
  if (!socketPath || !pane || !/^%\d+$/.test(pane)) return null;
  const homeSessionId = sessionIndex && /^\d+$/.test(sessionIndex) ? `$${sessionIndex}` : null;
  return { socketPath, paneId: pane, homeSessionId };
}

/** Argv for a tmux client attached to the pane's window via a grouped session. */
export function tmuxAttachArgs(pane: TmuxPane, sessionName: string): string[] {
  return [
    '-S',
    pane.socketPath,
    'new-session',
    '-t',
    pane.sessionId,
    '-s',
    sessionName,
    ';',
    'set-option',
    'destroy-unattached',
    'on',
    ';',
    'select-window',
    '-t',
    `${sessionName}:${pane.windowIndex}`,
  ];
}

function tmuxQuery(socketPath: string, target: string, format: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'tmux',
      ['-S', socketPath, 'display-message', '-p', '-t', target, format],
      { timeout: 3000 },
      (err, stdout) => resolve(err ? null : stdout.trim()),
    );
  });
}

/** The tmux pane an external agent's Claude runs in, or null. */
export async function locateTmuxPane(agent: AgentState): Promise<TmuxPane | null> {
  const ids = [agent.sessionId, path.basename(agent.jsonlFile, '.jsonl')].filter(Boolean);
  const pid = findClaudePid(ids);
  if (pid === null) return null;
  let environ: string;
  try {
    environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf-8');
  } catch {
    return null;
  }
  const env = parseTmuxEnviron(environ);
  if (!env) return null;
  // A window shared by a session group belongs to every member, and asking the
  // pane for its session may name any of them -- including another console's
  // short-lived group member. Group with the session the pane was born in while
  // it exists; the window index is the same in every member.
  const info = await tmuxQuery(env.socketPath, env.paneId, '#{session_id}\t#{window_index}');
  const [paneSessionId, windowIndex] = info?.split('\t') ?? [];
  if (!paneSessionId || !windowIndex) return null;
  const homeAlive =
    env.homeSessionId !== null &&
    (await tmuxQuery(env.socketPath, env.homeSessionId, '#{session_id}')) === env.homeSessionId;
  return {
    socketPath: env.socketPath,
    paneId: env.paneId,
    sessionId: homeAlive ? env.homeSessionId! : paneSessionId,
    windowIndex,
  };
}

/**
 * Open a tmux console for an external agent, announcing it like a launched
 * agent's terminal so the client opens a tab. Resolves false (and changes
 * nothing) when the agent already has a terminal, is not external, or is not
 * in a reachable tmux pane.
 */
export async function attachTmuxConsole(deps: TmuxConsoleDeps, agentId: number): Promise<boolean> {
  const { store, ptyManager } = deps;
  const agent = store.get(agentId);
  if (!agent?.isExternal || ptyManager.has(agentId) || pending.has(agentId)) return false;
  if (!ptyManager.isAvailable()) return false;

  pending.add(agentId);
  try {
    const pane = await locateTmuxPane(agent);
    // The agent may have been closed, or given a terminal, while we looked.
    if (!pane || !store.has(agentId) || ptyManager.has(agentId)) return false;

    const sessionName = `pixel-agents-${agentId}-${Date.now().toString(36)}`;
    const session = ptyManager.create({
      agentId,
      command: 'tmux',
      args: tmuxAttachArgs(pane, sessionName),
      cwd: os.homedir(),
      // tmux refuses to nest when TMUX is set (a server started from inside
      // tmux); an empty value counts as unset.
      env: { TMUX: '', TMUX_PANE: '' },
    });
    consoles.add(agentId);

    // The console belongs to the agent: when the agent goes (stale cleanup,
    // session end), so does the client.
    const onRemoved = (id: number): void => {
      if (id === agentId) ptyManager.dispose(agentId);
    };
    store.on('agentRemoved', onRemoved);

    // Unlike a launched agent, the console exiting says nothing about the
    // agent: Claude keeps running in tmux, only the tab goes.
    session.onExit((exit) => {
      consoles.delete(agentId);
      store.off('agentRemoved', onRemoved);
      store.broadcast({ type: 'terminalSessionClosed', agentId, exitCode: exit.exitCode });
      console.log(`[Pixel Agents] Terminal: Agent ${agentId} - tmux console closed`);
    });

    console.log(
      `[Pixel Agents] Terminal: Agent ${agentId} - tmux console on ${pane.paneId} (pid ${session.pid})`,
    );
    store.broadcast({ type: 'terminalSessionOpened', agentId });
    return true;
  } catch (err) {
    console.error(`[Pixel Agents] Terminal: Agent ${agentId} - tmux attach failed: ${String(err)}`);
    return false;
  } finally {
    pending.delete(agentId);
  }
}
