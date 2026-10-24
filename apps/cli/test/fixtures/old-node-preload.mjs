// Preload for node-check-bundle.test.ts (M1-9zc): makes the process report an old Node.js, so the
// built bundle takes its "too old" branch. Loaded with `--import`.
import process from 'node:process';

Object.defineProperty(process.versions, 'node', { value: '20.0.0' });
