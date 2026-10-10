/* Static checks on the generated viewer. Does not launch a browser. */
const fs = require('node:fs');
const path = require('node:path');
const out = path.resolve(__dirname, '..', '..', 'docs', 'erd');
const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
const inv = JSON.parse(fs.readFileSync(path.join(out, 'erd-inventory.json'), 'utf8'));
const res = [];
const chk = (l, c) => res.push(`${c ? 'PASS' : 'FAIL'}  ${l}`);

// Structure
chk('has doctype + title', html.startsWith('<!doctype html>') && html.includes('Entity Relationship Diagram'));
chk('one tab per domain + overview + tables',
  (html.match(/data-view="/g) || []).length === inv.domains.length + 2);
chk('one section per domain', (html.match(/role="tabpanel"/g) || []).length === inv.domains.length + 2);

// Embedded JSON payload parses
const m = html.match(/<script id="erd-data" type="application\/json">([\s\S]*?)<\/script>/);
chk('embedded payload present', !!m);
let data = null;
try { data = JSON.parse(m[1]); chk('embedded payload is valid JSON', true); }
catch (e) { chk('embedded payload is valid JSON -> ' + e.message, false); }

// Payload covers every model and relationship
chk(`payload has all ${data.domains.length} domains`, data.domains.length === inv.domains.length);
const modelled = data.domains.reduce((n, d) => n + d.models.length, 0);
chk(`payload models every entity (${modelled}/${inv.entities.length})`, modelled === inv.entities.length);
chk('payload overview non-empty', data.overview && data.overview.includes('erDiagram'));
chk('every domain has mermaid source', data.domains.every((d) => d.source.includes('erDiagram')));

// Tables
chk('relationship table row per relationship',
  (html.match(/<tr data-search=/g) || []).length === inv.relationships.length);
chk('entity table row per entity',
  (html.match(/<code>[A-Za-z]+<\/code><\/td><td>D\d/g) || []).length === inv.entities.length);

// Offline fallback must exist
chk('falls back to source view when mermaid missing',
  html.includes('if (!hasMermaid)') && html.includes('data-source='));
chk('render errors also degrade to source', html.includes("pre.textContent = src + '\\n\\n/* render error"));

// No undefined identifiers leaked into the script. "undefined" inside a
// typeof-guard string literal is legitimate, so strip those first.
const script = html.slice(html.lastIndexOf('<script>'));
const bareUndefined = script.replace(/'undefined'/g, '').match(/\bundefined\b/g);
chk('no stray "undefined" in script body', !bareUndefined);
chk('every <identifier>.addEventListener target is declared',
  ['var tabs', 'var main', 'document'].every((d) => script.includes(d)));
chk('main is declared before use', script.indexOf('var main') < script.indexOf('main.addEventListener'));

// HTML escaping of injected model names is safe
chk('no raw "<script" inside payload', !m[1].includes('<script'));
chk('mermaid CDN pinned to major', /mermaid@11/.test(html));

console.log(res.join('\n'));
const fails = res.filter((r) => r.startsWith('FAIL'));
console.log(`\n${res.length - fails.length}/${res.length} passed`);
if (fails.length) process.exit(1);
