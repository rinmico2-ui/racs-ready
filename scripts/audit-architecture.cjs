/* Read-only code/schema audit. Does not load .env, connect to MongoDB, or start the app. */
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'docs', 'architecture');
fs.mkdirSync(out, { recursive: true });
const normalize = p => path.relative(root, p).split(path.sep).join('/');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return ['node_modules', 'vendor', 'uploads', 'images', 'fonts'].includes(e.name) ? [] : walk(p);
    return /\.(js|cjs|ejs|css)$/.test(e.name) ? [p] : [];
  });
}
const files = walk(path.join(root, 'server'));
const sources = files.map(p => ({ file: normalize(p), text: fs.readFileSync(p, 'utf8') }));
const modelDir = path.join(root, 'server', 'models');
const modelFiles = fs.readdirSync(modelDir).filter(f => f.endsWith('.js')).sort();
const nonModels = [];
for (const file of modelFiles) {
  const exported = require(path.join(modelDir, file));
  if (!exported?.schema) nonModels.push(file);
}
function fields(schema, prefix = '', seen = new Set()) {
  if (seen.has(schema)) return [];
  const branch = new Set([...seen, schema]);
  return Object.entries(schema.paths).flatMap(([name, p]) => {
    const field = prefix + name;
    const opts = p.options || {};
    const caster = p.caster || p.$embeddedSchemaType;
    const ref = opts.ref || caster?.options?.ref;
    const result = {
      path: field, type: p.instance,
      required: typeof opts.required === 'function' ? 'conditional' : Boolean(opts.required),
      ...(ref ? { ref: typeof ref === 'string' ? ref : 'dynamic' } : {}),
      ...(opts.refPath ? { refPath: opts.refPath } : {}),
      ...(opts.select === false ? { select: false } : {}),
      ...(p.enumValues?.length ? { enum: p.enumValues } : {}),
      ...(opts.min !== undefined ? { min: opts.min } : {}),
      ...(opts.max !== undefined ? { max: opts.max } : {}),
    };
    return [result, ...(p.schema ? fields(p.schema, field + '.', branch) : [])];
  });
}
const models = Object.values(mongoose.models).sort((a,b) => a.modelName.localeCompare(b.modelName)).map(m => {
  const file = `server/models/${m.modelName}.js`;
  const f = fields(m.schema);
  return {
    name: m.modelName, file, collection: m.collection.name,
    timestamps: m.schema.options.timestamps || false,
    optimisticConcurrency: m.schema.options.optimisticConcurrency || false,
    fields: f, indexes: m.schema.indexes(),
    methods: Object.keys(m.schema.methods), statics: Object.keys(m.schema.statics),
    references: f.filter(x => x.ref || x.refPath),
    consumers: sources.filter(s => s.file !== file && new RegExp(`(?:models/|mongoose\\.model\\(["'])${m.modelName}(?:["']|\\b)`).test(s.text)).map(s=>s.file),
  };
});
const names = new Set(models.map(m=>m.name));
const unresolvedReferences = models.flatMap(m => m.references.filter(f => f.ref && f.ref !== 'dynamic' && !names.has(f.ref)).map(f=>({model:m.name,path:f.path,ref:f.ref})));
const routes = sources.filter(s=>s.file.startsWith('server/routes/')).map(s=>({
  file:s.file,
  declarations: [...s.text.matchAll(/\b(\w+)\.(get|post|put|patch|delete|use)\(\s*(["'`])([^"'`]+)\3/g)].filter(m => /router/i.test(m[1]) || m[1] === 'app').map(m=>({router:m[1],method:m[2].toUpperCase(),path:m[4],line:s.text.slice(0,m.index).split('\n').length})),
  modelImports:[...s.text.matchAll(/require\(["']\.\.\/models\/([^"']+)["']\)/g)].map(m=>m[1]),
}));
const indexSource = sources.find(s=>s.file==='server/index.js').text;
const directRouteImports = [...indexSource.matchAll(/require\(["']\.\/routes\/([^"']+)["']\)/g)].map(m=>m[1]);
const sourceMap = new Map(sources.map(s=>[s.file,s.text]));
const reachable = new Set();
function visit(file) {
  if (reachable.has(file) || !sourceMap.has(file)) return;
  reachable.add(file);
  for (const match of sourceMap.get(file).matchAll(/require\(["'](\.[^"']+)["']\)/g)) {
    const target = normalize(path.resolve(root,path.dirname(file),match[1]));
    visit(target.endsWith('.js') ? target : target+'.js');
  }
}
visit('server/index.js');
for (const route of routes) route.lexicallyReachableFromEntry = reachable.has(route.file);
const envKeys = [...new Set(sources.flatMap(s=>[...s.text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map(m=>m[1])))].sort();
const audit = {
  auditedOn:'2026-10-09', scope:'Repository source and compiled Mongoose schemas; no live database or external calls. Consumers and route declarations are lexical references, not proof of reachability.',
  counts:{sourceFiles:files.length,modelFiles:modelFiles.length,mongooseModels:models.length,routeFiles:routes.length,routeDeclarations:routes.reduce((n,r)=>n+r.declarations.length,0),middlewareFiles:sources.filter(s=>s.file.startsWith('server/middleware/')).length,utilityFiles:sources.filter(s=>s.file.startsWith('server/utils/')).length,testFiles:sources.filter(s=>s.file.startsWith('server/tests/')&&s.file.endsWith('.test.js')).length,ejsTemplates:sources.filter(s=>s.file.endsWith('.ejs')).length},
  nonModelFiles:nonModels, unresolvedReferences,directRouteImports,models,routes,envKeys,
  entryReachableFiles:[...reachable].sort(),
  files: sources.map(s=>({file:s.file,lines:s.text.split('\n').length})),
};
fs.writeFileSync(path.join(out,'audit-inventory.json'), JSON.stringify(audit,null,2)+'\n');
const md = ['# Model audit inventory', '', 'Generated by `node scripts/audit-architecture.cjs`. No database connection or environment values are read.', '',
  `Audited ${models.length} compiled Mongoose models from ${modelFiles.length} model-directory JavaScript files. \`BookingStatus.js\` exports constants, not a collection. Collection names below come from Mongoose; a live database may have different indexes or historical collections.`, '',
  '| Model | Collection | Fields including nested paths | Index declarations | Time tracking | References |', '| --- | --- | ---: | ---: | --- | --- |',
  ...models.map(m=>`| [${m.name}](../../${m.file}) | ${m.collection} | ${m.fields.length} | ${m.indexes.length} | ${m.timestamps ? 'timestamps' : m.fields.filter(f=>/^(createdAt|updatedAt|submittedAt|purchaseDate|date|timestamp)$/.test(f.path)).map(f=>f.path).join(', ') || 'domain dates / inspect schema'} | ${[...new Set(m.references.map(f=>f.ref || 'refPath:'+f.refPath))].join(', ') || '—'} |`), '',
  '## Unresolved schema reference targets', '', ...unresolvedReferences.map(r=>`- \`${r.model}.${r.path}\` references \`${r.ref}\`, which is not registered by the model directory.`), '',
  '## Detailed schemas', '', ...models.flatMap(m=>[
    `### ${m.name}`, '', `Source: [${m.file}](../../${m.file}). Optimistic concurrency: \`${m.optimisticConcurrency}\`.`, '',
    `Consumers (${m.consumers.length}; lexical matches): ${m.consumers.map(f=>'`'+f+'`').join(', ') || 'none found'}.`, '',
    '| Path | Type | Required | Reference | Constraints |', '| --- | --- | --- | --- | --- |',
    ...m.fields.map(f=>`| ${f.path} | ${f.type} | ${f.required} | ${f.ref || f.refPath || '—'} | ${[f.select===false?'hidden by default':'',f.enum?'enum: '+f.enum.join(', '):'',f.min!==undefined?'min: '+f.min:'',f.max!==undefined?'max: '+f.max:''].filter(Boolean).join('; ') || '—'} |`), '',
    'Indexes:', '', '```json', JSON.stringify(m.indexes,null,2), '```', '',
  ]),
 ];
fs.writeFileSync(path.join(out,'MODEL_AUDIT.md'),md.join('\n')+'\n');
console.log(JSON.stringify({counts:audit.counts, nonModelFiles:nonModels, unresolvedReferences, lowUseModels:models.filter(m=>!m.consumers.some(f=>!f.includes('/scripts/')&&!f.includes('/tests/'))).map(m=>m.name)},null,2));
