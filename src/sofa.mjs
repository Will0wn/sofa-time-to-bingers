/**
 * Parser for Sofa Time exports.
 *
 * The archive holds six arrays, one per bucket:
 *   watched{Movie,Show}  watchlist{Movie,Show}  stopWatching{Movie,Show}
 * Every record carries `tmdb` and `imdb`; episodes carry only a number, an
 * `addedDate`, and an optional `rating`. There are no TVDB identifiers, which
 * is the entire reason the resolver layer exists.
 */
import { readZip, textOf } from './zip.mjs';

const BUCKETS = [
    { prefix: 'watchedMovie', kind: 'movie', origin: 'watched' },
    { prefix: 'watchlistMovie', kind: 'movie', origin: 'watchlist' },
    { prefix: 'stopWatchingMovie', kind: 'movie', origin: 'stopped' },
    { prefix: 'watchedShow', kind: 'show', origin: 'watched' },
    { prefix: 'watchlistShow', kind: 'show', origin: 'watchlist' },
    { prefix: 'stopWatchingShow', kind: 'show', origin: 'stopped' },
];

/**
 * A title can sit in more than one bucket. "Stopped" is an explicit user action
 * so it outranks "watched", and anything outranks "watchlist": a show you have
 * episodes for is not merely planned.
 */
const ORIGIN_PRIORITY = { stopped: 0, watched: 1, watchlist: 2 };

/** Normalises a timestamp to the `...Z` form the Liberator format uses. */
export function toIsoZ(value) {
    if (!value) return undefined;
    if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value)) return value;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normaliseSeasons(raw) {
    return (raw ?? [])
        .map(season => ({
            number: Number(season.number ?? 0),
            episodes: (season.episodes ?? [])
                .map(episode => ({
                    number: Number(episode.number),
                    addedDate: toIsoZ(episode.addedDate),
                    rating: episode.rating ?? null,
                }))
                .filter(episode => Number.isFinite(episode.number))
                .sort((a, b) => a.number - b.number),
        }))
        .filter(season => Number.isFinite(season.number))
        .sort((a, b) => a.number - b.number);
}

function normaliseRecord(raw, kind, origin) {
    const record = {
        tmdb: raw.tmdb == null ? null : Number(raw.tmdb),
        imdb: raw.imdb && raw.imdb !== '' ? raw.imdb : null,
        title: raw.title ?? 'Unknown',
        addedDate: toIsoZ(raw.addedDate),
        releaseDate: toIsoZ(raw.release_date),
        runtime: raw.runtime ?? null,
        genres: (raw.genres ?? []).filter(Boolean),
        origin,
    };
    if (kind === 'show') record.seasons = normaliseSeasons(raw.seasons);
    return record;
}

/**
 * Folds two records for the same title into one: the strongest origin wins, and
 * episode lists are unioned so a bucket that happens to carry extra watches
 * (Sofa Time files a few watched episodes under the watchlist) never loses them.
 */
function mergeRecords(a, b) {
    const [strong, weak] = ORIGIN_PRIORITY[a.origin] <= ORIGIN_PRIORITY[b.origin] ? [a, b] : [b, a];
    const merged = { ...weak, ...strong };
    merged.origin = strong.origin;
    merged.addedDate = [a.addedDate, b.addedDate].filter(Boolean).sort()[0];

    if (!a.seasons && !b.seasons) return merged;

    const seasons = new Map();
    for (const season of [...(strong.seasons ?? []), ...(weak.seasons ?? [])]) {
        if (!seasons.has(season.number)) seasons.set(season.number, new Map());
        const episodes = seasons.get(season.number);
        for (const episode of season.episodes) {
            const previous = episodes.get(episode.number);
            if (!previous) { episodes.set(episode.number, episode); continue; }
            // Keep the earliest watch date and any rating either copy carries.
            episodes.set(episode.number, {
                ...previous,
                addedDate: [previous.addedDate, episode.addedDate].filter(Boolean).sort()[0],
                rating: previous.rating ?? episode.rating ?? null,
            });
        }
    }

    merged.seasons = [...seasons.entries()]
        .map(([number, episodes]) => ({
            number,
            episodes: [...episodes.values()].sort((x, y) => x.number - y.number),
        }))
        .sort((x, y) => x.number - y.number);
    return merged;
}

/**
 * @param {ArrayBuffer|Uint8Array|Map<string, Uint8Array>} input
 *        a Sofa Time .zip, or an already-read map of filename -> bytes
 */
export async function parseSofaExport(input) {
    const files = input instanceof Map ? input : await readZip(input);
    const movies = new Map();
    const shows = new Map();

    for (const { prefix, kind, origin } of BUCKETS) {
        const name = [...files.keys()].find(file => {
            const base = file.split('/').pop();
            return base.startsWith(`${prefix}_`) || base === `${prefix}.json`;
        });
        if (!name) continue;

        let records;
        try {
            records = JSON.parse(textOf(files.get(name)));
        } catch (error) {
            throw new Error(`Could not parse "${name}": ${error.message}`);
        }
        if (!Array.isArray(records)) continue;

        const target = kind === 'movie' ? movies : shows;
        for (const raw of records) {
            const record = normaliseRecord(raw, kind, origin);
            // Key on TMDB, falling back to IMDB then title for the rare record
            // that carries neither (two watchlist shows in the reference data).
            const key = record.tmdb != null ? `tmdb:${record.tmdb}`
                : record.imdb ? `imdb:${record.imdb}`
                    : `title:${record.title.toLowerCase()}`;

            const existing = target.get(key);
            if (!existing) { target.set(key, record); continue; }
            target.set(key, mergeRecords(existing, record));
        }
    }

    return { movies: [...movies.values()], shows: [...shows.values()] };
}

export function countEpisodes(shows) {
    return shows.reduce(
        (total, show) => total + (show.seasons ?? []).reduce((sum, s) => sum + s.episodes.length, 0),
        0,
    );
}
