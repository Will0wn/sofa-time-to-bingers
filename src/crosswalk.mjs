/**
 * Builds a TMDB-free identifier crosswalk out of any TV Time export the user
 * already has (Liberator, Refract, or the GDPR dump).
 *
 * None of those formats carry TMDB ids, so the only joins available are:
 *   movies    -> IMDB id      (exact, reliable)
 *   shows     -> title        (fuzzy; fails on localised titles)
 *   episodes  -> tvdb + S/E   (exact, once the show is resolved)
 *
 * This is a best-effort accelerator that costs nothing and cuts the number of
 * API lookups. The TMDB resolver remains the authority for anything it misses.
 */
import { parseCsv } from './csv.mjs';
import { textOf } from './zip.mjs';

/** Strips case, accents, and punctuation so "Re: ZERO" matches "Re ZERO". */
export function normaliseTitle(title) {
    return (title ?? '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '');
}

export function createCrosswalk() {
    return {
        movieByImdb: new Map(),   // imdb -> { tvdb, uuid }
        showByTitle: new Map(),   // normalised title -> { tvdb, uuid }
        episodeByKey: new Map(),  // `${showTvdb}|${season}|${episode}` -> tvdb
        sources: [],
    };
}

const findFile = (files, test) => [...files.keys()].find(name => test(name.split('/').pop()));
const readJson = (files, name) => JSON.parse(textOf(files.get(name)));
const readCsv = (files, name) => parseCsv(textOf(files.get(name)));

function addShow(crosswalk, title, tvdb, uuid) {
    const key = normaliseTitle(title);
    const id = Number(tvdb);
    if (!key || !Number.isFinite(id) || id <= 0) return;
    const existing = crosswalk.showByTitle.get(key);
    // Keep the first hit, but let a later source fill in a missing uuid.
    if (existing) { if (!existing.uuid && uuid) existing.uuid = uuid; return; }
    crosswalk.showByTitle.set(key, { tvdb: id, uuid: uuid ?? null });
}

function addEpisode(crosswalk, showTvdb, season, episode, tvdb) {
    const id = Number(tvdb);
    if (!Number.isFinite(id) || id <= 0) return;
    crosswalk.episodeByKey.set(`${Number(showTvdb)}|${Number(season)}|${Number(episode)}`, id);
}

/**
 * Feeds one TV Time export into the crosswalk. The export kind is detected from
 * its filenames, so callers can pass archives in any order.
 * @param {Map<string, Uint8Array>} files
 */
export function addExport(crosswalk, files, label = 'export') {
    let kind = null;

    // --- TV Time Liberator: movies.json + shows.json ---
    const moviesJson = findFile(files, name => name === 'movies.json');
    const showsJson = findFile(files, name => name === 'shows.json');
    if (moviesJson && showsJson) {
        kind = 'liberator';
        for (const movie of readJson(files, moviesJson)) {
            const imdb = movie?.id?.imdb;
            const tvdb = Number(movie?.id?.tvdb);
            if (imdb && imdb !== '-1' && Number.isFinite(tvdb)) {
                crosswalk.movieByImdb.set(imdb, { tvdb, uuid: movie.uuid ?? null });
            }
        }
        for (const show of readJson(files, showsJson)) {
            addShow(crosswalk, show.title, show?.id?.tvdb, show.uuid);
            for (const season of show.seasons ?? []) {
                for (const episode of season.episodes ?? []) {
                    addEpisode(crosswalk, show?.id?.tvdb, season.number, episode.number, episode?.id?.tvdb);
                }
            }
        }
    }

    // --- Refract browser extension: tvtime-*.csv ---
    const refractMovies = findFile(files, name => /^tvtime-movies-.*\.csv$/.test(name));
    const refractSeries = findFile(files, name => /^tvtime-series-\d.*\.csv$/.test(name));
    const refractEpisodes = findFile(files, name => /^tvtime-series-episodes-.*\.csv$/.test(name));
    if (refractMovies || refractSeries || refractEpisodes) {
        kind = 'refract';
        for (const movie of refractMovies ? readCsv(files, refractMovies) : []) {
            const tvdb = Number(movie.tvdb_id);
            if (movie.imdb_id && Number.isFinite(tvdb) && !crosswalk.movieByImdb.has(movie.imdb_id)) {
                crosswalk.movieByImdb.set(movie.imdb_id, { tvdb, uuid: movie.uuid || null });
            }
        }
        for (const show of refractSeries ? readCsv(files, refractSeries) : []) {
            addShow(crosswalk, show.title, show.tvdb_id, show.uuid || null);
        }
        for (const episode of refractEpisodes ? readCsv(files, refractEpisodes) : []) {
            addEpisode(crosswalk, episode.series_tvdb_id, episode.season, episode.episode, episode.tvdb_id);
        }
    }

    // --- TV Time GDPR dump: titles + TVDB show ids only ---
    for (const [file, titleKey, idKey] of [
        ['followed_tv_show.csv', 'tv_show_name', 'tv_show_id'],
        ['user_tv_show_data.csv', 'tv_show_name', 'tv_show_id'],
        ['show_seen_episode_latest.csv', 'tv_show_name', 'tv_show_id'],
    ]) {
        const name = findFile(files, base => base === file);
        if (!name) continue;
        kind = 'gdpr';
        for (const row of readCsv(files, name)) addShow(crosswalk, row[titleKey], row[idKey], null);
    }

    if (kind) crosswalk.sources.push({ label, kind });
    return kind;
}

export function crosswalkStats(crosswalk) {
    return {
        movies: crosswalk.movieByImdb.size,
        shows: crosswalk.showByTitle.size,
        episodes: crosswalk.episodeByKey.size,
        sources: crosswalk.sources,
    };
}
