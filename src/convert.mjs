/**
 * Orchestrates the Sofa Time -> TV Time Liberator conversion.
 * Runtime-agnostic: the browser page and the CLI both call `convert`.
 */
import { addExport, createCrosswalk, normaliseTitle } from './crosswalk.mjs';
import { buildLiberatorFiles, verifyMarkers } from './liberator.mjs';
import { createResolver } from './resolver.mjs';
import { countEpisodes, parseSofaExport } from './sofa.mjs';
import { writeZip } from './zip.mjs';

/** Applies the crosswalk in place and reports how much it covered. */
function applyCrosswalk(library, crosswalk) {
    let movies = 0;
    let shows = 0;
    let episodes = 0;

    for (const movie of library.movies) {
        const hit = movie.imdb ? crosswalk.movieByImdb.get(movie.imdb) : null;
        if (!hit) continue;
        movie.tvdb = hit.tvdb;
        movie.uuid ??= hit.uuid ?? undefined;
        movies++;
    }

    for (const show of library.shows) {
        const hit = crosswalk.showByTitle.get(normaliseTitle(show.title));
        if (!hit) continue;
        show.tvdb = hit.tvdb;
        show.uuid ??= hit.uuid ?? undefined;
        shows++;
    }

    // Episode ids depend on the show already having a TVDB id.
    for (const show of library.shows) {
        if (!Number.isFinite(show.tvdb)) continue;
        for (const season of show.seasons ?? []) {
            for (const episode of season.episodes) {
                const hit = crosswalk.episodeByKey.get(`${show.tvdb}|${season.number}|${episode.number}`);
                if (hit == null) continue;
                episode.tvdb = hit;
                episodes++;
            }
        }
    }

    return { movies, shows, episodes };
}

/** Second crosswalk pass: shows that only got a TVDB id from TMDB. */
function applyEpisodeCrosswalk(library, crosswalk) {
    let episodes = 0;
    for (const show of library.shows) {
        if (!Number.isFinite(show.tvdb)) continue;
        for (const season of show.seasons ?? []) {
            for (const episode of season.episodes) {
                if (episode.tvdb != null) continue;
                const hit = crosswalk.episodeByKey.get(`${show.tvdb}|${season.number}|${episode.number}`);
                if (hit == null) continue;
                episode.tvdb = hit;
                episodes++;
            }
        }
    }
    return episodes;
}

function coverage(library) {
    const shows = library.shows.filter(show => Number.isFinite(show.tvdb)).length;
    const movies = library.movies.filter(
        movie => Number.isFinite(movie.tvdb) || movie.imdb,
    ).length;

    let episodes = 0;
    let episodesTotal = 0;
    for (const show of library.shows) {
        for (const season of show.seasons ?? []) {
            for (const episode of season.episodes) {
                episodesTotal++;
                if (Number.isFinite(episode.tvdb)) episodes++;
            }
        }
    }

    return {
        shows: { resolved: shows, total: library.shows.length },
        movies: { resolved: movies, total: library.movies.length },
        episodes: { resolved: episodes, total: episodesTotal },
    };
}

/**
 * @param {object} options
 * @param {ArrayBuffer|Uint8Array} options.sofaZip          the Sofa Time export
 * @param {Array<Map<string, Uint8Array>>} [options.tvTimeExports] optional TV Time archives
 * @param {string} [options.tmdbKey]                        TMDB v3 key or v4 token
 * @param {boolean} [options.resolveEpisodeIds=true]        look up per-episode TVDB ids
 * @param {Map} [options.cache]                             persistent TMDB response cache
 * @param {(update: object) => void} [options.onProgress]
 */
export async function convert({
    sofaZip,
    tvTimeExports = [],
    tmdbKey = '',
    resolveEpisodeIds = true,
    cache = new Map(),
    concurrency = 16,
    onProgress = () => {},
}) {
    const report = { warnings: [] };

    onProgress({ phase: 'parse', message: 'Reading your export' });
    const library = await parseSofaExport(sofaZip);
    report.input = {
        movies: library.movies.length,
        shows: library.shows.length,
        episodes: countEpisodes(library.shows),
    };

    const crosswalk = createCrosswalk();
    if (tvTimeExports.length) {
        onProgress({ phase: 'crosswalk', message: 'Indexing your TV Time exports' });
        for (const { files, label } of tvTimeExports) addExport(crosswalk, files, label);
        report.crosswalk = applyCrosswalk(library, crosswalk);
        report.crosswalkSources = crosswalk.sources;
    }

    const resolver = createResolver({ apiKey: tmdbKey, cache, concurrency, onProgress });
    if (resolver.enabled) {
        onProgress({ phase: 'shows', message: 'Matching shows on TMDB' });
        await resolver.resolveShows(library.shows);
        // Shows that TMDB just resolved may now match crosswalk episode ids.
        if (tvTimeExports.length) applyEpisodeCrosswalk(library, crosswalk);

        onProgress({ phase: 'movies', message: 'Matching movies' });
        await resolver.resolveMovies(library.movies);

        if (resolveEpisodeIds) {
            onProgress({ phase: 'episodes', message: 'Matching episodes on TMDB' });
            await resolver.resolveEpisodes(library.shows);
        }
        report.tmdb = resolver.stats;
    } else {
        report.warnings.push(
            'Without a TMDB key the shows carry no id that Bingers can recognise, so most of your library will not import. Add a key and convert again.',
        );
    }

    report.coverage = coverage(library);

    // TMDB occasionally points two distinct entries at one TVDB id (a remake and
    // its original, most often). The importer keys on TVDB, so those entries
    // merge on arrival. Surface it rather than letting the counts look wrong.
    const byTvdb = new Map();
    for (const show of library.shows) {
        if (!Number.isFinite(show.tvdb)) continue;
        if (!byTvdb.has(show.tvdb)) byTvdb.set(show.tvdb, []);
        byTvdb.get(show.tvdb).push(show);
    }
    const collisions = [...byTvdb.entries()]
        .filter(([, group]) => group.length > 1)
        .map(([tvdb, group]) => ({
            tvdb,
            titles: group.map(show => show.title),
            // Episodes outside the first entry are the ones actually at risk.
            episodesAtRisk: group
                .map(show => (show.seasons ?? []).reduce((sum, s) => sum + s.episodes.length, 0))
                .sort((a, b) => b - a)
                .slice(1)
                .reduce((sum, count) => sum + count, 0),
        }));

    if (collisions.length) {
        report.tvdbCollisions = collisions;
        const episodesAtRisk = collisions.reduce((sum, c) => sum + c.episodesAtRisk, 0);
        report.warnings.push(
            `${collisions.length} show${collisions.length === 1 ? '' : 's'} share an id with `
            + `another entry, usually a remake and its original, so they will be combined into `
            + `one when you import. `
            + (episodesAtRisk
                ? `About ${episodesAtRisk} episode${episodesAtRisk === 1 ? '' : 's'} may not come across.`
                : 'None of your watch history is affected.'),
        );
    }
    if (report.coverage.shows.resolved < report.coverage.shows.total) {
        report.unresolvedShows = library.shows
            .filter(show => !Number.isFinite(show.tvdb))
            .map(show => show.title);
    }

    onProgress({ phase: 'build', message: 'Writing the archive' });
    const files = buildLiberatorFiles(library);
    const zip = await writeZip(files);

    const markers = verifyMarkers(zip);
    if (!markers.ok) {
        report.warnings.push(
            'This archive is missing something Bingers looks for, so it may not be recognised. '
            + `Please report this as a bug (missing: ${markers.missing.join(', ')}).`,
        );
    }
    report.markers = markers;
    report.files = files.map(file => ({
        name: file.name,
        bytes: typeof file.data === 'string' ? new TextEncoder().encode(file.data).length : file.data.length,
    }));
    report.zipBytes = zip.length;

    onProgress({ phase: 'done', message: 'Ready' });
    return { zip, report, library };
}
