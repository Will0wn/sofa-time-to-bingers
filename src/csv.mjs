/**
 * CSV helpers matching the exact output of @std/csv's `stringify`, which is
 * what TV Time Liberator uses: CRLF line endings, a trailing CRLF, and quoting
 * only when a field contains a delimiter, quote, or newline.
 */

export function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (quoted) {
            if (char !== '"') { field += char; continue; }
            if (text[i + 1] === '"') { field += '"'; i++; continue; }
            quoted = false;
        } else if (char === '"') {
            quoted = true;
        } else if (char === ',') {
            row.push(field); field = '';
        } else if (char === '\n') {
            row.push(field); field = ''; rows.push(row); row = [];
        } else if (char !== '\r') {
            field += char;
        }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }

    const header = rows.shift() ?? [];
    return rows
        .filter(r => r.length === header.length)
        .map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

function escapeField(value) {
    if (value == null) return '';
    const text = typeof value === 'boolean' ? String(value) : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function stringifyCsv(rows) {
    return rows.map(row => row.map(escapeField).join(',')).join('\r\n') + '\r\n';
}
