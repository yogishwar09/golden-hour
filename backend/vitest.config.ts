import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Spinning up an in-memory MongoDB and a live Socket.IO server takes a
    // moment on a cold run, and the suites share one database per file.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    globals: false,
    env: {
      // Tests must not depend on a public routing server being reachable or
      // fast; the straight-line estimator exercises the same code paths.
      ROUTING_ENABLED: 'false',
      // The lowest the configuration allows, so the offer-cascade test does not
      // sit idle for the production 25 seconds.
      DISPATCH_OFFER_TIMEOUT_SECONDS: '5',
    },
  },
});
