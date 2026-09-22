import { requirePython, run } from './runtime.mjs';

try { await run(requirePython(), process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
