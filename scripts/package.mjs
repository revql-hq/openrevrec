import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { root, run } from './runtime.mjs';

const cache = join(root, 'build', 'electron-cache');
// electron-builder's downloaded icon tools are CommonJS. Keeping that cache
// outside this ESM package prevents Node from inheriting our package type.
const builderCache = join(tmpdir(), 'openrevrec-electron-builder-cache');
mkdirSync(cache, { recursive: true });
mkdirSync(builderCache, { recursive: true });

await run(
  process.execPath,
  [join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'), ...process.argv.slice(2)],
  {
    env: {
      ...process.env,
      ELECTRON_CACHE: cache,
      ELECTRON_BUILDER_CACHE: builderCache,
      electron_config_cache: cache,
    },
  },
);
