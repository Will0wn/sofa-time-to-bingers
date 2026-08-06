/**
 * Convenience runner: converts the sample export and validates the result.
 *   node test/run.mjs <sofa.zip> <reference-liberator.zip> [tv time exports...]
 */
import { spawnSync } from 'node:child_process';

const [sofa, reference, ...extra] = process.argv.slice(2);
if (!sofa || !reference) {
    process.stderr.write('usage: node test/run.mjs <sofa.zip> <reference-liberator.zip> [tvtime.zip...]\n');
    process.exit(1);
}

const out = '.tmp/test-out.zip';
const args = ['bin/sofa2ttl.mjs', sofa, '-o', out, '--cache', '.cache/tmdb.json'];
for (const path of extra) args.push('-t', path);

const convert = spawnSync(process.execPath, args, { stdio: 'inherit' });
if (convert.status !== 0) process.exit(convert.status ?? 1);

const validate = spawnSync(process.execPath, ['test/validate.mjs', out, reference], { stdio: 'inherit' });
process.exit(validate.status ?? 1);
