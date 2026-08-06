/**
 * TMDB -> TVDB identifier resolution.
 *
 * Sofa Time speaks TMDB; every TV Time-derived format (Liberator, Refract,
 * GDPR) speaks TVDB. TMDB's `external_ids` is the bridge.
 *
 * TMDB documents its limit as "somewhere in the 40 requests per second range",
 * with no daily cap, and answers 429 when exceeded. We therefore run a bounded
 * pool well under that ceiling, honour 429 (Retry-After when present, capped
 * exponential backoff otherwise), and persist every lookup so a re-run or a
 * resume after an interruption costs nothing.
 */

const API = 'https://api.themoviedb.org/3';
const MAX_ATTEMPTS = 5;

/** v4 read access tokens are JWTs and go in the header; v3 keys are query params. */
function authFor(apiKey) {
    const isJwt = /^ey[\w-]+\.[\w-]+\.[\w-]+$/.test(apiKey.trim());
    return isJwt
        ? { headers: { Authorization: `Bearer ${apiKey.trim()}` }, query: '' }
        : { headers: {}, query: `api_key=${encodeURIComponent(apiKey.trim())}` };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Runs `worker` over `items` with bounded concurrency, preserving order. */
async function pool(items, concurrency, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}

export function createResolver({
    apiKey,
    cache = new Map(),
    concurrency = 16,
    onProgress = () => {},
    fetchImpl = globalThis.fetch,
} = {}) {
    const auth = apiKey ? authFor(apiKey) : null;
    let calls = 0;
    let cacheHits = 0;

    async function get(path) {
        if (!auth) return null;
        if (cache.has(path)) { cacheHits++; return cache.get(path); }

        const separator = path.includes('?') ? '&' : '?';
        const url = `${API}${path}${auth.query ? separator + auth.query : ''}`;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            let response;
            try {
                calls++;
                response = await fetchImpl(url, { headers: auth.headers });
            } catch (error) {
                if (attempt === MAX_ATTEMPTS) throw error;
                await sleep(Math.min(2 ** attempt * 250, 8000));
                continue;
            }

            if (response.status === 429) {
                const retryAfter = Number(response.headers.get('retry-after'));
                await sleep(Number.isFinite(retryAfter) && retryAfter > 0
                    ? retryAfter * 1000 + 250
                    : Math.min(2 ** attempt * 500, 10000));
                continue;
            }
            // 404 is a legitimate answer: the id simply is not in TMDB.
            if (response.status === 404) { cache.set(path, null); return null; }
            if (response.status === 401) {
                throw new Error('TMDB did not accept that key. Check you copied it in full, then try again.');
            }
            if (!response.ok) {
                if (attempt === MAX_ATTEMPTS) return null;
                await sleep(Math.min(2 ** attempt * 500, 10000));
                continue;
            }

            const body = await response.json();
            cache.set(path, body);
            return body;
        }
        return null;
    }

    return {
        get stats() { return { calls, cacheHits, cached: cache.size }; },
        get enabled() { return Boolean(auth); },

        /**
         * Fills in `tvdb` and `totalEpisodes` on each show.
         * `totalEpisodes` drives the up_to_date / continuing status decision.
         */
        async resolveShows(shows) {
            let done = 0;
            await pool(shows, concurrency, async show => {
                if (show.tvdb == null && show.tmdb != null) {
                    const data = await get(`/tv/${show.tmdb}?append_to_response=external_ids`);
                    const tvdb = Number(data?.external_ids?.tvdb_id);
                    if (Number.isFinite(tvdb) && tvdb > 0) show.tvdb = tvdb;
                    if (!show.imdb && data?.external_ids?.imdb_id) show.imdb = data.external_ids.imdb_id;
                    if (Number.isFinite(data?.number_of_episodes)) show.totalEpisodes = data.number_of_episodes;
                }
                onProgress({ phase: 'shows', done: ++done, total: shows.length, title: show.title });
            });
            return shows;
        },

        /**
         * TMDB exposes no TVDB id for movies, so this only backfills a missing
         * IMDB id, which is the identifier the Liberator format leans on for
         * movies anyway.
         */
        async resolveMovies(movies) {
            const pending = movies.filter(movie => !movie.imdb && movie.tmdb != null);
            let done = 0;
            await pool(pending, concurrency, async movie => {
                const data = await get(`/movie/${movie.tmdb}/external_ids`);
                if (data?.imdb_id) movie.imdb = data.imdb_id;
                onProgress({ phase: 'movies', done: ++done, total: pending.length, title: movie.title });
            });
            return movies;
        },

        /**
         * Opt-in: one call per unresolved episode. Only worth running if the
         * target importer keys episodes on TVDB ids rather than season/episode
         * numbers.
         */
        async resolveEpisodes(shows) {
            const pending = [];
            for (const show of shows) {
                if (show.tmdb == null) continue;
                for (const season of show.seasons ?? []) {
                    for (const episode of season.episodes ?? []) {
                        if (episode.tvdb == null) pending.push({ show, season, episode });
                    }
                }
            }
            let done = 0;
            await pool(pending, concurrency, async ({ show, season, episode }) => {
                const data = await get(
                    `/tv/${show.tmdb}/season/${season.number}/episode/${episode.number}/external_ids`,
                );
                const tvdb = Number(data?.tvdb_id);
                if (Number.isFinite(tvdb) && tvdb > 0) episode.tvdb = tvdb;
                onProgress({ phase: 'episodes', done: ++done, total: pending.length, title: show.title });
            });
            return shows;
        },
    };
}
