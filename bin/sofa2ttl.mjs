#!/usr/bin/env node
/**
 * Command-line front-end. The browser page in web/ uses the same src/ modules.
 *
 * Usage:
 *   node bin/sofa2ttl.mjs <sofa-export.zip> [options]
 *
 * Options:
 *   -o, --out <file>        output archive (default: tv-time-liberator-export.zip)
 *   -t, --tvtime <zip>      an existing TV Time export to mine for ids (repeatable)
 *   -k, --tmdb-key <key>    TMDB v3 API key or v4 read token (or set TMDB_API_KEY)
 *       --no-episode-ids    skip per-episode TVDB lookups
 *       --cache <file>      TMDB response cache (default: .cache/tmdb.json)
 *       --report <file>     write the full JSON report
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { convert } from '../src/convert.mjs';
import { readZip } from '../src/zip.mjs';

function parseArgs(argv) {
    const options = {
        input: null,
        out: 'tv-time-liberator-export.zip',
        tvtime: [],
        tmdbKey: process.env.TMDB_API_KEY ?? '',
        resolveEpisodeIds: true,
        cache: '.cache/tmdb.json',
        report: null,
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '-o': case '--out': options.out = argv[++i]; break;
            case '-t': case '--tvtime': options.tvtime.push(argv[++i]); break;
            case '-k': case '--tmdb-key': options.tmdbKey = argv[++i]; break;
            case '--no-episode-ids': options.resolveEpisodeIds = false; break;
            case '--cache': options.cache = argv[++i]; break;
            case '--report': options.report = argv[++i]; break;
            case '-h': case '--help': options.help = true; break;
            default:
                if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
                options.input = arg;
        }
    }
    return options;
}

async function loadCache(path) {
    if (!path) return new Map();
    try {
        return new Map(Object.entries(JSON.parse(await readFile(path, 'utf8'))));
    } catch {
        return new Map();
    }
}

async function saveCache(path, cache) {
    if (!path || cache.size === 0) return;
    await mkdir(dirname(resolve(path)), { recursive: true });
    await writeFile(path, JSON.stringify(Object.fromEntries(cache)));
}

function renderProgress(update) {
    if (update.message) { process.stderr.write(`\n· ${update.message}`); return; }
    if (update.total && update.done % 25 === 0) {
        process.stderr.write(`\r  ${update.phase}: ${update.done}/${update.total}   `);
    }
}

const HELP = `sofa2liberator - convert a Sofa Time export into a TV Time Liberator archive

  node bin/sofa2ttl.mjs <sofa-export.zip> [options]

  -o, --out <file>       output archive (default: tv-time-liberator-export.zip)
  -t, --tvtime <zip>     existing TV Time export to mine for ids (repeatable)
  -k, --tmdb-key <key>   TMDB v3 key or v4 token (or set TMDB_API_KEY)
      --no-episode-ids   skip per-episode TVDB lookups
      --cache <file>     TMDB response cache (default: .cache/tmdb.json)
      --report <file>    write the full JSON report
`;

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help || !options.input) {
        process.stdout.write(HELP);
        process.exit(options.input ? 0 : 1);
    }

    const tvTimeExports = [];
    for (const path of options.tvtime) {
        tvTimeExports.push({ files: await readZip(await readFile(path)), label: path });
    }

    const cache = await loadCache(options.cache);
    const { zip, report } = await convert({
        sofaZip: await readFile(options.input),
        tvTimeExports,
        tmdbKey: options.tmdbKey,
        resolveEpisodeIds: options.resolveEpisodeIds,
        cache,
        onProgress: renderProgress,
    });
    await saveCache(options.cache, cache);

    await writeFile(options.out, zip);
    if (options.report) await writeFile(options.report, JSON.stringify(report, null, 2));

    const { shows, movies, episodes } = report.coverage;
    const pct = ({ resolved, total }) => (total ? `${(100 * resolved / total).toFixed(1)}%` : 'n/a');

    process.stderr.write('\n\n');
    process.stdout.write(
        `${options.out}  (${(report.zipBytes / 1024).toFixed(0)} KB)\n\n`
        + `  shows     ${shows.resolved}/${shows.total}  (${pct(shows)})\n`
        + `  movies    ${movies.resolved}/${movies.total}  (${pct(movies)})\n`
        + `  episodes  ${episodes.resolved}/${episodes.total}  (${pct(episodes)})\n`
        + `  markers   ${report.markers.ok ? 'ok' : `MISSING ${report.markers.missing.join(', ')}`}\n`,
    );
    for (const warning of report.warnings) process.stdout.write(`\n  ! ${warning}\n`);
}

main().catch(error => {
    process.stderr.write(`\n${error.stack ?? error.message}\n`);
    process.exit(1);
});
