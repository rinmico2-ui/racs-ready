const BookingService = require("../models/BookingService");
const DailyAssignment = require("../models/DailyAssignment");
const EquipmentAssignment = require("../models/EquipmentAssignment");
const LeaveRequest = require("../models/LeaveRequest");
const NonWorkingDay = require("../models/NonWorkingDay");
const TechnicianSchedule = require("../models/TechnicianSchedule");
const Tool = require("../models/Tool");
const WorkOrder = require("../models/WorkOrder");

const ACTIVE_BOOKINGS = ["payment_verified", "awaiting_assignment", "assigned", "pending_reassignment", "confirmed", "scheduled", "on-the-way", "arrived", "in-progress", "repair_scheduled", "repair_in_progress", "inspection_scheduled", "inspection_in_progress", "ready_for_repair"];
const ACTIVE_EQUIPMENT = ["reserved", "checked_out", "in_use"];
const priorityRank = { critical: 0, urgent: 0, high: 1, normal: 2, low: 3 };
const weekdayNumbers = { sunday:0, sun:0, monday:1, mon:1, tuesday:2, tue:2, tues:2, wednesday:3, wed:3, thursday:4, thu:4, thur:4, thurs:4, friday:5, fri:5, saturday:6, sat:6 };
const dayKey = value => { const d = new Date(value); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
const dayStart = value => { const d = new Date(value); d.setHours(0,0,0,0); return d; };
const parseTime = (value, fallback) => { const match = String(value || "").match(/^(\d{1,2}):(\d{2})/); return match ? Number(match[1])*60 + Number(match[2]) : fallback; };
const timeText = minutes => `${String(Math.floor(minutes/60)).padStart(2,"0")}:${String(minutes%60).padStart(2,"0")}`;
const overlap = (aStart,aEnd,bStart,bEnd) => aStart < bEnd && bStart < aEnd;

function normalizeWorkingDays(values, fallback=[1,2,3,4,5]) {
  const source=Array.isArray(values)?values:[];
  const normalized=source.map(value=>{
    if(typeof value==="number"&&Number.isInteger(value))return value;
    const text=String(value??"").trim().toLowerCase();
    if(!text)return NaN;
    if(Object.prototype.hasOwnProperty.call(weekdayNumbers,text))return weekdayNumbers[text];
    const numeric=Number(text);return Number.isInteger(numeric)?numeric:NaN;
  }).filter(value=>Number.isInteger(value)&&value>=0&&value<=6);
  return normalized.length?[...new Set(normalized)]:[...fallback];
}

function subtractIntervals(baseStart, baseEnd, busy) {
  let free = [[baseStart, baseEnd]];
  busy.sort((a,b)=>a[0]-b[0]).forEach(([start,end]) => {
    free = free.flatMap(([freeStart,freeEnd]) => !overlap(freeStart,freeEnd,start,end) ? [[freeStart,freeEnd]] : [[freeStart,Math.max(freeStart,start)],[Math.min(freeEnd,end),freeEnd]].filter(([a,b])=>b-a>=15));
  });
  return free;
}

function topoSort(orders) {
  const map = new Map(orders.map(order => [String(order._id), order]));
  const deps = new Map(orders.map(order => [String(order._id), new Set((order.dependencies || []).map(String).filter(id=>map.has(id)))]));
  const result=[];
  while(result.length<orders.length){
    const candidates=orders.filter(order=>!result.includes(order)&&deps.get(String(order._id)).size===0).sort((a,b)=>(priorityRank[a.priority]??2)-(priorityRank[b.priority]??2)||(a.sortOrder||0)-(b.sortOrder||0));
    if(!candidates.length) throw new Error("Work-order dependencies contain a circular reference");
    const next=candidates[0]; result.push(next); deps.forEach(set=>set.delete(String(next._id)));
  }
  return result;
}

function equipmentRequirements(order) {
  return (order.resourceRequirements || []).filter(resource => resource.type === "equipment" && resource.toolId && Number(resource.quantity || 0)>0);
}

function combinations(values, size, start = 0, chosen = [], result = []) {
  if (chosen.length === size) { result.push([...chosen]); return result; }
  for (let index = start; index <= values.length - (size - chosen.length); index += 1) {
    chosen.push(values[index]);
    combinations(values, size, index + 1, chosen, result);
    chosen.pop();
  }
  return result;
}

async function buildSchedulingContext(project, options={}) {
  const start = dayStart(options.startDate || project.schedulePlan?.startDate || project.plannedStartDate || project.preferredStartDate || new Date());
  const target = options.targetEndDate ? dayStart(options.targetEndDate) : project.preferredCompletionDeadline ? dayStart(project.preferredCompletionDeadline) : null;
  // Keep a long planning horizon even when the requested deadline is short;
  // the engine must still show the realistic completion date and deadline gap.
  const horizon = new Date(start); horizon.setDate(horizon.getDate() + 180);
  const teamIds=(project.assignedTechnicians||[]).map(member=>member._id||member);
  const [schedules,leaves,holidays,bookings,otherAssignments,equipmentAssignments,tools] = await Promise.all([
    TechnicianSchedule.find({technicianId:{$in:teamIds}}).lean(),
    LeaveRequest.find({technicianId:{$in:teamIds},status:"approved",startDate:{$lte:horizon},endDate:{$gte:start}}).lean(),
    NonWorkingDay.find({service:null,date:{$gte:start,$lte:horizon}}).lean(),
    BookingService.find({technicianId:{$in:teamIds},bookingDate:{$gte:start,$lte:horizon},status:{$in:ACTIVE_BOOKINGS}}).select("technicianId bookingDate startTime endTime serviceDurationMinutes travelDurationMinutes bookingReference service.name").lean(),
    DailyAssignment.find({technicianId:{$in:teamIds},projectId:{$ne:project._id},date:{$gte:start,$lte:horizon},status:{$ne:"skipped"}}).select("technicianId date startTime endTime allocatedMinutes workOrderId").lean(),
    EquipmentAssignment.find({projectId:{$ne:project._id},workDate:{$gte:start,$lte:horizon},status:{$in:ACTIVE_EQUIPMENT}}).select("equipmentId equipmentName workDate quantity").lean(),
    Tool.find({active:{$ne:false}}).select("_id itemName quantity reservedQuantity").lean(),
  ]);
  return {start,target,horizon,teamIds:teamIds.map(String),schedules,leaves,holidays,bookings,otherAssignments,equipmentAssignments,tools};
}

async function generateProjectSchedule(project, options={}) {
  const orders = topoSort(await WorkOrder.find({projectId:project._id,status:{$ne:"cancelled"}}).lean());
  if(!orders.length) throw new Error("Generate valid draft work orders before scheduling");
  const context=await buildSchedulingContext(project,options);
  const workingDays=normalizeWorkingDays(options.workingDays?.length?options.workingDays:(project.schedulePlan?.workingDays?.length?project.schedulePlan.workingDays:project.preferredWorkingDays));
  const projectStart=parseTime(options.startTime||project.preferredWorkingHours?.start||"09:00",540);
  const projectEnd=parseTime(options.endTime||project.preferredWorkingHours?.end||"17:00",1020);
  if(projectEnd<=projectStart) throw new Error("Daily end time must be after start time");
  const scheduleMap=new Map(context.schedules.map(row=>[String(row.technicianId),row]));
  const holidaySet=new Set(context.holidays.map(row=>dayKey(row.date)));
  const toolMap=new Map(context.tools.map(tool=>[String(tool._id),tool]));
  const busyByTechDay=new Map();
  const equipmentUse=new Map();
  const conflicts=[];
  const allocations=[];
  const woFinish=new Map();
  const workOrderOverrides=options.workOrderOverrides||{};
  (project.planningDraft?.resources||[]).filter(resource=>["consumable","part"].includes(resource.type)&&!["rejected","optional"].includes(resource.recommendationState)&&Number(resource.shortage||0)>0).forEach(resource=>conflicts.push({type:"procurement",resourceId:resource._id,itemName:resource.itemName,message:`${resource.itemName} needs ${resource.shortage} ${resource.unit||"pcs"} from procurement before execution.`,blocking:false,actions:["Start Procurement","Adjust Quantity"]}));
  const addBusy=(techId,date,start,end,detail,type)=>{const key=`${techId}|${dayKey(date)}`;if(!busyByTechDay.has(key))busyByTechDay.set(key,[]);busyByTechDay.get(key).push([start,end,detail,type]);};
  context.bookings.forEach(booking=>{const start=parseTime(booking.startTime,projectStart);const end=parseTime(booking.endTime,start+Number(booking.serviceDurationMinutes||60)+Number(booking.travelDurationMinutes||0));addBusy(String(booking.technicianId),booking.bookingDate,start,end,booking.bookingReference||booking.service?.name||"Customer booking","booking");});
  context.otherAssignments.forEach(row=>{const start=parseTime(row.startTime,projectStart);const end=parseTime(row.endTime,start+Number(row.allocatedMinutes||390));addBusy(String(row.technicianId),row.date,start,end,"Another project","project");});
  const isOnLeave=(techId,date)=>context.leaves.some(row=>String(row.technicianId)===techId&&dayStart(row.startDate)<=date&&dayStart(row.endDate)>=date);
  const windowsFor=(techId,date)=>{
    if(isOnLeave(techId,date))return[];
    const sched=scheduleMap.get(techId);const configs=sched?.workingDays?.filter(row=>row.dayOfWeek===date.getDay())||[];
    if((sched?.restDates||[]).some(row=>dayKey(row.date)===dayKey(date)))return[];
    if(sched&&configs.length===0)return[];
    const baseStart=Math.max(projectStart,configs.length?Math.min(...configs.map(row=>row.startMinutes)):projectStart);
    const baseEnd=Math.min(projectEnd,configs.length?Math.max(...configs.map(row=>row.endMinutes)):projectEnd);
    return subtractIntervals(baseStart,baseEnd,(busyByTechDay.get(`${techId}|${dayKey(date)}`)||[]).map(row=>[row[0],row[1]]));
  };
  const equipmentAvailable=(order,date,start,end)=>equipmentRequirements(order).every(req=>{
    const tool=toolMap.get(String(req.toolId));const owned=Number(tool?.quantity||0);
    const external=context.equipmentAssignments.filter(row=>String(row.equipmentId)===String(req.toolId)&&dayKey(row.workDate)===dayKey(date)).reduce((sum,row)=>sum+Number(row.quantity||1),0);
    const key=`${req.toolId}|${dayKey(date)}`;const internal=(equipmentUse.get(key)||[]).filter(row=>overlap(start,end,row.start,row.end)).reduce((sum,row)=>sum+row.quantity,0);
    return owned-external-internal>=Number(req.quantity||1);
  });
  const reserveEquipment=(order,date,start,end)=>equipmentRequirements(order).forEach(req=>{const key=`${req.toolId}|${dayKey(date)}`;if(!equipmentUse.has(key))equipmentUse.set(key,[]);equipmentUse.get(key).push({start,end,quantity:Number(req.quantity||1),workOrderId:order._id,itemName:req.itemName});});

  for(const order of orders){
    const override=workOrderOverrides[String(order._id)]||null;
    let remaining=Math.max(30,Math.ceil(Number(order.estimatedHours||1)*60));
    let unitsRemaining=Math.max(0,Number(order.unitCount||0));
    let unitOffset=0;
    const missingEquipment=equipmentRequirements(order).filter(req=>Number(toolMap.get(String(req.toolId))?.quantity||0)<Number(req.quantity||1));
    if(missingEquipment.length){conflicts.push({type:"equipment",workOrderId:order._id,workOrderNumber:order.workOrderNumber,message:`${order.workOrderNumber||order.title} needs unavailable equipment: ${missingEquipment.map(req=>`${req.itemName} ×${req.quantity}`).join(", ")}.`,blocking:true,actions:["Change Equipment","Adjust Work Order","Start Procurement"]});continue;}
    const required=Math.max(1,Number(order.requiredTechnicianCount||1));
    const assignedSource=Array.isArray(override?.assignedTechnicians)&&override.assignedTechnicians.length?override.assignedTechnicians:(order.assignedTechnicians||[]);
    const techIds=assignedSource.map(member=>String(member._id||member)).filter(id=>context.teamIds.includes(id));
    if(techIds.length<required){conflicts.push({type:"technician",workOrderId:order._id,workOrderNumber:order.workOrderNumber,message:`${order.workOrderNumber||order.title} requires ${required} technician(s), but only ${techIds.length} valid team member(s) are assigned.`,blocking:true,actions:["Change Team","Change Technician"]});continue;}
    let cursor=dayStart(override?.startDate||context.start);const dependencyDates=(order.dependencies||[]).map(id=>woFinish.get(String(id))).filter(Boolean);if(dependencyDates.length){const earliest=new Date(Math.max(...dependencyDates.map(date=>date.getTime())));earliest.setDate(earliest.getDate()+1);const dependencyStart=dayStart(earliest);if(override?.startDate&&cursor<dependencyStart){conflicts.push({type:"dependency",workOrderId:order._id,workOrderNumber:order.workOrderNumber,message:`${order.workOrderNumber||order.title} cannot start before its prerequisite Work Order finishes.`,blocking:true,actions:["Move Work Order","Change Date"]});continue;}if(cursor<dependencyStart)cursor=dependencyStart;}
    const orderHorizon=override?.endDate?dayStart(override.endDate):context.horizon;
    const forcedStart=override?.startTime?parseTime(override.startTime,projectStart):null;
    const forcedEnd=override?.endTime?parseTime(override.endTime,projectEnd):null;
    if(override&&(forcedStart===null||forcedEnd===null||forcedEnd<=forcedStart)){conflicts.push({type:"working_hours",workOrderId:order._id,workOrderNumber:order.workOrderNumber,message:`${order.workOrderNumber||order.title} has an invalid manual time range.`,blocking:true,actions:["Change Time"]});continue;}
    let guard=0;
    while(remaining>0&&cursor<=orderHorizon&&cursor<=context.horizon&&guard++<180){
      const key=dayKey(cursor);
      if(!workingDays.includes(cursor.getDay())||holidaySet.has(key)){cursor.setDate(cursor.getDate()+1);continue;}
      let selected=[],slot=null;
      for(const candidateTeam of combinations(techIds,required)){
        const windows=candidateTeam.map(id=>windowsFor(id,cursor).filter(window=>!override||(window[0]<=forcedStart&&window[1]>forcedStart)).map(window=>override?[forcedStart,Math.min(window[1],forcedEnd)]:window).filter(window=>window[1]-window[0]>=15));
        for(const candidate of windows[0]||[]){
          let start=candidate[0],end=candidate[1];
          for(let i=1;i<windows.length;i++){const common=windows[i].find(row=>Math.max(start,row[0])<Math.min(end,row[1]));if(!common){end=start;break;}start=Math.max(start,common[0]);end=Math.min(end,common[1]);}
          if(end-start>=15&&equipmentAvailable(order,cursor,start,end)&&(!slot||start<slot[0])){slot=[start,end];selected=candidateTeam;}
        }
      }
      if(slot){
        const elapsed=Math.min(slot[1]-slot[0],Math.ceil(remaining/required));const end=slot[0]+elapsed;
        const unitRate=Number(order.unitCount||1)/Math.max(1,Number(order.estimatedHours||1)*60);
        const targetUnits=Math.min(unitsRemaining,Math.max(remaining-elapsed*required<=0?unitsRemaining:0,Math.round(elapsed*required*unitRate)));
        selected.forEach((id,index)=>{const techUnits=Math.floor(targetUnits/required)+(index<targetUnits%required?1:0);const unitKeys=(order.units||[]).slice(unitOffset,unitOffset+techUnits).map(unit=>unit.unitKey).filter(Boolean);unitOffset+=techUnits;addBusy(id,cursor,slot[0],end,order.workOrderNumber||order.title,"project");allocations.push({projectId:project._id,workOrderId:order._id,technicianId:id,date:new Date(cursor),startTime:timeText(slot[0]),endTime:timeText(end),allocatedMinutes:elapsed,targetUnits:techUnits,unitKeys,generatedBy:"system",planningOnly:true});});
        reserveEquipment(order,cursor,slot[0],end);remaining-=elapsed*required;unitsRemaining-=targetUnits;woFinish.set(String(order._id),new Date(cursor));
      }
      cursor.setDate(cursor.getDate()+1);
    }
    if(override&&!allocations.some(row=>String(row.workOrderId)===String(order._id)&&dayKey(row.date)===dayKey(override.startDate)&&parseTime(row.startTime)===forcedStart))conflicts.push({type:"manual_adjustment",workOrderId:order._id,workOrderNumber:order.workOrderNumber,message:`${order.workOrderNumber||order.title} cannot start at the requested date and time without a conflict.`,blocking:true,actions:["Change Date","Change Time","Change Technician"]});
    if(remaining>0)conflicts.push({type:"capacity",workOrderId:order._id,workOrderNumber:order.workOrderNumber,message:`${order.workOrderNumber||order.title} has ${Math.ceil(remaining/60)} unscheduled technician-hour(s).`,blocking:true,actions:["Extend Project End","Change Team","Change Technician"]});
  }
  const externalConflicts=[];context.bookings.forEach(booking=>{const start=parseTime(booking.startTime,projectStart),end=parseTime(booking.endTime,start+Number(booking.serviceDurationMinutes||60));allocations.filter(row=>row.technicianId===String(booking.technicianId)&&dayKey(row.date)===dayKey(booking.bookingDate)&&overlap(parseTime(row.startTime),parseTime(row.endTime),start,end)).forEach(row=>externalConflicts.push({type:"booking",workOrderId:row.workOrderId,date:dayKey(row.date),message:`Technician has customer booking ${timeText(start)}–${timeText(end)}.`,blocking:true,actions:["Move Work Order","Change Technician","Change Time"]}));});conflicts.push(...externalConflicts);
  const finalDate=allocations.length?new Date(Math.max(...allocations.map(row=>new Date(row.date).getTime()))):context.start;
  if(context.target&&finalDate>context.target)conflicts.push({type:"deadline",date:dayKey(finalDate),message:`Calculated execution ends ${dayKey(finalDate)}, after target ${dayKey(context.target)}.`,blocking:true,actions:["Extend Target End","Add Technician"]});
  const grouped=new Map();allocations.forEach(row=>{const key=dayKey(row.date);if(!grouped.has(key))grouped.set(key,{date:key,allocations:[],technicians:{}});const day=grouped.get(key);day.allocations.push(row);const tech=project.assignedTechnicians.find(member=>String(member._id)===row.technicianId);const mins=(day.technicians[row.technicianId]?.assignedMinutes||0)+row.allocatedMinutes;const freeMinutes=windowsFor(row.technicianId,new Date(row.date)).reduce((sum,window)=>sum+window[1]-window[0],0);day.technicians[row.technicianId]={name:tech?.name||"Technician",assignedMinutes:mins,capacityMinutes:mins+freeMinutes,freeMinutes};});
  grouped.forEach(day=>{day.externalEvents=[];});
  context.bookings.forEach(booking=>{const day=grouped.get(dayKey(booking.bookingDate));if(!day)return;const start=parseTime(booking.startTime,projectStart),end=parseTime(booking.endTime,start+Number(booking.serviceDurationMinutes||60)+Number(booking.travelDurationMinutes||0));day.externalEvents.push({type:"customer_booking",technicianId:String(booking.technicianId),technicianName:project.assignedTechnicians.find(member=>String(member._id)===String(booking.technicianId))?.name||"Technician",startTime:timeText(start),endTime:timeText(end),label:booking.bookingReference||booking.service?.name||"Customer Booking"});});
  context.otherAssignments.forEach(row=>{const day=grouped.get(dayKey(row.date));if(!day)return;const start=parseTime(row.startTime,projectStart),end=parseTime(row.endTime,start+Number(row.allocatedMinutes||390));day.externalEvents.push({type:"other_project",technicianId:String(row.technicianId),technicianName:project.assignedTechnicians.find(member=>String(member._id)===String(row.technicianId))?.name||"Technician",startTime:timeText(start),endTime:timeText(end),label:"Another Project"});});
  grouped.forEach(day=>context.teamIds.forEach(techId=>{const tech=project.assignedTechnicians.find(member=>String(member._id)===techId);const assignedMinutes=Number(day.technicians[techId]?.assignedMinutes||0);const freeMinutes=windowsFor(techId,new Date(`${day.date}T00:00:00`)).reduce((sum,window)=>sum+window[1]-window[0],0);day.technicians[techId]={name:tech?.name||"Technician",assignedMinutes,capacityMinutes:assignedMinutes+freeMinutes,freeMinutes};}));
  const qualityScore=Math.max(0,100-conflicts.filter(row=>row.blocking).length*20-conflicts.filter(row=>!row.blocking).length*5);
  return {allocations,conflicts,dailySummary:[...grouped.values()],startDate:context.start,executionEndDate:finalDate,estimatedEndDate:(()=>{const d=new Date(finalDate);let added=0,buffer=Math.max(0,Number(options.bufferDays||0));while(added<buffer){d.setDate(d.getDate()+1);if(workingDays.includes(d.getDay())&&!holidaySet.has(dayKey(d)))added++;}return d;})(),workingDays,workingHours:{start:timeText(projectStart),end:timeText(projectEnd)},bufferDays:Math.max(0,Number(options.bufferDays||0)),qualityScore,status:conflicts.some(row=>row.blocking)?"blocked":"ready"};
}

async function validateProjectSchedule(project) {
  const result=await generateProjectSchedule(project,{startDate:project.schedulePlan?.startDate,targetEndDate:project.schedulePlan?.targetEndDate,workingDays:project.schedulePlan?.workingDays,startTime:project.schedulePlan?.workingHours?.start,endTime:project.schedulePlan?.workingHours?.end,bufferDays:project.schedulePlan?.bufferDays,workOrderOverrides:project.schedulePlan?.manualOverrides||{}});
  return {...result,valid:result.status==="ready"};
}

module.exports={generateProjectSchedule,validateProjectSchedule,normalizeWorkingDays,parseTime,timeText,overlap};
