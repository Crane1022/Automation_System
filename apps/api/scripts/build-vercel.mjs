// Builds the API for Vercel ("npm run build:vercel -w apps/api").
//
// Vercel's Express preset deploys the contents of dist/ on their own (without apps/api/package.json)
// and picks dist/app.js, dist/index.js or dist/server.js as the entry. So:
//   1. the whole app (src/vercel.ts) is bundled into ONE CommonJS file, dist/index.cjs, which
//      runs no matter which package.json Node finds;
//   2. dist/package.json marks the other compiled files as ES modules, in case anything loads them.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const externals = ['bullmq', 'cors', 'cron-parser', 'express', 'firebase-admin', 'ioredis', 'zod'];
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });

run('npx tsc -p tsconfig.json');
run(
  [
    'npx esbuild dist/vercel.js --bundle --platform=node --target=node22 --format=cjs',
    '--outfile=dist/index.cjs --log-level=warning',
    ...externals.map((e) => `--external:${e}`),
    // Export the Express app itself (module.exports = app), as Vercel expects from a CommonJS entry.
    `--footer:js="module.exports = Object.assign(module.exports.default, { default: module.exports.default });"`,
  ].join(' '),
);
writeFileSync('dist/package.json', JSON.stringify({ type: 'module', private: true }) + '\n');
console.log('[build-vercel] wrote dist/index.cjs and dist/package.json');
