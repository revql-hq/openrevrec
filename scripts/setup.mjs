import { run } from './runtime.mjs';

try {
  await run('uv', ['sync', '--extra', 'dev', '--python', '3.12']);
  console.log('Python is ready. Run npm run desktop or npm run dev.');
} catch (error) {
  console.error(error.message);
  console.error('Install uv from https://docs.astral.sh/uv/getting-started/installation/ and retry.');
  process.exitCode = 1;
}
