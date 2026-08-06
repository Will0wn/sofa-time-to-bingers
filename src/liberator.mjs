/**
 * Emits a TV Time Liberator archive.
 *
 * The layout mirrors the Liberator CLI byte for byte: six files, 4-space JSON
 * for movies/shows, 2-space for favorites/lists, and a CRLF CSV produced the
 * same way @std/csv's `stringify` produces it.
 *
 * Bingers detects the format by scanning the first 512 KB of the archive for
 * "activity_history.csv" plus the required "shows.json" and "movies.json", so
 * entry order is chosen to keep all three well inside that window.
 */
import { stringifyCsv } from './csv.mjs';

const CSV_HEADER = [
    'imdb_id', 'tvdb_id', 'type', 'title', 'season', 'episode',
    'is_special', 'is_watched', 'watched_at', 'status', 'is_watchlisted', 'rating',
];

export const MARKER_WINDOW = 512 * 1024;
export const MARKERS = ['activity_history.csv', 'shows.json', 'movies.json'];

/**
 * Deterministic UUID derived from a stable key, so re-running the converter
 * produces byte-identical output. Not cryptographic; it only needs to avoid
 * collisions across a few thousand items.
 */
function stableUuid(key) {
    const words = [];
    for (const seed of [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b]) {
        let hash = seed >>> 0;
        for (let i = 0; i < key.length; i++) {
            hash ^= key.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193) >>> 0;
            hash = (hash ^ (hash >>> 13)) >>> 0;
        }
        words.push(hash.toString(16).padStart(8, '0'));
    }
    const hex = words.join('');
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        `4${hex.slice(13, 16)}`,                                        // version 4
        ((parseInt(hex[16], 16) & 0x3 | 0x8).toString(16)) + hex.slice(17, 20), // variant
        hex.slice(20, 32),
    ].join('-');
}

const IMDB_NONE = '-1';
const TVDB_NONE = -1;

function showStatus(show) {
    if (show.origin === 'stopped') return 'stopped';
    if (show.origin === 'watchlist') return 'not_started_yet';
    if (Number.isFinite(show.totalEpisodes)) {
        return show.watchedCount >= show.totalEpisodes ? 'up_to_date' : 'continuing';
    }
    return 'up_to_date';
}

/**
 * @param {{movies: Array, shows: Array}} library resolved Sofa records
 * @returns {{movies: Array, shows: Array, list: object}} Liberator-shaped data
 */
export function toLiberatorModel({ movies, shows }) {
    const outMovies = movies.map(movie => {
        const watched = movie.origin !== 'watchlist';
        const entry = {
            id: {
                tvdb: Number.isFinite(movie.tvdb) ? movie.tvdb : TVDB_NONE,
                imdb: movie.imdb ?? IMDB_NONE,
            },
            created_at: movie.addedDate,
            uuid: movie.uuid ?? stableUuid(`movie:${movie.tmdb ?? movie.imdb ?? movie.title}`),
            title: movie.title,
        };
        // The reference export omits watched_at entirely on unwatched movies.
        if (watched && movie.addedDate) entry.watched_at = movie.addedDate;
        entry.is_watched = watched;
        entry.rating = movie.rating ?? null;
        return entry;
    });

    const outShows = shows.map(show => {
        const watchedCount = (show.seasons ?? [])
            .reduce((sum, season) => sum + season.episodes.length, 0);
        const withCount = { ...show, watchedCount };

        return {
            uuid: show.uuid ?? stableUuid(`show:${show.tmdb ?? show.imdb ?? show.title}`),
            id: {
                tvdb: Number.isFinite(show.tvdb) ? show.tvdb : TVDB_NONE,
                imdb: show.imdb ?? IMDB_NONE,
            },
            seasons: (show.seasons ?? []).map(season => ({
                number: season.number,
                episodes: season.episodes.map(episode => ({
                    id: {
                        tvdb: Number.isFinite(episode.tvdb) ? episode.tvdb : TVDB_NONE,
                        imdb: IMDB_NONE,
                    },
                    number: episode.number,
                    special: season.number === 0,
                    // Sofa Time only ever exports episodes the user watched.
                    is_watched: show.origin !== 'watchlist',
                    watched_at: episode.addedDate ?? show.addedDate ?? null,
                    rating: episode.rating ?? null,
                })),
            })),
            created_at: show.addedDate,
            title: show.title,
            status: showStatus(withCount),
            // Not part of the Liberator schema; consumed by toCsv below and
            // stripped before serialisation.
            _isWatchlisted: show.origin === 'watchlist'
                || (Number.isFinite(show.totalEpisodes) && watchedCount < show.totalEpisodes),
        };
    });

    return {
        movies: outMovies,
        shows: outShows,
        list: {
            name: 'Favorites',
            description: 'Your favorite movies and shows.',
            is_public: true,
            movies: [],
            shows: [],
        },
    };
}

/** Reproduces TV Time Liberator's `toCsv`: movie rows, then episodes, then shows. */
export function toCsv({ movies = [], shows = [] }) {
    const movieRows = movies.map(movie => [
        movie.id?.imdb, movie.id?.tvdb, 'movie', movie.title, '', '',
        false, movie.is_watched, movie.watched_at ?? '', '',
        movie.watched_at == null, movie.rating ?? '',
    ]);

    const episodeRows = shows.flatMap(show =>
        (show.seasons ?? []).flatMap(season =>
            season.episodes
                .filter(episode => episode.is_watched)
                .map(episode => [
                    episode.id?.imdb, episode.id?.tvdb, 'episode', show.title,
                    season.number, episode.number, episode.special, episode.is_watched,
                    episode.watched_at ?? '', show.status,
                    episode.watched_at == null, episode.rating ?? '',
                ]),
        ),
    );

    const showRows = shows.map(show => [
        show.id?.imdb, show.id?.tvdb, 'show', show.title, '', '', '', '', '',
        show.status, show._isWatchlisted ?? false, '',
    ]);

    return stringifyCsv([CSV_HEADER, ...movieRows, ...episodeRows, ...showRows]);
}

/** Builds the six files of the archive, in the order they should be zipped. */
export function buildLiberatorFiles(library) {
    const model = toLiberatorModel(library);
    const activity = toCsv(model);
    const strip = ({ _isWatchlisted, ...show }) => show;
    const shows = model.shows.map(strip);

    // Alphabetical, matching the reference export, and with the two large files
    // last so every marker filename lands inside Bingers' 512 KB sniff window.
    return [
        { name: 'activity_history.csv', data: activity },
        { name: 'favorites.csv', data: toCsv({ movies: [], shows: [] }) },
        { name: 'favorites.json', data: JSON.stringify(model.list, null, 2) },
        { name: 'lists.json', data: '[]' },
        { name: 'movies.json', data: JSON.stringify(model.movies, null, 4) },
        { name: 'shows.json', data: JSON.stringify(shows, null, 4) },
    ];
}

/**
 * Verifies the produced archive is what Bingers will classify as
 * "tvtime-liberator": all markers must appear within the first 512 KB.
 */
export function verifyMarkers(zipBytes) {
    const window = zipBytes.subarray(0, MARKER_WINDOW);
    const text = new TextDecoder('latin1').decode(window);
    const missing = MARKERS.filter(marker => !text.includes(marker));
    return { ok: missing.length === 0, missing };
}
