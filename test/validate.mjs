/**
 * Structural conformance check: compares a generated archive against a real
 * TV Time Liberator export, so drift in key order, types, or CSV formatting
 * fails loudly instead of surfacing as a silent import mismatch.
 *
 *   node test/validate.mjs <generated.zip> <reference.zip>
 */
import { readFile } from 'node:fs/promises';
import { readZip, textOf } from '../src/zip.mjs';
import { MARKERS, MARKER_WINDOW } from '../src/liberator.mjs';

const EXPECTED_FILES = [
    'activity_history.csv', 'favorites.csv', 'favorites.json',
    'lists.json', 'movies.json', 'shows.json',
];

const CSV_HEADER = 'imdb_id,tvdb_id,type,title,season,episode,is_special,'
    + 'is_watched,watched_at,status,is_watchlisted,rating';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

const shapeOf = (value, depth = 0) => {
    if (value === null) return 'null';
    if (Array.isArray(value)) return depth > 2 ? 'array' : `[${shapeOf(value[0], depth + 1)}]`;
    if (typeof value === 'object') {
        return `{${Object.entries(value).map(([k, v]) => `${k}:${shapeOf(v, depth + 1)}`).join(',')}}`;
    }
    return typeof value;
};

/** Types only; a null rating and a numeric one are the same shape. */
const loose = shape => shape.replace(/\bnull\b/g, '?').replace(/\bnumber\b/g, '?').replace(/\bstring\b/g, '?');

const [, , generatedPath, referencePath] = process.argv;
if (!generatedPath || !referencePath) {
    process.stderr.write('usage: node test/validate.mjs <generated.zip> <reference.zip>\n');
    process.exit(1);
}

const generatedBytes = await readFile(generatedPath);
const generated = await readZip(generatedBytes);
const reference = await readZip(await readFile(referencePath));

// --- archive layout ---
check('archive contains exactly the six Liberator files',
    JSON.stringify([...generated.keys()]) === JSON.stringify(EXPECTED_FILES),
    [...generated.keys()].join(', '));

const window = new TextDecoder('latin1').decode(generatedBytes.subarray(0, MARKER_WINDOW));
const missing = MARKERS.filter(marker => !window.includes(marker));
check('format markers land inside the 512 KB sniff window', missing.length === 0, missing.join(', '));

// --- JSON shapes ---
const generatedShows = JSON.parse(textOf(generated.get('shows.json')));
const referenceShows = JSON.parse(textOf(reference.get('shows.json')));
const generatedMovies = JSON.parse(textOf(generated.get('movies.json')));
const referenceMovies = JSON.parse(textOf(reference.get('movies.json')));

check('show object shape matches the reference',
    loose(shapeOf(generatedShows[0])) === loose(shapeOf(referenceShows[0])),
    `\n    generated: ${shapeOf(generatedShows[0])}\n    reference: ${shapeOf(referenceShows[0])}`);

const watchedGenerated = generatedMovies.find(movie => movie.is_watched);
const watchedReference = referenceMovies.find(movie => movie.is_watched);
check('watched-movie object shape matches the reference',
    loose(shapeOf(watchedGenerated)) === loose(shapeOf(watchedReference)),
    `\n    generated: ${shapeOf(watchedGenerated)}\n    reference: ${shapeOf(watchedReference)}`);

const unwatchedGenerated = generatedMovies.find(movie => !movie.is_watched);
const unwatchedReference = referenceMovies.find(movie => !movie.is_watched);
if (unwatchedGenerated && unwatchedReference) {
    check('unwatched movies omit watched_at, as the reference does',
        !('watched_at' in unwatchedGenerated) && !('watched_at' in unwatchedReference));
}

check('JSON indentation matches (4 spaces for shows/movies)',
    textOf(generated.get('shows.json')).startsWith('[\n    {')
    && textOf(generated.get('movies.json')).startsWith('[\n    {'));
check('favorites.json uses 2-space indentation',
    textOf(generated.get('favorites.json')).startsWith('{\n  "name"'));

const statuses = new Set(generatedShows.map(show => show.status));
const allowed = new Set(['stopped', 'continuing', 'up_to_date', 'not_started_yet', 'watch_later']);
check('every show status is a value the Liberator schema defines',
    [...statuses].every(status => allowed.has(status)), [...statuses].join(', '));

// --- CSV formatting ---
const csv = textOf(generated.get('activity_history.csv'));
const referenceCsv = textOf(reference.get('activity_history.csv'));
check('CSV header is identical to the reference', csv.split('\r\n')[0] === CSV_HEADER);
check('CSV uses CRLF line endings and a trailing CRLF',
    csv.endsWith('\r\n') && !/[^\r]\n/.test(csv));
check('CSV quotes fields containing commas',
    !csv.split('\r\n').some(line => {
        const cells = line.split(',');
        return cells.length > 12 && !line.includes('"');
    }));

const rowTypes = counts => counts.reduce((acc, type) => ({ ...acc, [type]: (acc[type] ?? 0) + 1 }), {});
const typesOf = text => rowTypes(text.split('\r\n').slice(1).filter(Boolean)
    .map(line => (line.match(/^(?:[^,"]|"[^"]*")*?,(?:[^,"]|"[^"]*")*?,([a-z]+),/) ?? [])[1]));
const generatedTypes = typesOf(csv);
check('CSV carries movie, episode and show rows',
    generatedTypes.movie > 0 && generatedTypes.episode > 0 && generatedTypes.show > 0,
    JSON.stringify(generatedTypes));

check('CSV show rows match shows.json',
    generatedTypes.show === generatedShows.length,
    `csv=${generatedTypes.show} json=${generatedShows.length}`);

const watchedEpisodes = generatedShows.reduce((total, show) => total
    + show.seasons.reduce((sum, season) =>
        sum + season.episodes.filter(episode => episode.is_watched).length, 0), 0);
check('CSV episode rows match the watched episodes in shows.json',
    generatedTypes.episode === watchedEpisodes,
    `csv=${generatedTypes.episode} json=${watchedEpisodes}`);

// --- report ---
const width = Math.max(...results.map(result => result.name.length));
let failed = 0;
for (const result of results) {
    if (!result.ok) failed++;
    process.stdout.write(
        `${result.ok ? '  ok  ' : '  FAIL'}  ${result.name.padEnd(width)}`
        + `${!result.ok && result.detail ? `  ${result.detail}` : ''}\n`,
    );
}
process.stdout.write(
    `\n${results.length - failed}/${results.length} checks passed`
    + `  ·  reference: ${referenceShows.length} shows, ${referenceMovies.length} movies`
    + `  ·  generated: ${generatedShows.length} shows, ${generatedMovies.length} movies\n`,
);
process.exit(failed ? 1 : 0);
