# Sofa Time to Bingers

Moving from Sofa Time to [Bingers](https://bingers.app) and stuck because Bingers does not read
Sofa Time exports? This converts yours into a file it does read.

Bingers accepts archives from TV Time, Trakt and Refract. This tool takes your Sofa Time export
and rewrites it as one of those, keeping your watch history, your watch dates and your episode
ratings.

**Nothing is uploaded.** The conversion happens on your own device, in your own browser.

## How to use it

1. **Open the converter.** [Click here](https://will0wn.github.io/sofa-time-to-bingers/). There
   is nothing to install.
2. **Drop in your Sofa Time export.** The `.zip` file the app gave you.
3. **Paste a TMDB key.** See below, it is free and takes a minute.
4. **Download the result**, then upload that file at
   [bingers.app/import](https://bingers.app/import).

That is the whole process. A large library takes under a minute.

## Getting the TMDB key

Sofa Time and Bingers use different databases to identify shows and films. TMDB is the free
service that can translate between them, and it needs you to have your own key. It costs
nothing.

1. Create an account at [themoviedb.org](https://www.themoviedb.org/signup).
2. Go to [Settings, then API](https://www.themoviedb.org/settings/api).
3. Request a **Developer** key. It is approved straight away. You will be asked for a name and
   contact details.
4. Copy either the **API Key** or the **API Read Access Token**. Both work.

Your key stays in your browser. It is never sent anywhere except to TMDB, and never to us.

## What comes across, and what does not

Everything Sofa Time puts in its export is carried over:

- every episode you watched, with the date you watched it
- your films, watched and on your watchlist
- your episode ratings
- shows you stopped watching

Three things cannot come across, because Sofa Time does not put them in the export at all. No
converter can recover them:

- **ratings you gave to films** (episode ratings are fine, film ratings are simply not exported)
- **your favourites**
- **your custom lists**

## If something looks off

**Some shows did not import.** The converter tells you how many it recognised. If a show is
missing it usually means TMDB does not have an id for it. Nothing you can do from here, but it
is only ever a handful.

**Two shows became one.** Occasionally TMDB gives the same id to a remake and to the original,
so Bingers treats them as the same show. The converter warns you when this happens and tells you
whether any watch history is affected. Usually none is.

**A few episodes are missing.** Very new episodes and specials sometimes have no id yet. The
converter reports the exact count.

**Already have an old TV Time export?** Drop it in the optional slot. The converter reuses the
ids inside it, so it finishes faster. Completely optional.

---

## For developers

Zero dependencies. The conversion core uses only Web platform APIs, so the same modules run in
the browser and in Node 18 or later.

### Command line

```bash
node bin/sofa2ttl.mjs sofa_time_export.zip \
  --tmdb-key <your key> \
  --out tv-time-liberator-export.zip
```

| Option | |
|---|---|
| `-o, --out <file>` | output archive, defaults to `tv-time-liberator-export.zip` |
| `-k, --tmdb-key <key>` | TMDB v3 key or v4 token, or set `TMDB_API_KEY` |
| `-t, --tvtime <zip>` | an existing TV Time export to mine for ids, repeatable |
| `--no-episode-ids` | skip per-episode lookups, much faster and less precise |
| `--cache <file>` | TMDB response cache, defaults to `.cache/tmdb.json` |
| `--report <file>` | write the full JSON report |

### The identifier problem

Sofa Time identifies everything by TMDB id. Every TV Time derived format, Liberator and Refract
and the GDPR dump alike, identifies everything by TVDB id. There is no formula between the two,
they are separate databases, and TMDB's `external_ids` endpoint is the only public mapping. That
is the whole reason a key is needed.

An existing TV Time export helps but cannot replace it: those archives carry no TMDB ids, so
shows can only be joined by title, which fails on localised ones. Films join exactly, on IMDB id.

### Rate limits

TMDB documents its limit as *"somewhere in the 40 requests per second range"*, with no daily cap,
and answers `429` when exceeded. The resolver stays under that, honours `429` (using
`Retry-After` when present, capped exponential backoff otherwise), and caches every lookup, so a
second run or a resume after an interruption costs almost nothing.

Shows resolve in one request each. Episodes are the expensive part, which is what
`--no-episode-ids` and the crosswalk are for.

### How the output is verified

Bingers classifies an archive by scanning its first 512 KB for marker filenames:

```js
{ format: "tvtime-liberator", markers: ["activity_history.csv"],
  requiredMarkers: ["shows.json", "movies.json"] }
```

Entry order therefore matters, and the converter checks it on every run. `test/validate.mjs`
compares a generated archive against a real Liberator export field by field: key order, types,
JSON indentation, CSV quoting, CRLF line endings and row counts.

```bash
node test/validate.mjs out.zip reference-liberator-export.zip
```

### Layout

```
src/       conversion core, no Node APIs, runs in the browser and in Node
  sofa.mjs        parses the Sofa Time export
  crosswalk.mjs   mines ids out of existing TV Time exports
  resolver.mjs    TMDB to TVDB lookups, rate limiting, caching
  liberator.mjs   writes the six Liberator files
  convert.mjs     orchestration
  zip.mjs         ZIP reader and writer, Web APIs only
  csv.mjs         CSV matching @std/csv's output
web/       browser front end
bin/       command line front end
docs/      single file build, npm run build
```

## Licence

GNU GPL 3.0, see [LICENSE](LICENSE).

Not affiliated with Sofa Time, TV Time, Bingers, Refract or TMDB. This product uses the TMDB API
but is not endorsed or certified by TMDB.
