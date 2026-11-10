import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL as NodeURL } from 'node:url';
const requestedWorkers = Number(process.env.VITEST_MAX_WORKERS ?? '1');
const maxWorkers = Number.isInteger(requestedWorkers)
  ? Math.min(4, Math.max(1, requestedWorkers))
  : 1;
export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': fileURLToPath(
        new NodeURL('./tests/fixtures/cloudflare-workers.ts', import.meta.url),
      ),
      'cloudflare:sockets': fileURLToPath(
        new NodeURL('./tests/fixtures/cloudflare-sockets.ts', import.meta.url),
      ),
    },
  },
  // Each runtime suite starts workerd/D1. Bound the number of these processes
  // instead of making timing-sensitive tests compete with every CPU core.
  // Each suite starts a workerd/D1 runtime that consumes local ports; keep the
  // default bounded to avoid host port exhaustion. VITEST_MAX_WORKERS can opt
  // into 2–4 workers on machines with enough port capacity.
  test: { include: ['tests/**/*.test.ts'], maxWorkers },
});
