/* ERD builder.
 *
 *   node scripts/erd/build.js
 *
 * Reads the live Mongoose schemas (no DB connection, no .env), merges them with
 * the curated semantic layer in this folder, and writes:
 *
 *   docs/erd/diagrams/erd-overview.mmd       cross-domain hub view
 *   docs/erd/diagrams/erd-D1..D10.mmd        one ER diagram per bounded context
 *   docs/erd/erd-inventory.json              machine-readable relationship set
 *
 * Exit code 1 on any drift between the curated layer and the real schemas.
 */

const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

const { DOMAINS, DOMAIN_OF, PURPOSE } = require('./meta.domains');
const { SHOW, FIELD_COMMENT } = require('./meta.fields');
const { RELATIONS, HUBS } = require('./meta.relations');

const root = path.resolve(__dirname, '..', '..');
const modelDir = path.join(root, 'server', 'models');
const outDir = path.join(root, 'docs', 'erd');
const diagramDir = path.join(outDir, 'diagrams');
fs.mkdirSync(diagramDir, { recursive: true });

const problems = [];
const dangling = [];
const note = (msg) => problems.push(msg);

/* ---------------------------------------------------------------- load ---- */
for (const f of fs.readdirSync(modelDir).filter((f) => f.endsWith('.js')).sort()) {
  require(path.join(modelDir, f));
}
const models = Object.values(mongoose.models).sort((a, b) => a.modelName.localeCompare(b.modelName));
const byName = new Map(models.map((m) => [m.modelName, m]));
const known = new Set(byName.keys());

/* ------------------------------------------------- flatten every path ----- */
/* Mongoose 9 exposes the array element schema type as `embeddedSchemaType`
 * (older builds used `$embeddedSchemaType`, and Mongoose <=7 used `caster`). */
const elemType = (p) => p.embeddedSchemaType || p.$embeddedSchemaType || p.caster;

function flatten(schema, prefix = '', seen = new Set()) {
  if (seen.has(schema)) return [];
  const branch = new Set([...seen, schema]);
  const out = [];
  for (const [name, p] of Object.entries(schema.paths)) {
    const field = prefix + name;
    const opts = p.options || {};
    const caster = elemType(p);
    const ref = opts.ref || caster?.options?.ref;
    const isArray = p.instance === 'Array';
    const casterType = caster?.instance;
    out.push({
      path: field,
      leaf: !p.schema,
      type: p.instance,
      isArray,
      casterType,
      ref: typeof ref === 'string' ? ref : ref ? '<function>' : null,
      refPath: opts.refPath || caster?.options?.refPath || null,
      required: typeof opts.required === 'function' ? 'conditional' : !!opts.required,
      unique: !!opts.unique,
      enum: p.enumValues?.length ? p.enumValues : null,
    });
    if (p.schema) out.push(...flatten(p.schema, field + '.', branch));
  }
  return out;
}

const fieldsOf = new Map();
for (const m of models) fieldsOf.set(m.modelName, flatten(m.schema));

/* ------------------------------------------- discover relationships ------- */
/* A relationship is any ObjectId-shaped path that points somewhere. Three
 * flavours: explicit ref, refPath, and a bare ObjectId that is annotated as a
 * structural FK. Unannotated bare ObjectIds are ignored (e.g. _id, tokens).  */

/* Refs we EXPECT to dangle, with the reason. Each one is a confirmed defect in
 * the source, so the build reports it loudly instead of failing. Anything not
 * listed here that dangles is genuine new drift and must fail the build. */
const KNOWN_DANGLING = {
  Product: 'Purchase.items.productId refs a model that was never registered; the collection is write-dead legacy.',
};

const rels = [];
const annotated = new Set();

for (const m of models) {
  const name = m.modelName;
  for (const f of fieldsOf.get(name)) {
    const key = `${name}.${f.path}`;
    const ann = RELATIONS[key];
    const objectIdLike =
      f.type === 'ObjectId' ||
      f.type === 'Array' ||
      (f.isArray && f.casterType === 'ObjectId');
    if (!objectIdLike && !ann) continue;
    if (!ann) continue; // only curated paths become relationships

    annotated.add(key);
    let kind = ann.kind;
    let parent = ann.parent;

    if (kind === 'fk' || kind === 'self') {
      if (f.refPath) {
        note(`[${key}] declared kind=${kind} but the schema uses refPath "${f.refPath}". Use kind=poly.`);
      } else if (!f.ref) {
        note(`[${key}] declared kind=${kind} but the path has no \`ref\`.`);
      } else if (f.ref !== parent) {
        note(`[${key}] declared parent=${parent} but the schema refs "${f.ref}".`);
      }
      if (kind === 'self' && f.ref !== name) {
        note(`[${key}] declared kind=self but refs ${f.ref}.`);
      }
    }

    if (kind === 'poly' && !f.ref && !f.refPath) {
      note(`[${key}] declared kind=poly but the path has neither ref nor refPath.`);
    }
    if (kind === 'bare' && (f.ref || f.refPath)) {
      note(`[${key}] declared kind=bare but the schema has a ref/refPath.`);
    }
    if (kind === 'join' && f.type === 'ObjectId') {
      note(`[${key}] declared kind=join but the path is an ObjectId.`);
    }

    if (parent && !known.has(parent)) {
      if (KNOWN_DANGLING[parent]) {
        dangling.push({ child: name, path: f.path, parent, reason: KNOWN_DANGLING[parent] });
      } else {
        note(`[${key}] parent model "${parent}" is not registered by server/models. Add it to KNOWN_DANGLING if this is an accepted legacy defect.`);
      }
    }

    rels.push({
      child: name,
      path: f.path,
      parent,
      kind,
      card: ann.card,
      note: ann.note || '',
      required: f.required,
      isArray: f.isArray,
      refPath: f.refPath,
      schemaRef: f.ref,
      unique: f.unique,
    });
  }
}

/* Reverse: every curated key must exist in a real schema. */
for (const key of Object.keys(RELATIONS)) {
  if (annotated.has(key)) continue;
  const [model, ...rest] = key.split('.');
  const path = rest.join('.');
  if (!byName.has(model)) { note(`[${key}] model "${model}" does not exist.`); continue; }
  const known2 = fieldsOf.get(model).map((f) => f.path);
  note(`[${key}] path does not exist on ${model}. Available near-misses: ${known2.filter((p) => p.includes(path.split('.').pop())).slice(0, 5).join(', ') || 'none'}`);
}

/* Every entity must have a purpose, and every domain must be fully mapped. */
for (const m of models) {
  if (!PURPOSE[m.modelName]) note(`Missing PURPOSE for ${m.modelName}.`);
  if (!DOMAIN_OF[m.modelName]) note(`Missing DOMAIN_OF for ${m.modelName}.`);
}
for (const [name, dom] of Object.entries(DOMAIN_OF)) {
  if (!byName.has(name)) note(`DOMAIN_OF lists "${name}", which is not a model.`);
  if (!DOMAINS.some((d) => d.id === dom)) note(`DOMAIN_OF maps ${name} to unknown domain ${dom}.`);
}
for (const d of DOMAINS) {
  const members = models.filter((m) => DOMAIN_OF[m.modelName] === d.id);
  if (!members.length) note(`Domain ${d.id} has no models.`);
}

/* Every rendered field must exist (or be a declared embedded container). */
for (const [model, fields] of Object.entries(SHOW)) {
  if (!byName.has(model)) { note(`SHOW lists "${model}", which is not a model.`); continue; }
  const all = fieldsOf.get(model);
  const paths = new Set(all.map((f) => f.path));
  for (const raw of fields) {
    if (raw.startsWith('+')) {
      const name = raw.slice(1);
      if (paths.has(name)) {
        note(`SHOW ${model}.+${name} is a real schema path; drop the "+" prefix.`);
      } else if (!all.some((f) => f.path.startsWith(name + '.'))) {
        note(`SHOW ${model}.+${name} is neither a schema path nor an embedded container.`);
      }
      continue;
    }
    if (!paths.has(raw)) note(`SHOW ${model}.${raw} does not exist on the schema.`);
  }
}
for (const m of models) {
  if (!SHOW[m.modelName]) note(`Missing SHOW entry for ${m.modelName}.`);
}
for (const key of Object.keys(FIELD_COMMENT)) {
  const [model, ...rest] = key.split('.');
  const path = rest.join('.');
  if (!byName.has(model)) { note(`FIELD_COMMENT lists "${model}", not a model.`); continue; }
  const all = fieldsOf.get(model);
  const paths = new Set(all.map((f) => f.path));
  if (!paths.has(path) && !all.some((f) => f.path.startsWith(path + '.'))) {
    note(`FIELD_COMMENT ${key} does not exist on ${model}.`);
  }
}

/* --------------------------------------------------------- enum capture --- */
const enumsOf = new Map();
for (const m of models) {
  const found = new Map();
  for (const f of fieldsOf.get(m.modelName)) if (f.enum) found.set(f.path, f.enum);
  enumsOf.set(m.modelName, found);
}

/* --------------------------------------------------------- mermaid emit --- */
/* Mermaid erDiagram attribute syntax is:
 *     <type> <name> [PK|FK|UK|...] "<comment>"
 * Flags are bare comma-free tokens; only the comment may be quoted. */
const cm = (s) => `"${String(s).replace(/"/g, "'")}"`;

function typeLabel(f) {
  const map = {
    String: 'string', Number: 'number', Date: 'date', Boolean: 'bool',
    Mixed: 'mixed', ObjectId: 'ObjectId', Array: 'array', Embedded: 'object',
  };
  if (f.type === 'Array') {
    const inner = { String: 'string', Number: 'number', Date: 'date', Boolean: 'bool', ObjectId: 'ObjectId', Mixed: 'mixed', Embedded: 'object' };
    return `${inner[f.casterType] || 'object'}[]`;
  }
  return map[f.type] || String(f.type).toLowerCase();
}

function attrLines(model) {
  const all = fieldsOf.get(model);
  const byPath = new Map(all.map((f) => [f.path, f]));
  const relByPath = new Map(rels.filter((r) => r.child === model).map((r) => [r.path, r]));
  const lines = [];
  for (const raw of SHOW[model] || []) {
    // "+name" renders an embedded container (a single subdocument or a nested
    // path group) as one box line. Mongoose keeps no standalone path for those.
    const container = raw.startsWith('+');
    const name = container ? raw.slice(1) : raw;
    const r = relByPath.get(name);
    const comment = FIELD_COMMENT[`${model}.${name}`] || '';

    if (container) {
      if (byPath.has(name)) continue; // it is a real path, no need to collapse
      if (!all.some((f) => f.path.startsWith(name + '.'))) {
        note(`SHOW ${model}.+${name} is neither a schema path nor an embedded container.`);
        continue;
      }
      const text = comment || 'embedded';
      lines.push(`    object ${name} ${cm(text)}`);
      continue;
    }

    const f = byPath.get(name);
    if (!f) continue;

    if (name === '_id') {
      lines.push(`    ObjectId _id PK ${cm('MongoDB object id')}`);
      continue;
    }

    if (r && r.kind !== 'join') {
      const type = r.isArray ? 'ObjectId[]' : 'ObjectId';
      // Mermaid's er grammar accepts ONLY PK/FK/UK as key tokens, and only as a
      // comma-separated list. Anything else is a parse error, so the relationship
      // KIND is folded into the comment instead of the key column.
      const flags = r.card === '1' ? 'FK,UK' : 'FK';
      const kindNote = { poly: 'polymorphic refPath', bare: 'UNTYPED, no ref', embed: 'subdocument id' }[r.kind];
      const text = [kindNote, comment].filter(Boolean).join(' | ');
      lines.push(`    ${type} ${name} ${flags}${text ? ' ' + cm(text) : ''}`);
    } else {
      lines.push(`    ${typeLabel(f)} ${name}${comment ? ' ' + cm(comment) : ''}`);
    }
  }
  return lines;
}

/* Cardinality marker on the PARENT side of the relationship line.
 *   1  => "||"  exactly one parent row
 *   0..1 => "o|" zero or one parent row
 *   *  => "}o"  zero or many parent rows */
function parentMarker(card) {
  return card === '1' ? '||' : card === '0..1' ? 'o|' : '}o';
}

function entityBlock(model) {
  return [`  ${model} {`, ...attrLines(model), `  }`].join('\n');
}

function relLine(r) {
  const tag = r.kind === 'bare' ? ' untyped' : r.kind === 'embed' ? ' subdoc' : r.kind === 'poly' ? ' refPath' : '';
  const label = r.child === r.parent ? `${r.path}${tag} self` : `${r.path}${tag}`;
  return `  ${r.child} ${parentMarker(r.card)}--o{ ${r.parent} : ${cm(label)}`;
}

/* Per-domain diagram: entities in the domain + every relationship whose child
 * lives in the domain. Cross-domain edges are kept so the reader sees where a
 * domain hands work off. */
const written = [];
for (const d of DOMAINS) {
  const members = models.filter((m) => DOMAIN_OF[m.modelName] === d.id).map((m) => m.modelName);
  const memberSet = new Set(members);
  const rel = rels.filter((r) => memberSet.has(r.child));
  const externalParents = [...new Set(rel.map((r) => r.parent))].filter((p) => !memberSet.has(p)).sort();
  const part = [
    `%% ${d.id} - ${d.name}`,
    `%% ${d.blurb}`,
    `%% Generated by scripts/erd/build.js. Do not edit by hand.`,
    `%% Entities: ${members.length}. Relationships originating here: ${rel.length}.`,
    externalParents.length ? `%% Reaches into: ${externalParents.join(', ')}` : '%% Reaches into: (nothing outside this domain)',
    'erDiagram',
    '',
    ...members.flatMap(entityBlock),
    '',
    ...rel.map(relLine),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(diagramDir, `erd-${d.id}.mmd`), part);
  written.push(`erd-${d.id}.mmd`);
}

/* Overview: every entity, only inter-domain and hub relationships. */
const overview = [
  '%% Cross-domain overview',
  '%% Generated by scripts/erd/build.js. Do not edit by hand.',
  'erDiagram',
  '',
  ...models.map((m) => entityBlock(m.modelName)),
  '',
  ...rels.map(relLine),
  '',
].join('\n');
fs.writeFileSync(path.join(diagramDir, 'erd-overview.mmd'), overview);
written.push('erd-overview.mmd');

/* ------------------------------------------------------------ inventory --- */
const inventory = {
  generatedBy: 'scripts/erd/build.js',
  counts: {
    models: models.length,
    relationships: rels.length,
    byKind: rels.reduce((acc, r) => ((acc[r.kind] = (acc[r.kind] || 0) + 1), acc), {}),
    byDomain: DOMAINS.reduce((acc, d) => {
      acc[d.id] = {
        name: d.name,
        models: models.filter((m) => DOMAIN_OF[m.modelName] === d.id).map((m) => m.modelName),
        relationships: rels.filter((r) => DOMAIN_OF[r.child] === d.id).length,
      };
      return acc;
    }, {}),
  },
  hubs: HUBS,
  domains: DOMAINS,
  entities: models.map((m) => ({
    name: m.modelName,
    domain: DOMAIN_OF[m.modelName],
    collection: m.collection.name,
    purpose: PURPOSE[m.modelName],
    timestamps: m.schema.options.timestamps || false,
    optimisticConcurrency: m.schema.options.optimisticConcurrency || false,
    fieldCount: fieldsOf.get(m.modelName).length,
    indexCount: m.schema.indexes().length,
    renderedFields: (SHOW[m.modelName] || []).map((raw) => {
      const container = raw.startsWith('+');
      const p = container ? raw.slice(1) : raw;
      const hit = fieldsOf.get(m.modelName).find((f) => f.path === p);
      return {
        path: p,
        embedded: container || !hit,
        type: hit ? typeLabel(hit) : 'object',
        comment: FIELD_COMMENT[`${m.modelName}.${p}`] || null,
      };
    }),
    enums: Object.fromEntries(enumsOf.get(m.modelName)),
  })),
  relationships: rels.map((r) => ({
    child: r.child, path: r.path, parent: r.parent, kind: r.kind,
    cardinality: r.card, required: r.required, isArray: r.isArray,
    refPath: r.refPath, schemaRef: r.schemaRef, note: r.note,
  })),
  danglingReferences: dangling,
  risks: problems,
};
fs.writeFileSync(path.join(outDir, 'erd-inventory.json'), JSON.stringify(inventory, null, 2) + '\n');

/* ------------------------------------------------------------- viewer ---- */
/* A single self-contained HTML file. Mermaid is loaded from a CDN; if that is
 * unavailable (offline) the page falls back to showing the Mermaid source, so
 * the viewer is never a dead end. */
const viewerData = {
  domains: DOMAINS.map((d) => ({
    id: d.id,
    name: d.name,
    blurb: d.blurb,
    models: models.filter((m) => DOMAIN_OF[m.modelName] === d.id).map((m) => m.modelName),
    relationshipCount: rels.filter((r) => DOMAIN_OF[r.child] === d.id).length,
    source: fs.readFileSync(path.join(diagramDir, `erd-${d.id}.mmd`), 'utf8'),
  })),
  overview: fs.readFileSync(path.join(diagramDir, 'erd-overview.mmd'), 'utf8'),
  counts: inventory.counts,
  byKind: inventory.counts.byKind,
  dangling: dangling,
};

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CALIDRO RACS &mdash; Entity Relationship Diagram</title>
<style>
:root{--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--bg:#f1f5f9;--card:#fff;--accent:#1d4ed8}
*{box-sizing:border-box}
body{margin:0;font:15px/1.6 "Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--ink)}
header{background:var(--ink);color:#fff;padding:36px max(24px,4vw)}
header h1{margin:0 0 8px;font-size:30px;letter-spacing:-.02em}
header p{max-width:900px;color:#cbd5e1;margin:6px 0}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
.stats span{background:#1e293b;border-radius:8px;padding:8px 14px;font-size:13px}
.stats b{color:#93c5fd}
nav{position:sticky;top:0;z-index:5;display:flex;gap:6px;flex-wrap:wrap;background:#fff;border-bottom:1px solid var(--line);padding:10px 4vw}
nav button{border:1px solid var(--line);background:#fff;border-radius:6px;padding:8px 13px;cursor:pointer;font:inherit;font-size:14px;color:var(--ink)}
nav button[aria-selected=true]{background:var(--accent);color:#fff;border-color:var(--accent)}
main{max-width:1800px;margin:auto;padding:24px 4vw 60px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:22px;margin-bottom:18px}
section[hidden]{display:none}
h2{margin:0 0 8px;font-size:22px}
.desc{max-width:1100px;color:#475569}
.tools{display:flex;gap:9px;flex-wrap:wrap;align-items:center;margin:14px 0}
.tools a,.tools button{border:1px solid var(--line);background:#fff;border-radius:6px;padding:8px 13px;cursor:pointer;font:inherit;font-size:14px;text-decoration:none;color:var(--ink)}
.canvas{border:1px solid var(--line);border-radius:8px;overflow:auto;background:#fff;max-height:78vh}
.canvas svg{display:block}
pre.src{background:#0f172a;color:#e2e8f0;padding:16px;border-radius:8px;overflow:auto;font:13px/1.5 Consolas,monospace;max-height:60vh}
.legend{display:flex;gap:22px;flex-wrap:wrap;font-size:13px;margin-top:12px;color:#475569}
code{background:#f1f5f9;padding:2px 5px;border-radius:4px;font-size:13px}
.note{border-left:4px solid #d97706;background:#fffbeb;padding:11px 14px;margin:10px 0;border-radius:0 6px 6px 0;font-size:14px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:9px 11px;border-bottom:1px solid var(--line);vertical-align:top}
th{background:#f8fafc;position:sticky;top:0}
.scroll{max-height:60vh;overflow:auto}
.small{font-size:13px;color:var(--muted)}
input[type=search]{padding:9px 13px;border:1px solid #94a3b8;border-radius:6px;width:min(100%,380px);font:inherit}
.k{display:inline-block;padding:1px 7px;border-radius:10px;font-size:12px;font-weight:600}
.k-fk{background:#dbeafe;color:#1e40af}.k-bare{background:#fee2e2;color:#991b1b}
.k-embed{background:#fef3c7;color:#92400e}.k-poly{background:#ede9fe;color:#5b21b6}
.k-self{background:#d1fae5;color:#065f46}.k-join{background:#e2e8f0;color:#334155}
@media print{nav,.tools{display:none}section[hidden]{display:block}.canvas{overflow:visible;max-height:none}}
</style>
</head>
<body>
<header>
  <h1>Entity Relationship Diagram</h1>
  <p>CALIDRO RACS &mdash; all ${models.length} Mongoose models across one MongoDB database, split into ${DOMAINS.length} bounded contexts.
     Generated by <code>scripts/erd/build.js</code> from the live schemas. No database connection, no environment values read.</p>
  <div class="stats">
    <span><b>${models.length}</b> models</span>
    <span><b>${rels.length}</b> relationships</span>
    <span><b>${rels.filter((r) => r.kind === 'fk').length}</b> real refs</span>
    <span><b>${rels.filter((r) => r.kind === 'bare').length}</b> untyped</span>
    <span><b>${rels.filter((r) => r.kind === 'embed').length}</b> subdoc</span>
    <span><b>${rels.filter((r) => r.kind === 'poly').length}</b> polymorphic</span>
  </div>
  <p class="small" style="color:#94a3b8">Full written analysis, flow explanation and risk register: <a style="color:#93c5fd" href="ERD.md">ERD.md</a></p>
</header>

<nav id="tabs" role="tablist" aria-label="ERD domains">
  <button role="tab" data-view="overview" aria-selected="true">Overview</button>
${DOMAINS.map((d) => `  <button role="tab" data-view="${d.id}" aria-selected="false">${d.id} &middot; ${d.name}</button>`).join('\n')}
  <button role="tab" data-view="tables" aria-selected="false">Data tables</button>
</nav>

<main>
  <section role="tabpanel" id="overview">
    <h2>Cross-domain overview</h2>
    <p class="desc">Every entity and every relationship in one graph. Dense by nature &mdash; use the domain tabs to read anything specific.</p>
    <div class="tools">
      <button type="button" data-print>Print / save PDF</button>
      <label>Zoom <input class="zoom" aria-label="Zoom" type="range" min="40" max="200" value="100"></label>
    </div>
    <div class="canvas" data-graph="overview"></div>
    <pre class="src" data-source="overview" hidden></pre>
  </section>

${DOMAINS.map((d) => `  <section role="tabpanel" id="${d.id}" hidden>
    <h2>${d.id} &mdash; ${d.name}</h2>
    <p class="desc">${d.blurb}</p>
    <div class="tools">
      <a href="diagrams/erd-${d.id}.mmd" download>Download Mermaid source</a>
      <button type="button" data-print>Print / save PDF</button>
      <label>Zoom <input class="zoom" aria-label="Zoom" type="range" min="40" max="200" value="100"></label>
    </div>
    <div class="canvas" data-graph="${d.id}"></div>
    <pre class="src" data-source="${d.id}" hidden></pre>
    <p class="small">${models.filter((m) => DOMAIN_OF[m.modelName] === d.id).length} entities &middot; ${rels.filter((r) => DOMAIN_OF[r.child] === d.id).length} relationships originate here.</p>
  </section>`).join('\n')}

  <section role="tabpanel" id="tables" hidden>
    <h2>Relationship register</h2>
    <p class="desc">Every relationship with its cardinality, kind and the reason it matters. This is the same data as <code>erd-inventory.json</code>.</p>
    <div class="tools"><input type="search" id="relFilter" placeholder="Filter by model, field or note..." aria-label="Filter relationships"></div>
    <div class="scroll"><table id="relTable">
      <thead><tr><th>Child</th><th>Field</th><th>Parent</th><th>Card</th><th>Kind</th><th>Note</th></tr></thead>
      <tbody>${rels.map((r) => `<tr data-search="${cm(`${r.child} ${r.path} ${r.parent} ${r.note} ${r.kind}`.toLowerCase().replace(/"/g, "'"))}">
        <td><code>${r.child}</code></td><td><code>${r.path}</code></td><td><code>${r.parent}</code></td>
        <td>${r.card}</td><td><span class="k k-${r.kind}">${r.kind}</span></td><td>${r.note || ''}</td></tr>`).join('\n      ')}
      </tbody>
    </table></div>

    <h2 style="margin-top:26px">Entity register</h2>
    <div class="scroll"><table id="entTable">
      <thead><tr><th>Model</th><th>Domain</th><th>Collection</th><th>Fields</th><th>Indexes</th><th>Purpose</th></tr></thead>
      <tbody>${models.map((m) => `<tr>
        <td><code>${m.modelName}</code></td><td>${DOMAIN_OF[m.modelName]}</td><td><code>${m.collection.name}</code></td>
        <td>${fieldsOf.get(m.modelName).length}</td><td>${m.schema.indexes().length}</td>
        <td class="small">${PURPOSE[m.modelName]}</td></tr>`).join('\n      ')}
      </tbody>
    </table></div>

    <h2 style="margin-top:26px">Confirmed dangling references</h2>
    ${dangling.length ? dangling.map((d) => `<div class="note"><code>${d.child}.${d.path}</code> &rarr; <code>${d.parent}</code><br>${d.reason}</div>`).join('\n    ')
    : '<p class="small">None.</p>'}
  </section>
</main>

<script id="erd-data" type="application/json">${JSON.stringify(viewerData).replace(/</g, '\\u003c')}</script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>
(function () {
  var DATA = JSON.parse(document.getElementById('erd-data').textContent);
  var tabs = document.getElementById('tabs');
  var main = document.querySelector('main');
  var sections = [].slice.call(main.querySelectorAll(':scope > section'));
  var hasMermaid = typeof window.mermaid !== 'undefined';
  if (hasMermaid) window.mermaid.initialize({ startOnLoad: false, theme: 'neutral', er: { useMaxWidth: false } });

  function render(view) {
    var src = view === 'overview' ? DATA.overview : (DATA.domains.filter(function (d) { return d.id === view; })[0] || {}).source;
    if (!src) return;
    var pre = document.querySelector('[data-source="' + view + '"]');
    if (pre) pre.textContent = src;
    var host = document.querySelector('[data-graph="' + view + '"]');
    if (!host) return;
    if (!hasMermaid) { host.hidden = true; if (pre) pre.hidden = false; return; }
    var id = 'g_' + view;
    if (document.getElementById(id)) { document.getElementById(id).remove(); }
    window.mermaid.render(id, src).then(function (r) {
      host.innerHTML = r.svg;
    }).catch(function (e) {
      host.hidden = true;
      if (pre) { pre.hidden = false; pre.textContent = src + '\\n\\n/* render error: ' + e + ' */'; }
    });
  }

  var current = 'overview';
  function select(view) {
    current = view;
    sections.forEach(function (s) { s.hidden = s.id !== view; });
    [].slice.call(tabs.querySelectorAll('button')).forEach(function (b) {
      b.setAttribute('aria-selected', String(b.dataset.view === view));
    });
    render(view);
    var z = document.querySelector('section:not([hidden]) .zoom');
    if (z) applyZoom(z, host2(view), +z.value);
  }
  function host2(view) { return document.querySelector('[data-graph="' + view + '"]'); }
  function applyZoom(input, host, pct) { if (host) { var svg = host.querySelector('svg'); if (svg) svg.style.width = pct + '%'; } }

  tabs.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-view]');
    if (b) select(b.dataset.view);
  });

  main.addEventListener('input', function (e) {
    if (!e.target.classList.contains('zoom')) return;
    applyZoom(e.target, host2(current), +e.target.value);
  });

  function filter() {
    var q = document.getElementById('relFilter').value.trim().toLowerCase();
    [].slice.call(document.querySelectorAll('#relTable tbody tr')).forEach(function (tr) {
      tr.style.display = !q || tr.dataset.search.indexOf(q) !== -1 ? '' : 'none';
    });
  }
  document.addEventListener('input', function (e) { if (e.target.id === 'relFilter') filter(); });
  document.addEventListener('click', function (e) { if (e.target.hasAttribute('data-print')) window.print(); });

  select('overview');
})();
</script>
</body>
</html>
`;
fs.writeFileSync(path.join(outDir, 'index.html'), html);
written.push('index.html');

/* --------------------------------------------------------------- report --- */
console.log(JSON.stringify({
  models: models.length,
  relationships: rels.length,
  byKind: inventory.counts.byKind,
  diagrams: written.length,
  knownDanglingRefs: dangling.length,
  riskCount: problems.length,
}, null, 2));

if (dangling.length) {
  console.log('\nAccepted dangling references (confirmed source defects):');
  for (const d of dangling) console.log(`  - ${d.child}.${d.path} -> ${d.parent}: ${d.reason}`);
}

if (problems.length) {
  console.error('\nERD drift detected:\n' + problems.map((p) => '  - ' + p).join('\n'));
  process.exit(1);
}
