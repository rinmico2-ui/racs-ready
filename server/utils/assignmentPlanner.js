const BookingService = require('../models/BookingService');
const Technician = require('../models/Technician');
const TechnicianSchedule = require('../models/TechnicianSchedule');
const LeaveRequest = require('../models/LeaveRequest');
const Assignment = require('../models/Assignment');

const ACTIVE_BOOKING_STATUSES = [
  'assigned','confirmed','scheduled','on-the-way','arrived','in-progress','ongoing',
  'inspection_scheduled','inspection_in_progress','repair_approved','ready_for_repair',
  'repair_scheduled','repair_in_progress',
];

function minuteValue(value) {
  if (value == null || value === '') return NaN;
  const raw = String(value).trim();
  if (/^\d{1,4}$/.test(raw)) return Number(raw);
  const hm = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  const ap = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!ap) return NaN;
  let hour = Number(ap[1]) % 12;
  if (ap[3].toUpperCase() === 'PM') hour += 12;
  return hour * 60 + Number(ap[2]);
}

function bookingWindow(booking) {
  const start = minuteValue(booking.startTime);
  const explicitEnd = minuteValue(booking.endTime);
  const duration = Math.max(30, Number(booking.serviceDurationMinutes) || 60);
  const end = Number.isFinite(explicitEnd) && explicitEnd > start ? explicitEnd : start + duration;
  return { start, end, duration: Math.max(duration, end - start) };
}

function dateKey(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function coordinates(entity) {
  const raw = entity?.location?.coordinates?.coordinates || entity?.location?.coordinates ||
    (entity?.location?.lat != null ? [entity.location.lng, entity.location.lat] : null) ||
    (entity?.bookingLocation?.lat != null ? [entity.bookingLocation.lng, entity.bookingLocation.lat] : null);
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const lng = Number(raw[0]); const lat = Number(raw[1]);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function distanceKm(a, b) {
  if (!a || !b) return null;
  const rad = n => n * Math.PI / 180;
  const dLat = rad(b.lat-a.lat); const dLng = rad(b.lng-a.lng);
  const h = Math.sin(dLat/2)**2 + Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLng/2)**2;
  return Math.round(6371 * 2 * Math.atan2(Math.sqrt(h),Math.sqrt(1-h)) * 10) / 10;
}

async function buildAssignmentPlan(bookings, options = {}) {
  const rows = (bookings || []).filter(Boolean).sort((a,b) => new Date(a.bookingDate)-new Date(b.bookingDate) || minuteValue(a.startTime)-minuteValue(b.startTime));
  if (!rows.length) return [];
  const techs = await Technician.find({ active: { $ne: false } }).select('_id user name phone email rating availabilityStatus location').lean();
  const techIds = techs.map(t => t._id);
  const minDate = new Date(Math.min(...rows.map(b => new Date(b.bookingDate).getTime()))); minDate.setHours(0,0,0,0);
  const maxDate = new Date(Math.max(...rows.map(b => new Date(b.bookingDate).getTime()))); maxDate.setHours(23,59,59,999);
  const [schedules, leaves, existing, activeAssignments] = await Promise.all([
    TechnicianSchedule.find({ technicianId: { $in: techIds } }).lean(),
    LeaveRequest.find({ technicianId: { $in: techIds }, status:'approved', startDate:{ $lte:maxDate }, endDate:{ $gte:minDate } }).lean(),
    BookingService.find({ technicianId:{ $in:techIds }, bookingDate:{ $gte:minDate,$lte:maxDate }, status:{ $in:ACTIVE_BOOKING_STATUSES } })
      .select('_id technicianId bookingDate startTime endTime serviceDurationMinutes').lean(),
    Assignment.find({technicianId:{$in:techIds},status:{$in:['pending_acceptance','accepted','en_route','on_site','in_progress']}}).select('technicianId').lean(),
  ]);
  const activeLoad=new Map();activeAssignments.forEach(a=>activeLoad.set(String(a.technicianId),(activeLoad.get(String(a.technicianId))||0)+1));
  const scheduleMap = new Map(schedules.map(s => [String(s.technicianId),s]));
  const allocations = new Map();
  techIds.forEach(id => allocations.set(String(id), []));
  existing.forEach(b => allocations.get(String(b.technicianId))?.push({ ...bookingWindow(b), date:dateKey(b.bookingDate), bookingId:String(b._id), planned:false }));

  const result = [];
  for (const booking of rows) {
    const key = dateKey(booking.bookingDate); const date = new Date(booking.bookingDate); const day = date.getDay();
    const target = bookingWindow(booking); const bookingCoords = coordinates(booking);
    const priorTechIds = new Set((booking.cancellationHistory||[]).map(h => String(h.technicianId||'')).filter(Boolean));
    const candidates = [];
    for (const tech of techs) {
      const tid=String(tech._id); const schedule=scheduleMap.get(tid);
      const working=schedule?.workingDays?.find(w => w.dayOfWeek===day);
      const rest=schedule?.restDates?.some(r => dateKey(r?.date || r)===key);
      const nonWorking=schedule?.nonWorkingWeekdays?.some(w => Number(w?.dayOfWeek ?? w)===day);
      const onLeave=leaves.some(l => String(l.technicianId)===tid && date >= new Date(new Date(l.startDate).setHours(0,0,0,0)) && date <= new Date(new Date(l.endDate).setHours(23,59,59,999)));
      if (!working || rest || nonWorking || onLeave || priorTechIds.has(tid) || !Number.isFinite(target.start)) continue;
      if (target.start < Number(working.startMinutes||480) || target.end > Number(working.endMinutes||1020)) continue;
      const dayJobs=(allocations.get(tid)||[]).filter(a => a.date===key);
      if (dayJobs.some(a => target.start < a.end && target.end > a.start)) continue;
      const capacity=Math.max(1,Number(working.endMinutes||1020)-Number(working.startMinutes||480));
      const used=dayJobs.reduce((s,a)=>s+(a.end-a.start),0);
      if (used+target.duration>capacity) continue;
      const dist=distanceKm(bookingCoords,coordinates(tech));
      const utilization=used/capacity;
      const openJobs=activeLoad.get(tid)||0;
      let score=100 - dayJobs.length*18 - openJobs*6 - utilization*35 + (Number(tech.rating)||0)*4;
      if(key===dateKey(new Date()) && String(tech.availabilityStatus||'').toLowerCase()==='available')score+=15;
      if (dist!=null) score+=Math.max(0,35-dist*1.5);
      const reasons=['Available during requested schedule','No schedule conflict'];
      if(key===dateKey(new Date()))reasons.push(`Current status: ${tech.availabilityStatus||'Unknown'}`);
      if (!dayJobs.length) reasons.push('Lowest daily workload'); else reasons.push(`${dayJobs.length} existing booking${dayJobs.length===1?'':'s'} that day`);
      reasons.push(`${openJobs} current open assignment${openJobs===1?'':'s'}`);
      if (dist!=null) reasons.push(`${dist} km from customer`);
      reasons.push(`${Math.round((used/capacity)*100)}% of daily capacity used`);
      candidates.push({ technicianId:tid,name:tech.name||'Technician',score:Math.round(score),distanceKm:dist,currentWorkload:dayJobs.length,openAssignments:openJobs,usedMinutes:used,capacityMinutes:capacity,reasons });
    }
    candidates.sort((a,b)=>b.score-a.score || a.currentWorkload-b.currentWorkload || (a.distanceKm??9999)-(b.distanceKm??9999));
    const recommended=candidates[0]||null;
    if (recommended && options.reservePlan !== false) allocations.get(recommended.technicianId).push({ ...target,date:key,bookingId:String(booking._id),planned:true });
    result.push({ bookingId:String(booking._id),bookingReference:booking.bookingReference||`#${String(booking._id).slice(-8).toUpperCase()}`,customerName:booking.customer?.name||'Customer',serviceName:booking.service?.name||'Service',bookingDate:booking.bookingDate,startTime:booking.startTime,recommended,candidates:candidates.slice(0,5) });
  }
  return result;
}

async function createReviewedAssignment(bookingId, technicianId, actor, responseMinutes=30) {
  const booking=await BookingService.findById(bookingId);
  if (!booking || !['awaiting_assignment','pending_reassignment'].includes(booking.status)) throw new Error('Booking is no longer awaiting assignment');
  const fresh=(await buildAssignmentPlan([booking],{reservePlan:false}))[0];
  const candidate=fresh?.candidates?.find(c=>c.technicianId===String(technicianId));
  if (!candidate) throw new Error('Technician is no longer eligible for this schedule');
  const tech=await Technician.findById(technicianId).lean();
  const minutes=Math.min(720,Math.max(5,Number(responseMinutes)||30));
  const assignment=await Assignment.create({bookingId:booking._id,technicianId:tech._id,customerName:booking.customer?.name||'',customerPhone:booking.customer?.phone||'',customerEmail:booking.customer?.email||'',serviceType:booking.serviceType||'core',serviceName:booking.service?.name||'',servicePrice:booking.totalPrice||booking.estimatedFee||0,bookingDate:booking.bookingDate,startTime:booking.startTime||'',endTime:booking.endTime||'',address:booking.location?.address||booking.bookingLocation?.address||'',status:'pending_acceptance',responseSLAMinutes:minutes,acceptanceDeadline:new Date(Date.now()+minutes*60000),notes:[{text:'Assigned from admin-reviewed recommendation plan',by:actor?._id,byName:actor?.name||actor?.email||'Admin'}]});
  booking.status='assigned'; booking.technicianId=tech._id; booking.technician={_id:tech._id,name:tech.name,phone:tech.phone,email:tech.email}; booking.assignmentId=assignment._id; booking.assignedAt=new Date(); booking.assignedBy=actor?._id;
  await booking.save();
  return {booking,assignment,technician:tech,candidate};
}

module.exports={buildAssignmentPlan,createReviewedAssignment,minuteValue,bookingWindow};
