/**
 * Inlines the shared core plus the browser front-end into a single HTML file.
 *
 * A single file is what makes the tool usable by people who do not have Node:
 * opening it straight from disk works, because there are no module fetches for
 * the file:// origin to block.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

// Dependency order; the modules share one scope once bundled.
const MODULES = [
    'src/csv.mjs',
    'src/zip.mjs',
    'src/sofa.mjs',
    'src/crosswalk.mjs',
    'src/resolver.mjs',
    'src/liberator.mjs',
    'src/convert.mjs',
    'web/confetti.mjs',
    'web/app.mjs',
];

/** Drops inter-module import statements and `export` keywords. */
function flatten(source) {
    return source
        .replace(/^\s*import\s+[^;]*?from\s*['"][^'"]+['"];?\s*$/gm, '')
        .replace(/^export\s+(?=(const|function|async function|class|let))/gm, '')
        .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
        .trim();
}

const parts = [];
for (const module of MODULES) {
    const source = await readFile(join(root, module), 'utf8');
    parts.push(`// ---------- ${module} ----------\n${flatten(source)}`);
}

const template = await readFile(join(root, 'web/index.html'), 'utf8');
const bundle = parts.join('\n\n');

if (!template.includes('/* BUNDLE */')) {
    throw new Error('web/index.html is missing the /* BUNDLE */ placeholder.');
}
// A literal </script> inside the code would close the tag early.
const html = template.replace('/* BUNDLE */', () => bundle.replace(/<\/script>/gi, '<\\/script>'));

await mkdir(join(root, 'docs'), { recursive: true });
await writeFile(join(root, 'docs/index.html'), html);

process.stdout.write(`docs/index.html  (${(html.length / 1024).toFixed(0)} KB)\n`);
