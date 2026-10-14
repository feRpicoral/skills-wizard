import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { tempDir } from '../test-support/fixtures.ts';
import { trackChildGroup, trackedChildCount } from './children.ts';

const POSIX = process.platform !== 'win32';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

async function readPid(path: string): Promise<number | null> {
  try {
    const pid = Number.parseInt((await readFile(path, 'utf8')).trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

test('trackChildGroup handles interrupt signals only while a child is tracked', () => {
  const before = process.listenerCount('SIGINT');
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });

  const untrack = trackChildGroup(child);
  const whileTracked = process.listenerCount('SIGINT');
  const hupWhileTracked = process.listenerCount('SIGHUP');
  untrack();
  untrack();

  assert.equal(whileTracked, before + 1);
  assert.ok(hupWhileTracked >= 1);
  assert.equal(process.listenerCount('SIGINT'), before);
  assert.equal(trackedChildCount(), 0);
});

test(
  'interrupting the eval process stops agent CLIs and command assertions it started',
  { skip: !POSIX },
  async (t) => {
    const dir = await tempDir(t);
    const stub = join(dir, 'stub-agent');
    await writeFile(
      stub,
      '#!/bin/sh\nsleep 30 &\necho $! > "$OUT/agent.pid"\nwait\n',
    );
    await chmod(stub, 0o755);
    const typesUrl = pathToFileURL(
      join(import.meta.dirname, 'runners', 'types.ts'),
    ).href;
    const gradeUrl = pathToFileURL(join(import.meta.dirname, 'grade.ts')).href;
    const script = join(dir, 'parent.mjs');
    await writeFile(
      script,
      [
        `import { spawnRunnerProcess } from ${JSON.stringify(typesUrl)};`,
        `import { runShellCommand } from ${JSON.stringify(gradeUrl)};`,
        'const [dir, stub] = process.argv.slice(2);',
        "const env = { PATH: '/usr/bin:/bin', OUT: dir };",
        "void spawnRunnerProcess({ binary: stub, args: [], cwd: dir, runDir: dir + '/run', timeoutSeconds: 60, env });",
        "void runShellCommand({ command: 'sleep 30 & echo $! > shell.pid; wait', cwd: dir, env, timeoutMs: 60000 });",
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );
    const parent = spawn(process.execPath, [script, dir, stub], {
      stdio: 'ignore',
    });
    const pids: number[] = [];
    t.after(() => {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      parent.kill('SIGKILL');
    });
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      parent.on('exit', (code, signal) => resolve({ code, signal }));
    });

    const started = await waitFor(async () => {
      const agentPid = await readPid(join(dir, 'agent.pid'));
      const shellPid = await readPid(join(dir, 'shell.pid'));
      if (agentPid === null || shellPid === null) return false;
      pids.splice(0, pids.length, agentPid, shellPid);
      return true;
    }, 10_000);
    assert.ok(started, 'the stub agent and command assertion started');
    assert.ok(pids.every(isAlive));

    parent.kill('SIGINT');
    const { code, signal } = await exited;
    const stopped = await waitFor(() => !pids.some(isAlive), 5_000);

    assert.ok(signal === 'SIGINT' || code === 130, `exit ${code} ${signal}`);
    assert.ok(stopped, 'grandchildren were stopped');
  },
);
