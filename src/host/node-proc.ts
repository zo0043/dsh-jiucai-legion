/**
 * Node child_process 版 SubprocessPort —— 独立运行器（CLI）用；
 * DSH 宿主内走 dsh-adapter 的 ctx.subprocess 适配（#6）。
 */
import { spawn as nodeSpawn } from 'node:child_process';
import type { SpawnOpts, SubprocessHandle, SubprocessPort } from './ports.js';

export class NodeSubprocessPort implements SubprocessPort {
  spawn(cmd: string, args: string[], opts?: SpawnOpts): SubprocessHandle {
    const child = nodeSpawn(cmd, args, {
      cwd: opts?.cwd ?? process.cwd(),
      env: { ...process.env, ...(opts?.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks: ((v: IteratorResult<string>) => void)[] = [];
    const stdoutBuffer: string[] = [];
    let stdoutClosed = false;
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      stdoutBuffer.push(chunk);
      flush();
    });
    child.stdout!.on('close', () => {
      stdoutClosed = true;
      flush();
    });
    function flush(): void {
      while (stdoutChunks.length > 0 && (stdoutBuffer.length > 0 || stdoutClosed)) {
        const w = stdoutChunks.shift()!;
        if (stdoutBuffer.length > 0) {
          w({ value: stdoutBuffer.shift()!, done: false });
        } else {
          w({ value: undefined, done: true });
        }
      }
    }

    const stderrText: string[] = [];
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (c: string) => stderrText.push(c));

    return {
      stdin: {
        write(line: string): void { child.stdin!.write(line); },
        end(): void { child.stdin!.end(); },
      },
      stdout: {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<string>> {
              if (stdoutBuffer.length > 0) return Promise.resolve({ value: stdoutBuffer.shift()!, done: false });
              if (stdoutClosed) return Promise.resolve({ value: undefined, done: true });
              return new Promise((resolve) => stdoutChunks.push(resolve));
            },
          };
        },
      },
      stderr: {
        [Symbol.asyncIterator]() {
          return (async function* () {
            for (const line of stderrText) yield line;
          })();
        },
      },
      get exitCode(): number | null { return child.exitCode; },
      kill(): void { child.kill('SIGTERM'); },
    };
  }
}
