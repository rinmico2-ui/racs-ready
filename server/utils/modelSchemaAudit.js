'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');

// Schema/source inspection only. Never connects, reads documents, or builds indexes.
function auditModelSchemas() {
  const directory = path.resolve(__dirname, '../models');
  const files = fs.readdirSync(directory).filter(file => file.endsWith('.js')).sort();
  const hash = crypto.createHash('sha256'), models = [];
  function inspect(schema, prefix = '') {
    const fields = [];
    schema.eachPath((name, field) => {
      if (field.schema) fields.push(...inspect(field.schema, prefix + name + '.'));
      else fields.push({ path: prefix + name, type: field.instance, required: Boolean(field.isRequired),
        ...(field.enumValues?.length ? { allowed: field.enumValues } : {}),
        ...(field.options.ref ? { ref: String(field.options.ref) } : {}),
        ...(field.options.refPath ? { refPath: String(field.options.refPath) } : {}) });
    });
    return fields;
  }
  for (const file of files) {
    hash.update(file + '\n').update(fs.readFileSync(path.join(directory, file)));
    const Model = require(path.join(directory, file));
    if (Model.modelName && Model.schema) models.push({ model: Model.modelName, file: 'server/models/' + file,
      collection: Model.collection.name, fields: inspect(Model.schema), indexes: Model.schema.indexes() });
  }
  hash.update(JSON.stringify(models));
  return { filesScanned: files.length, modelsScanned: models.length,
    fieldsScanned: models.reduce((total, model) => total + model.fields.length, 0), fingerprint: hash.digest('hex'), models };
}
module.exports = { auditModelSchemas };
