import { register } from 'node:module';

// Installs the resolution hook for the test process and every test file the
// runner spawns.
register('./resolveExtensions.mjs', import.meta.url);
