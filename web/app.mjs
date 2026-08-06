/**
 * Browser front-end. Wires the three steps to the shared conversion core.
 * The build step inlines src/*.mjs above this file, so `convert` and `readZip`
 * are already in scope in the bundled page.
 */
import { convert } from '../src/convert.mjs';
import { readZip } from '../src/zip.mjs';
import { burstConfetti } from './confetti.mjs';

const $ = id => document.getElementById(id);
const KEY_STORAGE = 'sofaTimeToBingers.tmdbKey';
const CACHE_STORAGE = 'sofaTimeToBingers.tmdbCache';
const STAR_STORAGE = 'sofaTimeToBingers.starPrompted';
const REPO_URL = 'https://github.com/Will0wn/sofa-time-to-bingers';

const state = { sofa: null, tvtime: [] };

const formatBytes = bytes => bytes > 1048576
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Turns a drop zone plus a hidden input into one picker. */
function wirePicker(dropId, inputId, onFiles) {
    const drop = $(dropId);
    const input = $(inputId);
    drop.addEventListener('click', () => input.click());
    drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', event => {
        event.preventDefault();
        drop.classList.remove('over');
        onFiles([...event.dataTransfer.files]);
    });
    input.addEventListener('change', () => onFiles([...input.files]));
}

function renderFiles(listId, files) {
    $(listId).innerHTML = files
        .map(file => `<li><span>${file.name}</span><span>${formatBytes(file.size)}</span></li>`)
        .join('');
}

function refreshGate() {
    $('step2').setAttribute('aria-disabled', String(!state.sofa));
    $('step3').setAttribute('aria-disabled', String(!state.sofa));
    $('go').disabled = !state.sofa;
}

wirePicker('sofaDrop', 'sofaInput', files => {
    const zip = files.find(file => file.name.toLowerCase().endsWith('.zip'));
    if (!zip) return;
    state.sofa = zip;
    renderFiles('sofaFiles', [zip]);
    refreshGate();
});

wirePicker('tvtDrop', 'tvtInput', files => {
    state.tvtime = files.filter(file => file.name.toLowerCase().endsWith('.zip'));
    renderFiles('tvtFiles', state.tvtime);
});

$('key').value = localStorage.getItem(KEY_STORAGE) ?? '';
$('key').addEventListener('change', event => localStorage.setItem(KEY_STORAGE, event.target.value.trim()));

function loadCache() {
    try {
        return new Map(Object.entries(JSON.parse(sessionStorage.getItem(CACHE_STORAGE) ?? '{}')));
    } catch {
        return new Map();
    }
}

function saveCache(cache) {
    // Best effort: a large library can exceed the quota, which is harmless.
    try {
        sessionStorage.setItem(CACHE_STORAGE, JSON.stringify(Object.fromEntries(cache)));
    } catch { /* ignore */ }
}

const PHASE_LABEL = {
    parse: 'Reading your export',
    crosswalk: 'Indexing your TV Time exports',
    shows: 'Matching shows on TMDB',
    movies: 'Matching movies',
    episodes: 'Matching episodes on TMDB',
    build: 'Writing the archive',
    done: 'Ready',
};

function showProgress(update) {
    $('bar').hidden = false;
    $('status').hidden = false;
    const label = PHASE_LABEL[update.phase] ?? update.phase ?? '';
    if (update.total) {
        $('bar').firstElementChild.style.width = `${(100 * update.done / update.total).toFixed(1)}%`;
        $('status').textContent = `${label}, ${update.done.toLocaleString()} / ${update.total.toLocaleString()}`;
    } else {
        $('status').textContent = update.message ?? label;
    }
}

function percentClass(resolved, total) {
    if (!total) return 'warn';
    const ratio = resolved / total;
    return ratio > 0.97 ? 'ok' : ratio > 0.8 ? 'warn' : 'bad';
}

function renderReport(report, blobUrl, filename) {
    const row = (name, { resolved, total }) => `
        <div class="row">
            <b>${name}</b>
            <span>${resolved.toLocaleString()} of ${total.toLocaleString()}</span>
            <span class="pct ${percentClass(resolved, total)}">${total ? (100 * resolved / total).toFixed(1) : '0'}%</span>
        </div>`;

    const warnings = report.warnings.map(text => `<p class="note">${text}</p>`).join('');
    const unresolved = report.unresolvedShows?.length
        ? `<details><summary>${report.unresolvedShows.length} shows we could not identify</summary>
             <div class="missing">${report.unresolvedShows.join('<br>')}</div></details>`
        : '';

    $('result').hidden = false;
    $('result').innerHTML = `
        <div class="matched">
            <h3>Recognised</h3>
            ${row('Shows', report.coverage.shows)}
            ${row('Movies', report.coverage.movies)}
            ${row('Episodes', report.coverage.episodes)}
        </div>
        ${warnings}
        ${unresolved}
        <div class="done">
            <a href="${blobUrl}" download="${filename}" id="download"><button>Download the archive</button></a>
            <p class="hint">
                ${formatBytes(report.zipBytes)}, checked and ready.
                Upload it at <a href="https://bingers.app/import" target="_blank" rel="noopener">bingers.app/import</a>.
            </p>
        </div>`;

    $('download').addEventListener('click', celebrate, { once: true });
}

/** Confetti on the download, then the star prompt once the dust settles. */
function celebrate() {
    burstConfetti();
    if (localStorage.getItem(STAR_STORAGE)) return;
    setTimeout(() => {
        localStorage.setItem(STAR_STORAGE, '1');
        $('starModal').hidden = false;
    }, 1400);
}

function closeStarModal() {
    $('starModal').hidden = true;
}

$('starLink').href = REPO_URL;
$('starLink').addEventListener('click', closeStarModal);
$('starLater').addEventListener('click', closeStarModal);
$('starModal').addEventListener('click', event => {
    if (event.target === $('starModal')) closeStarModal();
});
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('starModal').hidden) closeStarModal();
});

$('go').addEventListener('click', async () => {
    const button = $('go');
    button.disabled = true;
    $('result').hidden = true;

    try {
        const tvTimeExports = [];
        for (const file of state.tvtime) {
            tvTimeExports.push({ files: await readZip(await file.arrayBuffer()), label: file.name });
        }

        const cache = loadCache();
        const { zip, report } = await convert({
            sofaZip: await state.sofa.arrayBuffer(),
            tvTimeExports,
            tmdbKey: $('key').value.trim(),
            resolveEpisodeIds: true,
            cache,
            onProgress: showProgress,
        });
        saveCache(cache);

        const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
        renderReport(report, url, 'tv-time-liberator-export.zip');
    } catch (error) {
        $('status').hidden = false;
        $('status').innerHTML = `<span class="bad">${error.message}</span>`;
    } finally {
        button.disabled = false;
    }
});

refreshGate();
