import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({ resolve: { alias: [ { find: /^@etvideoscript\/core\/(.*)$/, replacement: resolve(__dirname, 'packages/core/src/$1') }, { find: '@etvideoscript/core', replacement: resolve(__dirname, 'packages/core/src/index.ts') } ] }, test: { include: ['packages/**/*.test.ts', 'apps/**/*.{test,spec}.{ts,tsx}'], globals: true, testTimeout: 30000 } });
