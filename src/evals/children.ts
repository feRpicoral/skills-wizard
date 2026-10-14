import type { ChildProcess } from 'node:child_process';

// Agent CLIs and command assertions run detached, in process groups of their
// own, so a timeout can stop everything they started. Detached groups no
// longer receive the terminal's Ctrl+C, so while any of them is alive this
// module stops them when this process is interrupted, then lets the signal
// end this process as usual.

const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
];
const SIGNAL_EXIT_CODES: Readonly<Record<string, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};
const USE_PROCESS_GROUPS = process.platform !== 'win32';
const KILL_GRACE_MS = 2_000;
const POLL_MS = 50;

const live = new Set<ChildProcess>();
let stopping = false;

export function signalProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (USE_PROCESS_GROUPS) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // The group is gone; fall back to the direct child.
    }
  }

  try {
    child.kill(signal);
  } catch {
    // Already exited.
  }
}

const signalChild = signalProcessTree;

function groupAlive(child: ChildProcess): boolean {
  const pid = child.pid;
  if (pid === undefined) return false;

  try {
    process.kill(USE_PROCESS_GROUPS ? -pid : pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeHandlers(): void {
  for (const signal of FORWARDED_SIGNALS) process.off(signal, onSignal);
}

function installHandlers(): void {
  for (const signal of FORWARDED_SIGNALS) {
    if (!process.listeners(signal).includes(onSignal)) {
      process.on(signal, onSignal);
    }
  }
}

function terminate(signal: NodeJS.Signals): void {
  removeHandlers();

  if (process.listenerCount(signal) === 0) {
    process.kill(process.pid, signal);
  }

  // Exit with the conventional status if the signal did not end the process.
  setTimeout(() => {
    process.exit(SIGNAL_EXIT_CODES[signal] ?? 130);
  }, POLL_MS).unref();
}

function onSignal(signal: NodeJS.Signals): void {
  const children = [...live];

  if (stopping) {
    // A second interrupt: stop waiting.
    for (const child of children) signalChild(child, 'SIGKILL');
    terminate(signal);
    return;
  }

  stopping = true;
  for (const child of children) signalChild(child, 'SIGTERM');
  const deadline = Date.now() + KILL_GRACE_MS;

  const poll = (): void => {
    const remaining = [...live].filter(groupAlive);
    if (remaining.length > 0 && Date.now() < deadline) {
      setTimeout(poll, POLL_MS);
      return;
    }

    for (const child of live) signalChild(child, 'SIGKILL');
    terminate(signal);
  };

  poll();
}

/**
 * Tracks a detached child (and its process group) until the returned function
 * is called. While any child is tracked, SIGINT, SIGTERM and SIGHUP stop every
 * tracked group (SIGTERM, then SIGKILL after a grace period) before the signal
 * ends this process. A child tracked while that is happening is stopped at
 * once.
 */
export function trackChildGroup(child: ChildProcess): () => void {
  if (stopping) {
    signalChild(child, 'SIGKILL');
  }

  live.add(child);
  installHandlers();

  let tracked = true;

  return () => {
    if (!tracked) return;

    tracked = false;
    live.delete(child);
    if (live.size === 0 && !stopping) removeHandlers();
  };
}

/** Number of tracked children, for tests. */
export function trackedChildCount(): number {
  return live.size;
}
