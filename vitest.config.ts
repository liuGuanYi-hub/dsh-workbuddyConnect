import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

/** Mirror the build-time define from tsdown.config.ts so tests see the same version. */
const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version as string

export default defineConfig({
  define: {
    __DSH_WORKBUDDY_VERSION__: JSON.stringify(PACKAGE_VERSION),
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    /**
     * Four parallel workers, not the default one-per-core-minus-one.
     *
     * Measured on a 16-logical-core Windows machine running the full 63-file
     * suite, counting runs where a worker process died:
     *
     * | setting               | runs | worker deaths | wall    |
     * | --------------------- | ---- | ------------- | ------- |
     * | forks, default (15)   | 8    | 3             | ~11.0s  |
     * | forks, maxWorkers 8   | 11   | 1             | ~9.4s   |
     * | threads, default      | 8    | 0             | ~6.7s   |
     * | forks, maxWorkers 4   | 10   | 0             | ~14.5s  |
     *
     * The failure mode is what makes this worth a slower run: a dead worker does
     * not report a failed assertion, it reports `Test Files 62 passed (63)` plus
     * an unhandled `Worker exited unexpectedly`, so a run that dropped a whole
     * file still looks green to anything scanning for "failed".
     *
     * `threads` is faster and crash-free, but it breaks
     * `windows-powershell-registry-integration.spec.ts` — the suite that spawns
     * real `reg.exe` / `powershell.exe` — in 7 of 8 runs, so trading one flake
     * for a worse one is not a fix. The pool therefore stays `forks` and only
     * the concurrency is capped. This is a mitigation, not a root cause: what
     * kills a fork under contention was not pinned down, and if it resurfaces
     * below four workers the cause is inside a test file, not in the pool size.
     *
     * The cap only binds above five cores, so CI on small runners is unaffected.
     */
    maxWorkers: 4,
  },
})
