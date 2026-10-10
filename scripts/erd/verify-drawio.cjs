'use strict';
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const {load,relations}=require('./build-drawio.cjs');
const fs=require('node:fs');
const inventory=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../docs/erd/drawio/schema-inventory.json'),'utf8'));
const current=load();
for(const model of current) {
  const saved=inventory.entities.find(e=>e.name===model.name);
  if(!saved || JSON.stringify(saved.fields)!==JSON.stringify(model.fields) || JSON.stringify(saved.indexes)!==JSON.stringify(model.indexes))throw new Error(`Schema changed: ${model.name}. Run node scripts/erd/build-drawio.cjs.`);
}
if(current.length!==inventory.models)throw new Error('Model count changed. Rebuild the ERD.');
for(const relation of relations(current))if(!inventory.relationships.some(r=>r.id===relation.id))throw new Error('Missing current relationship: '+relation.id);
const result=spawnSync('python',[path.join(__dirname,'verify-drawio.py')],{encoding:'utf8',windowsHide:true});
if(result.error)throw result.error;
process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.status || 0;
