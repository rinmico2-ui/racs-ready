const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const modelDir = path.resolve(__dirname, '..', '..', 'server', 'models');
for (const f of fs.readdirSync(modelDir).filter((f) => f.endsWith('.js')).sort()) require(path.join(modelDir, f));

function flat(schema, prefix = '', depth = 0, out = []) {
  if (depth > 2) return out;
  for (const [name, p] of Object.entries(schema.paths)) {
    const field = prefix + name;
    const ref = p.options?.ref || p.caster?.options?.ref || p.$embeddedSchemaType?.options?.ref;
    out.push(`${field} [${p.instance}${p.instance === 'Array' ? '<' + (p.caster?.instance || '?') + '>' : ''}]${ref ? ' -> ' + ref : ''}${p.options?.refPath ? ' refPath=' + p.options.refPath : ''}${p.options?.required ? ' REQ' : ''}${p.options?.unique ? ' UNIQ' : ''}`);
    if (p.schema) flat(p.schema, field + '.', depth + 1, out);
  }
  return out;
}

const only = process.argv.slice(2);
for (const m of Object.values(mongoose.models).sort((a, b) => a.modelName.localeCompare(b.modelName))) {
  if (only.length && !only.includes(m.modelName)) continue;
  console.log(`\n===== ${m.modelName} (${m.collection.name}) =====`);
  console.log(flat(m.schema).join('\n'));
}
