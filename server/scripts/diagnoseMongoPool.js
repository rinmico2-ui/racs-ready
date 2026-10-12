'use strict';

// Read-only: no app startup, model initialization, indexes, seeds or monitors.
const mongoose = require('mongoose');
const { buildMongoConnectionUri, disableRetryableWritesForDirectConnection } = require('../utils/mongoConnection');

function planStages(plan, stages = new Set()) {
  if (!plan || typeof plan !== 'object') return [...stages];
  if (plan.stage) stages.add(plan.stage);
  for (const value of Object.values(plan)) {
    if (value && typeof value === 'object') planStages(value, stages);
  }
  return [...stages];
}

async function diagnose({ env = process.env, output = console.log, summaryOnly = false } = {}) {
  const configured = buildMongoConnectionUri(String(env.MONGODB_URI || '').trim(), {
    directHosts:env.MONGODB_DIRECT_HOSTS, replicaSet:env.MONGODB_REPLICA_SET, authSource:env.MONGODB_AUTH_SOURCE,
  });
  if (!configured.uri) throw new Error('MONGODB_URI is required.');
  const connection = mongoose.createConnection(disableRetryableWritesForDirectConnection(configured.uri), {
    autoIndex:false, autoCreate:false, retryWrites:false, maxPoolSize:2, minPoolSize:1,
    serverSelectionTimeoutMS:8000, connectTimeoutMS:8000, socketTimeoutMS:12000, waitQueueTimeoutMS:4000,
  });
  const read = async (label, operation, summarize = value => value) => {
    const start=Date.now();
    try { const value=await operation(); output(JSON.stringify({check:label,elapsedMs:Date.now()-start,...summarize(value)})); }
    catch (error) { output(JSON.stringify({check:label,elapsedMs:Date.now()-start,error:error.codeName || error.name,code:error.code})); }
  };
  try {
    await connection.asPromise();
    const db=connection.db;
    await read('ping',()=>db.admin().command({ping:1}),()=>({ok:true}));
    if (summaryOnly) {
      const {dashboardBookingSummary,dateFilter}=require('../utils/dashboardBookingSummary');
      const startOfDay=new Date();startOfDay.setHours(0,0,0,0);
      const endOfDay=new Date(startOfDay);endOfDay.setHours(23,59,59,999);
      const collection=db.collection('bookingservices');
      const adapter={aggregate:pipeline=>({allowDiskUse(){return this;},option:options=>collection.aggregate(pipeline,{...options,allowDiskUse:true}).toArray()})};
      await read('compact dashboard booking summary',()=>dashboardBookingSummary(adapter,{startOfDay,endOfDay}));
      await read('original today count comparison',async()=>({totalBookingsToday:await collection.countDocuments(dateFilter(startOfDay,endOfDay),{maxTimeMS:8000})}));
      return;
    }
    await read('server connections',()=>db.admin().command({serverStatus:1,maxTimeMS:3000}),s=>({
      connections:s.connections, residentMB:s.mem?.resident,
    }));
    for (const name of ['bookingservices','notifications','dailykits','assignments']) {
      await read(name+' size',()=>db.command({collStats:name,maxTimeMS:3000}),s=>({
        count:s.count,averageDocumentBytes:s.avgObjSize,sizeMB:Math.round((s.size||0)/1048576),indexCount:s.nindexes,
      }));
      await read(name+' indexes',()=>db.collection(name).listIndexes({maxTimeMS:3000}).toArray(),rows=>({
        indexes:rows.map(row=>({key:row.key,name:row.name})),
      }));
    }
    const explain = async (name, cursor) => read(name,()=>cursor.explain('queryPlanner'),p=>({
      stages:planStages(p.queryPlanner?.winningPlan || p),
    }));
    await explain('booking status summary plan',db.collection('bookingservices').aggregate([
      {$group:{_id:'$status',count:{$sum:1}}},
    ],{maxTimeMS:3000}));
    await read('slow database operations',()=>connection.getClient().db('admin').aggregate([
      {$currentOp:{allUsers:true,localOps:true}},{$match:{active:true,secs_running:{$gte:2},
        'command.hello':{$exists:false},'command.ismaster':{$exists:false},'command.isMaster':{$exists:false}}},
      {$project:{_id:0,op:1,ns:1,secs_running:1,waitingForLock:1}},{$limit:10},
    ],{maxTimeMS:3000}).toArray(),operations=>({operations}));
  } finally { await connection.close(); }
}

if (require.main === module) {
  require('dotenv').config({quiet:true});
  diagnose({summaryOnly:process.argv.includes('--summary-only')}).catch(error=>{
    console.error(JSON.stringify({check:'connection',error:error.codeName || error.name,
      causes:[...(error.reason?.servers?.values() || [])].map(server=>({
        error:server.error?.name,code:server.error?.cause?.code || server.error?.code,
      })),
    }));process.exitCode=1;
  });
}
module.exports={diagnose,planStages};
