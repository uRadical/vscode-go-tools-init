import { defineConfig } from '@vscode/test-cli';

// Integration tests run inside a real VS Code extension host (downloads VS Code
// on first run; needs a display, or xvfb in CI). Fast, host-free unit tests live
// in out/test/*.test.js and run via `npm run test:unit`.
export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  version: 'stable',
  mocha: { ui: 'tdd', timeout: 20000 },
});
