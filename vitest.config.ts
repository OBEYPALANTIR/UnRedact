import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/lib/forensicSummary.test.ts', 'src/lib/fileToBase64.test.ts', 'src/lib/redactionOverlap.test.ts'],
    setupFiles: ['./test/setup.mjs'],
  },
});
