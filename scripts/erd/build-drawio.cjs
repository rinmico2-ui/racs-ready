'use strict';
// Native, editable draw.io ERD, derived from current schemas without a DB or .env.
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const { DOMAINS, DOMAIN_OF, PURPOSE } = require('./meta.domains');
const { SHOW } = require('./meta.fields');
const { RELATIONS } = require('./meta.relations');
const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'docs/erd/drawio');
const COLORS = ['#2563eb','#0891b2','#059669','#d97706','#7c3aed','#0284c7','#16a34a','#db2777','#4f46e5','#475569'];
const TITLE = { D1:'Accounts & access',D2:'Services & aircon catalog',D3:'Bookings & technician work',D4:'Stock, tools & daily kits',D5:'Large installation projects',D6:'Aircon orders & sales',D7:'Payments & staff pay',D8:'Maintenance, returns & ratings',D9:'Attendance & leave',D10:'Settings, logs & file storage' };
const xmlEscape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const safe = value => String(value).replace(/[^a-zA-Z0-9_-]/g,'_');
const color = domain => COLORS[Math.max(0,DOMAINS.findIndex(d=>d.id===domain))];
const elem = p => p.embeddedSchemaType || p.$embeddedSchemaType || p.caster;

function flatten(schema, prefix='', arrays=[], optional=false, ancestors=new Set()) {
  if(ancestors.has(schema))return [];
  const seen = new Set([...ancestors,schema]), fields=[];
  for(const [name,p] of Object.entries(schema.paths)) {
    const field=prefix+name, element=elem(p), options=p.options || {};
    const required=typeof options.required==='function'?'conditional':!!options.required;
    const ref=options.ref || element?.options?.ref;
    const nextArrays=p.instance==='Array'?[...arrays,field]:arrays;
    fields.push({path:field,type:p.instance==='Array'?`${element?.instance || (p.schema?'Embedded':'Mixed')}[]`:p.instance,
      required, optionalAncestor:optional, arrays:nextArrays, container:!!p.schema, ref:typeof ref==='string'?ref:ref?'<function>':null,
      refPath:options.refPath || element?.options?.refPath || null, unique:!!options.unique,
      enum:p.enumValues?.length?[...p.enumValues]:element?.enumValues?.length?[...element.enumValues]:null});
    if(p.schema)fields.push(...flatten(p.schema,field+'.',nextArrays,optional || !required,seen));
  }
  return fields;
}

function load() {
  const dir=path.join(ROOT,'server/models');
  for(const file of fs.readdirSync(dir).filter(f=>f.endsWith('.js')).sort())require(path.join(dir,file));
  return Object.values(mongoose.models).sort((a,b)=>a.modelName.localeCompare(b.modelName)).map(model=>({
    name:model.modelName, collection:model.collection.name, domain:DOMAIN_OF[model.modelName], purpose:PURPOSE[model.modelName] || model.modelName,
    fields:flatten(model.schema), indexes:model.schema.indexes().map(([keys,options])=>({keys,options})), source:`server/models/${model.modelName}.js`,
  }));
}

function relations(entities) {
  const known=new Set(entities.map(e=>e.name)), links=[];
  const alternatives={
    'Rating.targetId':{field:'targetType',map:{inventory:'Inventory',technician:'Technician',booking:'BookingService',order:'Order'}},
    'Notification.referenceId':{field:'referenceModel'},
    'ActivityLog.entityId':{field:'entityType',values:['BookingService','Order','WalkInSale','Payment','Assignment','Project','Expense','Technician','User']},
    'BookingService.services.serviceId':{field:'services.type',map:{core:'CoreService',repair:'RepairService'}},
  };
  for(const entity of entities)for(const field of entity.fields) {
    const key=`${entity.name}.${field.path}`,annotation=RELATIONS[key];
    let targets=[],kind='ref',evidence='schema ref',discriminator=null;
    if(field.refPath) {
      discriminator=field.refPath;
      targets=entity.fields.find(f=>f.path===field.refPath)?.enum || [];
      kind='polymorphic';evidence='schema refPath';
    } else if(field.ref) targets=[field.ref];
    else if(alternatives[key]) {
      const alt=alternatives[key];discriminator=alt.field;
      targets=alt.map?Object.values(alt.map):alt.values || entity.fields.find(f=>f.path===alt.field)?.enum || [];
      kind='logical';evidence='application discriminator; no schema ref';
    } else if(annotation) {
      targets=[annotation.parent];kind=annotation.kind==='embed'?'embedded':annotation.kind==='join'?'join':'logical';evidence='existing reviewed relationship annotation';
    }
    const unique=entity.indexes.some(index=>index.options.unique && Object.keys(index.keys).length===1 && index.keys[field.path]===1);
    const parentCard=field.arrays.length?'0..*':field.required===true&&!field.optionalAncestor?'1':'0..1';
    const childCard=unique&&!field.arrays.length?'0..1':'0..*';
    for(const parent of new Set(targets.filter(Boolean)))links.push({id:`${key}->${parent}`,child:entity.name,parent,path:field.path,kind,
      parentCard,childCard,unique,discriminator,evidence,missingTarget:!known.has(parent),
      note:kind==='join'?'String key; not an ObjectId foreign key.':kind==='embedded'?'Points to an embedded item ID inside the target collection.':annotation?.note || '',
    });
  }
  return links;
}

function storage(entities,links) {
  const field=(name,type,required=false)=>({path:name,type,required,arrays:[],container:false,ref:null,refPath:null,enum:null});
  const files=[field('_id','ObjectId',true),field('length','Number',true),field('chunkSize','Number',true),field('uploadDate','Date',true),field('filename','String'),field('contentType','String'),field('metadata','Mixed')];
  const chunks=[field('_id','ObjectId',true),field('files_id','ObjectId',true),field('n','Number',true),field('data','Binary',true)];
  const extra=[
    {name:'SessionStore',collection:'sessions',fields:[field('_id','String',true),field('expires','Date'),field('session','String')],purpose:'Express login sessions stored by connect-mongo. Separate from AuthSession.',source:'server/index.js; connect-mongo default collection'},
    ...['paymentProofs','completionProofs'].flatMap(bucket=>[
      {name:bucket+'Files',collection:bucket+'.files',fields:files,purpose:'GridFS file metadata for '+(bucket==='paymentProofs'?'payment receipts.':'job completion proof photos.'),source:`server/utils/${bucket==='paymentProofs'?'paymentProofStorage':'completionProofStorage'}.js`},
      {name:bucket+'Chunks',collection:bucket+'.chunks',fields:chunks,purpose:'GridFS binary chunks; files_id points to the file metadata.',source:'MongoDB GridFS storage format'},
    ]),
  ];
  extra.forEach(e=>Object.assign(e,{domain:'D10',indexes:[],infrastructure:true}));
  for(const bucket of ['paymentProofs','completionProofs'])links.push({id:`${bucket}.chunks.files_id`,child:bucket+'Chunks',parent:bucket+'Files',path:'files_id',kind:'storage',parentCard:'1',childCard:'0..*',evidence:'GridFS files/chunks contract'});
  for(const entity of entities)for(const f of entity.fields) {
    if(f.path==='gcashProofFileId'||f.path==='paymentProofFileId')links.push({id:`${entity.name}.${f.path}->paymentProofsFiles`,child:entity.name,parent:'paymentProofsFiles',path:f.path,kind:'storage',parentCard:'0..1',childCard:'0..*',evidence:'paymentProofStorage file ID'});
    if(/completionProof.*fileId$/i.test(f.path))links.push({id:`${entity.name}.${f.path}->completionProofsFiles`,child:entity.name,parent:'completionProofsFiles',path:f.path,kind:'storage',parentCard:f.arrays.length?'0..*':'0..1',childCard:'0..*',evidence:'completionProofStorage file ID'});
  }
  return extra;
}

class Page {
  constructor(id,name,title,subtitle,width=2400,height=1800) {
    this.id=id;this.name=name;this.width=width;this.height=height;this.cells=[];this.nodes=[];this.edges=[];this.seq=0;
    this.text(title,48,30,width-96,42,28,'#0f172a',true);
    this.text(subtitle,48,82,width-96,44,13,'#64748b');
  }
  cell(value,style,x,y,w,h,extra={}) {
    const id=extra.id || `${this.id}-c${++this.seq}`;
    const metadata={...extra};delete metadata.id;
    const attrs=object=>Object.entries(object).map(([k,v])=>`${k}="${xmlEscape(v)}"`).join(' ');
    const wrapped=Object.keys(metadata).length>0;
    const attributes=attrs({...(wrapped?{}:{id,value}),style,vertex:'1',parent:this.parentGroup?.id || '1'});
    const cell=`<mxCell ${attributes}><mxGeometry x="${x-(this.parentGroup?.x || 0)}" y="${y-(this.parentGroup?.y || 0)}" width="${w}" height="${h}" as="geometry"/></mxCell>`;
    this.cells.push(wrapped?`<object ${attrs({id,label:value,...metadata})}>${cell}</object>`:cell);
    return id;
  }
  text(value,x,y,w,h,size=13,fill='#334155',bold=false,extra={}) {
    return this.cell(value,`text;html=0;whiteSpace=wrap;align=left;verticalAlign=middle;spacing=0;fontSize=${size};fontColor=${fill};fontFamily=Arial;fontStyle=${bold?1:0};`,x,y,w,h,extra);
  }
  card(entity,x,y,w,fields,context=false,idSuffix='') {
    const h=84+fields.length*24, node={id:`${this.id}-entity-${safe(entity.name+idSuffix)}`,name:entity.name,x,y,w,h,context};
    const c=context?'#94a3b8':color(entity.domain);
    this.cell('',`rounded=1;arcSize=6;fillColor=#ffffff;strokeColor=${c};strokeWidth=1.5;container=1;collapsible=0;`,x,y,w,h,{id:node.id});
    this.parentGroup=node;
    this.cell('',`rounded=0;fillColor=${context?'#f1f5f9':c};strokeColor=none;`,x,y,w,52);
    this.text(entity.name,x+12,y+5,w-24,24,16,context?'#475569':'#ffffff',true,entity.collection==='UNREGISTERED TARGET'?{}:{link:`data:page/id,fields-${safe(entity.name)}`});
    this.text(entity.collection,x+12,y+29,w-24,18,11,context?'#64748b':'#e2e8f0');
    this.text(context?'Linked collection — open its full field page':'PK = document ID    FK = stored reference',x+12,y+57,w-24,18,10,'#64748b');
    fields.forEach((f,index)=>{
      const linked=f.ref || f.refPath || RELATIONS[`${entity.name}.${f.path}`];
      const flag=f.path==='_id'?'PK':linked?'FK':f.unique?'UK':f.container?'[]':'';
      this.text(`${flag.padEnd(3)} ${f.path}`,x+12,y+80+index*24,w-130,23,11,linked?'#1d4ed8':'#334155',false,{fieldPath:f.path,entityName:entity.name});
      this.text(f.type,x+w-112,y+80+index*24,100,23,10,'#64748b');
    });
    this.parentGroup=null;
    this.nodes.push(node);return node;
  }
  edge(source,target,rs,label=null) {
    const id=`${this.id}-e${++this.seq}`,mixed=rs.some(r=>!['ref','polymorphic'].includes(r.kind));
    const single=rs.length===1;
    const marker=card=>card==='1'?'ERmandOne':card==='0..1'?'ERone':'ERzeroToMany';
    // Connections run from the referenced collection (parent) to the document storing the key (child).
    const parentCard=rs.every(r=>r.parentCard===rs[0].parentCard)?rs[0].parentCard:'0..*';
    const childCard=rs.every(r=>r.childCard===rs[0].childCard)?rs[0].childCard:'0..*';
    const route=this.router?.route(source,target);
    const style=`edgeStyle=${route?'none':'orthogonalEdgeStyle'};rounded=0;html=0;startArrow=${marker(parentCard)};endArrow=${marker(childCard)};startFill=0;endFill=0;strokeWidth=1.3;strokeColor=${mixed?'#d97706':'#94a3b8'};dashed=${mixed?1:0};fontSize=10;fontColor=#475569;labelBackgroundColor=#ffffff;${route?`exitX=${route.exitX};exitY=${route.exitY};entryX=${route.entryX};entryY=${route.entryY};exitPerimeter=0;entryPerimeter=0;`:''}`;
    const value=label || (single?rs[0].path:`${rs.length} reference fields`);
    const attrs=object=>Object.entries(object).map(([k,v])=>`${k}="${xmlEscape(v)}"`).join(' ');
    const metadata={id,label:value,relationshipIds:rs.map(r=>r.id).join('|'),tooltip:rs.map(r=>`${r.path}: ${r.parentCard} ${r.parent} / ${r.childCard} ${r.child} (${r.kind})`).join('\n')};
    const points=route?`<Array as="points">${route.points.map(p=>`<mxPoint x="${p.x}" y="${p.y}"/>`).join('')}</Array>`:'';
    this.cells.push(`<object ${attrs(metadata)}><mxCell ${attrs({style,edge:1,parent:1,source:source.id,target:target.id})}><mxGeometry relative="1" as="geometry">${points}</mxGeometry></mxCell></object>`);
    this.edges.push({id,source:source.id,target:target.id,relationships:rs.map(r=>r.id)});
  }
  output() {
    return `<diagram id="${this.id}" name="${xmlEscape(this.name)}"><mxGraphModel dx="1400" dy="900" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" pageWidth="${this.width}" pageHeight="${this.height}" math="0" shadow="0" background="#ffffff"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${this.cells.join('\n')}</root></mxGraphModel></diagram>`;
  }
}

function summaryFields(entity) {
  const curated=(SHOW[entity.name] || []).map(name=>name.replace(/^\+/,''));
  const selected=curated.map(name=>entity.fields.find(f=>f.path===name)).filter(Boolean);
  const pk=entity.fields.find(f=>f.path==='_id');
  if(pk&&!selected.includes(pk))selected.unshift(pk);
  // Show the keys and normal business fields; full nested fields are on each entity page.
  for(const name of curated)if(!selected.some(f=>f.path===name)&&entity.fields.some(f=>f.path.startsWith(name+'.')))selected.push({path:name,type:'Embedded',container:true});
  return selected.slice(0,14);
}

// Orthogonal visibility-grid routing keeps connectors outside all entity cards.
// Native draw.io waypoints remain editable after importing the file.
class Router {
  constructor(nodes,width,height) {
    this.nodes=nodes;this.width=width;this.height=height;this.usage=new Map();this.portCounts=new Map();
  }
  route(source,target) {
    const port=(node,side)=>{
      const key=node.id+side,count=this.portCounts.get(key)||0;this.portCounts.set(key,count+1);
      const fraction=.2+(count%7)*.1;
      return {x:node.x+(side==='right'?node.w:0),y:Math.round(node.y+node.h*fraction),fraction};
    };
    const sourceSide=source.x<target.x?'right':'left',targetSide=source.x<target.x?'left':'right';
    const a=port(source,sourceSide),b=port(target,targetSide);
    if(source===target){
      const x=source.x-38-(this.portCounts.get(source.id+'left')||0)*8;
      return {exitX:0,exitY:a.fraction,entryX:0,entryY:b.fraction,points:[{x,y:a.y},{x,y:b.y}]};
    }
    const start={x:a.x+(sourceSide==='right'?24:-24),y:a.y},end={x:b.x+(targetSide==='right'?24:-24),y:b.y};
    const xs=[...new Set([16,this.width-16,start.x,end.x,...this.nodes.flatMap(n=>[n.x-24,n.x+n.w+24])])].sort((a,b)=>a-b);
    const ys=[...new Set([140,this.height-30,start.y,end.y,...this.nodes.flatMap(n=>[n.y-24,n.y+n.h+24])])].sort((a,b)=>a-b);
    const xIndex=new Map(xs.map((x,i)=>[x,i])),yIndex=new Map(ys.map((y,i)=>[y,i]));
    const index=(x,y)=>y*xs.length+x;
    const startIndex=index(xIndex.get(start.x),yIndex.get(start.y)),endIndex=index(xIndex.get(end.x),yIndex.get(end.y));
    const blocked=new Map();
    const clear=(x1,y1,x2,y2)=>!this.nodes.some(n=>x1===x2
      ?x1>n.x-8&&x1<n.x+n.w+8&&Math.max(y1,y2)>n.y-8&&Math.min(y1,y2)<n.y+n.h+8
      :y1>n.y-8&&y1<n.y+n.h+8&&Math.max(x1,x2)>n.x-8&&Math.min(x1,x2)<n.x+n.w+8);
    const heap=[];
    const push=value=>{heap.push(value);let i=heap.length-1;while(i){const p=(i-1)>>1;if(heap[p].score<=value.score)break;heap[i]=heap[p];i=p;}heap[i]=value;};
    const pop=()=>{const first=heap[0],last=heap.pop();if(heap.length){let i=0;while(i*2+1<heap.length){let child=i*2+1;if(child+1<heap.length&&heap[child+1].score<heap[child].score)child++;if(heap[child].score>=last.score)break;heap[i]=heap[child];i=child;}heap[i]=last;}return first;};
    const distances=new Map([[startIndex,0]]),previous=new Map();
    const heuristic=i=>Math.abs(xs[i%xs.length]-end.x)+Math.abs(ys[Math.floor(i/xs.length)]-end.y);
    push({index:startIndex,score:heuristic(startIndex),cost:0});
    while(heap.length){
      const item=pop();if(item.cost!==distances.get(item.index))continue;if(item.index===endIndex)break;
      const xi=item.index%xs.length,yi=Math.floor(item.index/xs.length);
      for(const [nx,ny] of [[xi-1,yi],[xi+1,yi],[xi,yi-1],[xi,yi+1]]){
        if(nx<0||ny<0||nx>=xs.length||ny>=ys.length)continue;
        const next=index(nx,ny),key=[Math.min(next,item.index),Math.max(next,item.index)].join(':');
        if(!blocked.has(key))blocked.set(key,!clear(xs[xi],ys[yi],xs[nx],ys[ny]));
        if(blocked.get(key))continue;
        const segment=`${xs[xi]},${ys[yi]}:${xs[nx]},${ys[ny]}`;
        const nextCost=item.cost+Math.abs(xs[nx]-xs[xi])+Math.abs(ys[ny]-ys[yi])+(this.usage.get(segment)||0)*55;
        if(nextCost>=(distances.get(next)??Infinity))continue;
        distances.set(next,nextCost);previous.set(next,item.index);push({index:next,cost:nextCost,score:nextCost+heuristic(next)});
      }
    }
    if(!distances.has(endIndex))throw new Error(`No safe connector route: ${source.name} → ${target.name}`);
    const points=[];let current=endIndex;
    while(current!==undefined){points.push({x:xs[current%xs.length],y:ys[Math.floor(current/xs.length)]});current=previous.get(current);}
    points.reverse();
    for(let i=1;i<points.length;i++){
      const key=`${points[i-1].x},${points[i-1].y}:${points[i].x},${points[i].y}`;this.usage.set(key,(this.usage.get(key)||0)+1);
    }
    const compact=points.filter((point,i)=>!i||i===points.length-1||!((points[i-1].x===point.x&&points[i+1].x===point.x)||(points[i-1].y===point.y&&points[i+1].y===point.y)));
    return {exitX:sourceSide==='right'?1:0,exitY:a.fraction,entryX:targetSide==='right'?1:0,entryY:b.fraction,points:compact};
  }
}

function domainPage(domain,entities,links,wholeSystem=false) {
  const owned=wholeSystem?[...entities].sort((a,b)=>a.domain.localeCompare(b.domain)||a.name.localeCompare(b.name)):entities.filter(e=>e.domain===domain.id),ownedNames=new Set(owned.map(e=>e.name));
  const ownLinks=links.filter(r=>ownedNames.has(r.child));
  const external=[...new Set(ownLinks.map(r=>r.parent).filter(name=>!ownedNames.has(name)))].sort();
  const all=[...owned,...external.map(name=>entities.find(e=>e.name===name)||{name,collection:'UNREGISTERED TARGET',domain:domain.id,fields:[{path:'_id',type:'Unknown'}]})];
  const colCount=wholeSystem?8:4,width=colCount*650+96,rows=Math.ceil(all.length/colCount);
  const title=wholeSystem?'Full system · Entity relationship diagram':TITLE[domain.id];
  const page=new Page(domain.id,wholeSystem?'02 Full system ERD':`${String(Number(domain.id.slice(1))+2).padStart(2,'0')} ${TITLE[domain.id]}`,title,`${owned.length} collections · ${ownLinks.length} reference targets · blue/solid: declared references · amber/dashed: application or file links. Open a collection name for all fields.`,width,rows*610+220);
  const positions=new Map();let nextY=160;
  for(const section of [owned,all.slice(owned.length)]) {
    for(let start=0;start<section.length;start+=colCount){
      const row=section.slice(start,start+colCount);let tallest=0;
      row.forEach((e,i)=>{
        const isContext=!ownedNames.has(e.name);
        const node=page.card(e,48+i*650,nextY,460,isContext?e.fields.filter(f=>f.path==='_id').slice(0,1):wholeSystem?summaryFields(e).slice(0,7):summaryFields(e),isContext);
        positions.set(e.name,node);tallest=Math.max(tallest,node.h);
      });
      nextY+=tallest+100;
    }
  }
  page.height=nextY+80;
  page.router=new Router(page.nodes,width,page.height);
  // Bundling avoids dozens of duplicate lines between identity / audit hubs. Every field remains in the edge's tooltip and detail page.
  const groups=new Map();
  for(const r of ownLinks) {
    const key=[r.child,r.parent,r.parentCard,r.childCard,['ref','polymorphic'].includes(r.kind)?'declared':'logical'].join('|');
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);
  }
  for(const rs of groups.values())page.edge(positions.get(rs[0].parent),positions.get(rs[0].child),rs);
  return page;
}

function dictionaryPage(entity,links) {
  const chunks=[];for(let i=0;i<entity.fields.length;i+=46)chunks.push(entity.fields.slice(i,i+46));
  const cols=Math.min(3,chunks.length),width=Math.max(1800,cols*930+96),fieldRows=Math.ceil(chunks.length/cols);
  const outgoing=links.filter(r=>r.child===entity.name),incoming=links.filter(r=>r.parent===entity.name);
  const sectionY=fieldRows*1260+190;
  const page=new Page(`fields-${safe(entity.name)}`,`Fields · ${entity.name}`,entity.name,`${entity.collection} · ${entity.fields.length} schema paths · ${outgoing.length} outgoing links · ${incoming.length} incoming links · ${entity.source}`,width,sectionY+Math.max(outgoing.length,entity.indexes.length,10)*32+250);
  page.text('Back to area diagram',48,128,270,24,12,color(entity.domain),true,{link:`data:page/id,${entity.domain}`});
  chunks.forEach((fields,i)=>{
    const x=48+(i%cols)*930,y=180+Math.floor(i/cols)*1260;
    const header=page.cell('',`rounded=1;fillColor=#ffffff;strokeColor=#cbd5e1;`,x,y,880,72+fields.length*25);
    page.text(`Fields ${i*46+1}–${i*46+fields.length}`,x+14,y+10,800,24,16,color(entity.domain),true);
    page.text('Name / path                                                    Type                    Rules',x+14,y+40,850,22,11,'#64748b');
    fields.forEach((f,index)=>{
      const fy=y+69+index*25,key=f.path==='_id'?'PK ':outgoing.some(r=>r.path===f.path)?'FK ':'';
      page.text(key+f.path,x+14,fy,530,24,11,'#334155',false,{fieldPath:f.path,entityName:entity.name});
      page.text(f.type,x+560,fy,120,24,10,'#64748b');
      page.text([f.required===true?'required':f.required==='conditional'?'conditional':'optional',f.unique?'unique':'',f.enum?'enum':'',f.container?'embedded':''].filter(Boolean).join(' · '),x+685,fy,180,24,10,'#64748b',false,{tooltip:f.enum?f.enum.join(', '):''});
    });
  });
  page.text('Relationships — field in this collection → referenced collection',48,sectionY,width-96,35,19,'#0f172a',true);
  outgoing.forEach((r,i)=>page.text(`${r.path} → ${r.parent}   [${r.parentCard} target(s) / ${r.childCard} source document(s)]   ${r.kind}${r.missingTarget?' · UNREGISTERED TARGET':''}`,48,sectionY+45+i*32,width-96,30,12,r.missingTarget?'#b91c1c':r.kind==='ref'?'#334155':'#b45309',false,{relationshipId:r.id,tooltip:r.evidence+(r.discriminator?' · '+r.discriminator:'')}));
  const indexY=sectionY+65+outgoing.length*32;
  page.text('Indexes — compound unique keys do not make individual fields unique',48,indexY,width-96,34,19,'#0f172a',true);
  entity.indexes.forEach((index,i)=>page.text(`${JSON.stringify(index.keys)}  ${index.options.unique?'UNIQUE ':''}${index.options.sparse?'SPARSE ':''}${index.options.partialFilterExpression?'PARTIAL '+JSON.stringify(index.options.partialFilterExpression):''}${index.options.expireAfterSeconds!==undefined?'TTL '+index.options.expireAfterSeconds+'s':''}`,48,indexY+45+i*30,width-96,28,12,'#475569'));
  page.height=Math.max(page.height,indexY+70+entity.indexes.length*30);
  return page;
}

function guide(entities,links) {
  const page=new Page('guide','00 Read me','CALIDRO RACS · Complete system ERD',`${entities.filter(e=>!e.infrastructure).length} Mongoose models + ${entities.filter(e=>e.infrastructure).length} storage collections · ${links.length} reference targets · generated from current source · 10 October 2026, Asia/Manila`,1700,1450);
  const paragraphs=[
    ['Open and edit','Open this .drawio file at app.diagrams.net → File → Open From → Device. Every table, field and connector is editable.'],
    ['Find your area','Page 02 is the full system ERD. Pages 03–12 show bookings, orders, tools, projects, finance and the other areas. Click a collection name to jump to its complete field page.'],
    ['All fields are included','The Fields pages include every stored schema path, embedded object / array, enum (in tooltips), index and outgoing reference. Embedded records stay inside their MongoDB collection.'],
    ['Keys and connections','PK = document ID. FK = stored or application reference. UK = unique field. Blue / solid links are declared references; amber / dashed links are logical, embedded-item or storage links.'],
    ['Read the ends','Each connector starts at the referenced collection and ends at the document storing the key. 1 = exactly one; 0..1 = optional one; 0..* = optional many. Multiple fields with matching cardinalities share a connector; its tooltip lists each field.'],
    ['Actual constraints','Optional fields remain optional. Required fields inside optional objects are conditional. Only a single-field unique index limits documents to 0..1. A unique (technician, date) index still allows many attendance records per technician. MongoDB refs are not enforced SQL foreign keys.'],
    ['Known missing targets','Purchase refers to Product, which has no registered model. A dynamic System / Review target can also be unregistered. These targets are labelled, not invented as real collections.'],
    ['Files and login sessions','The final area includes paymentProofs.files/chunks, completionProofs.files/chunks and the connect-mongo session store. These are infrastructure collections outside the Mongoose model list. File IDs and session contents are not ordinary business foreign keys.'],
    ['Scope','This documents the current application structure. It contains schema names and types only; no customer records, credentials or database connection are needed. Domain overview cards show key fields; full field pages retain the rest.'],
  ];
  paragraphs.forEach(([title,body],i)=>{
    page.text(title,48,160+i*116,310,32,17,'#0f172a',true);
    page.text(body,370,160+i*116,1260,80,15,'#475569');
  });
  return page;
}

function overview(entities,links) {
  const page=new Page('overview','01 All collections','The whole system · Collection map','All collections, grouped by area. Use the area pages for complete reference diagrams and the Fields pages for every stored path.',2200,1600);
  DOMAINS.forEach((d,i)=>{
    const x=48+(i%4)*530,y=170+Math.floor(i/4)*450;
    const members=entities.filter(e=>e.domain===d.id);
    page.cell('',`rounded=1;arcSize=6;fillColor=#ffffff;strokeColor=${color(d.id)};strokeWidth=1.5;`,x,y,490,400);
    page.text(TITLE[d.id],x+18,y+15,450,34,20,color(d.id),true,{link:`data:page/id,${d.id}`});
    page.text(`${members.length} collections · ${links.filter(r=>members.some(e=>e.name===r.child)).length} reference targets`,x+18,y+54,450,26,12,'#64748b');
    members.forEach((entity,j)=>page.text(entity.name,x+18,y+92+j*27,450,26,14,'#334155',false,{entityName:entity.name,link:`data:page/id,fields-${safe(entity.name)}`}));
  });
  return page;
}

function build() {
  fs.mkdirSync(OUT,{recursive:true});
  const models=load();
  if(models.some(e=>!e.domain))throw new Error('A new model needs an area mapping in meta.domains.js.');
  const links=relations(models),infra=storage(models,links),entities=[...models,...infra];
  const pages=[guide(entities,links),overview(entities,links),domainPage({id:'full'},entities,links,true),...DOMAINS.map(d=>domainPage(d,entities,links)),...entities.map(e=>dictionaryPage(e,links))];
  const xml=`<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="app.diagrams.net" agent="RACS schema ERD builder" version="24.7.17" type="device" compressed="false">${pages.map(p=>p.output()).join('\n')}</mxfile>\n`;
  fs.writeFileSync(path.join(OUT,'racs-system-erd.drawio'),xml);
  const inventory={generatedBy:'node scripts/erd/build-drawio.cjs',models:models.length,storageCollections:infra.length,
    fieldCount:entities.reduce((sum,e)=>sum+e.fields.length,0),referenceTargets:links.length,entities,relationships:links,
    pages:pages.map(p=>({id:p.id,name:p.name,nodes:p.nodes,edges:p.edges,width:p.width,height:p.height}))};
  fs.writeFileSync(path.join(OUT,'schema-inventory.json'),JSON.stringify(inventory,null,2)+'\n');
  fs.writeFileSync(path.join(OUT,'README.md'),`# RACS system ERD in draw.io\n\nOpen [racs-system-erd.drawio](racs-system-erd.drawio) at [app.diagrams.net](https://app.diagrams.net/): **File → Open From → Device**.\n\n[View the offline previews](index.html). The SVG previews were exported through the draw.io editor. The editable diagram is the .drawio file.\n\nThe file contains **${models.length} database models**, **${infra.length} storage collections**, **${inventory.fieldCount} schema paths** and **${links.length} reference targets**. Its **${pages.length} pages** include a collection map, a full-system ERD, 10 area diagrams and a full field page for each collection. Click collection titles to move between pages. Table rows move together with their table. All shapes and connectors can be edited.\n\nDeclared references, application links, embedded item links and file storage links are marked separately. Cardinalities use the current required fields and single-field unique indexes; compound uniqueness does not imply a one-to-one relationship. Missing target models are shown as missing targets. No customer data or secrets are included.\n\nRebuild: \`node scripts/erd/build-drawio.cjs\`\n\nValidate: \`node scripts/erd/verify-drawio.cjs\` (Node.js and Python 3; no database needed).\n\nAfter rebuilding, SVG previews need to be exported again in draw.io. The schema XML and inventory are the current source of truth.\n\n[Complete schema inventory](schema-inventory.json)\n`);
  fs.writeFileSync(path.join(OUT,'index.html'),`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>RACS complete system ERD · draw.io</title>
<style>*{box-sizing:border-box}body{margin:0;background:#f1f5f9;color:#172b4d;font:15px/1.6 system-ui,sans-serif}main{max-width:1600px;margin:auto;padding:28px}header{display:flex;justify-content:space-between;align-items:center;gap:24px}h1{margin:4px 0;font-size:28px}h2{margin:0;font-size:18px}.eyebrow{font-size:12px;letter-spacing:.08em;color:#059669;font-weight:700;text-transform:uppercase}p{margin:8px 0;color:#64748b}.actions{display:flex;gap:10px;flex-wrap:wrap}a{color:#1d4ed8}.button{padding:10px 16px;border:1px solid #cbd5e1;border-radius:8px;background:white;text-decoration:none;font-weight:600}.primary{background:#2563eb;border-color:#2563eb;color:white}.stats{display:flex;gap:12px;flex-wrap:wrap;margin:22px 0}.stats span{background:white;border:1px solid #e2e8f0;border-radius:8px;padding:10px 16px}.stats strong{color:#172b4d}.panel{background:white;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden}.toolbar{padding:18px;display:flex;justify-content:space-between;gap:18px;align-items:center;border-bottom:1px solid #e2e8f0}.controls{display:flex;gap:14px;flex-wrap:wrap}label{font-size:13px;color:#475569}select{display:block;min-height:40px;margin-top:4px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:6px;background:white;color:#172b4d;font:inherit}.canvas{height:70vh;overflow:auto;padding:20px;background:white}img{display:block;width:100%;max-width:none;height:auto}footer{margin-top:20px;color:#64748b;font-size:13px}@media(max-width:700px){main{padding:16px}header,.toolbar{align-items:flex-start;flex-direction:column}h1{font-size:24px}.canvas{height:60vh;padding:10px}.controls{width:100%}select{max-width:100%}.stats{gap:8px}.stats span{padding:8px 12px}}</style></head>
<body><main><header><div><div class="eyebrow">CALIDRO RACS · Database diagrams</div><h1>Complete system ERD</h1><p>Based on the current code. Choose a view below, or open the editable file in draw.io.</p></div><div class="actions"><a class="button primary" href="racs-system-erd.drawio" download>Download draw.io file</a><a class="button" href="https://app.diagrams.net/" target="_blank" rel="noopener noreferrer">Open draw.io</a></div></header>
<div class="stats"><span><strong>${models.length}</strong> database models</span><span><strong>${infra.length}</strong> storage collections</span><span><strong>${inventory.fieldCount.toLocaleString('en-US')}</strong> schema fields</span><span><strong>${links.length}</strong> reference targets</span><span><strong>${pages.length}</strong> editable pages</span></div>
<p>In draw.io, choose <strong>File → Open From → Device</strong> and select <strong>racs-system-erd.drawio</strong>. Use the page tabs to move between areas. Click a collection name to open all its fields.</p>
<section class="panel"><div class="toolbar"><div><h2>Diagram preview</h2><p>Use 100% to read the full diagram. Scroll to move around it.</p></div><div class="controls"><label>View<select id="diagram"><option value="full">Full system ERD</option><option value="overview">All collections</option><option value="D3">Bookings & technician work</option><option value="D6">Aircon orders & sales</option><option value="D4">Stock, tools & daily kits</option><option value="fields-Order">All order fields</option></select></label><label>Zoom<select id="zoom"><option value="fit">Fit width</option><option value="50">50%</option><option value="100">100%</option><option value="150">150%</option></select></label></div></div><div class="canvas" id="canvas"><img id="preview" src="full.svg" alt="Full system entity relationship diagram"></div></section>
<footer>Solid links: declared references. Dashed links: application or file storage links. PK: document ID. FK: reference field. Embedded objects stay inside their collection. <a href="README.md">Read the guide</a> · <a href="schema-inventory.json">Complete schema inventory</a> · <a href="../index.html">Earlier Mermaid diagrams</a></footer></main>
<script>(()=>{const view=document.getElementById('diagram'),zoom=document.getElementById('zoom'),image=document.getElementById('preview'),canvas=document.getElementById('canvas');function resize(){image.style.width=zoom.value==='fit'?'100%':image.naturalWidth*Number(zoom.value)/100+'px'}view.addEventListener('change',()=>{image.src=view.value+'.svg';image.alt=view.options[view.selectedIndex].text+' diagram';canvas.scrollTo(0,0)});zoom.addEventListener('change',resize);image.addEventListener('load',resize)})();</script></body></html>`);
  console.log(JSON.stringify({file:'docs/erd/drawio/racs-system-erd.drawio',models:models.length,storageCollections:infra.length,fields:inventory.fieldCount,referenceTargets:links.length,pages:pages.length},null,2));
}
if(require.main===module)build();
module.exports={flatten,relations,load,build};
