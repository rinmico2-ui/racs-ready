const BookingService = require('../models/BookingService');
const Technician = require('../models/Technician');
const TechnicianSchedule = require('../models/TechnicianSchedule');
const LeaveRequest = require('../models/LeaveRequest');
const Assignment = require('../models/Assignment');
const Order = require('../models/Order');
const { orderWindow } = require('./orderAssignmentPlanner');
const { projectAllocations } = require('./assignmentProjectCapacity');
const { recommendTeam } = require('./assignmentStaffing');
const { assignmentTimingState, isAssignmentWindowExpired, manilaDateKey, manilaDateTime } = require('./bookingDateTime');
const { latestAllowedFinish, overtimeMinutesForWindow } = require('./technicianOvertimePolicy');

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
  return { start, end, duration: end - start };
}

function dateKey(value) {
  return manilaDateKey(value);
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
  const accounts = await Technician.find({ active: { $ne: false }, archivedAt: null }).populate('user', 'active blocked role').select('_id user name phone email rating availabilityStatus location').lean();
  const techs = accounts.filter(tech => tech.user && tech.user.active !== false && !tech.user.blocked && tech.user.role === 'technician');
  const techIds = techs.map(t => t._id);
  const scheduleDays = rows.map(b => manilaDateTime(b.bookingDate, 0)).filter(Boolean);
  if (!scheduleDays.length) return [];
  const minDate = new Date(Math.min(...scheduleDays.map(date => date.getTime())));
  const maxDate = new Date(Math.max(...scheduleDays.map(date => date.getTime())) + 24 * 60 * 60 * 1000 - 1);
  const [schedules, leaves, existing, activeAssignments, orders, projects] = await Promise.all([
    TechnicianSchedule.find({ technicianId: { $in: techIds } }).lean(),
    LeaveRequest.find({ technicianId: { $in: techIds }, status:'approved', startDate:{ $lte:maxDate }, endDate:{ $gte:minDate } }).lean(),
    BookingService.find({ ...require('./standardJobTeam').scope({ $in:techIds }), archivedAt: null, sourceOrderId: null, bookingDate:{ $gte:minDate,$lte:maxDate }, status:{ $in:ACTIVE_BOOKING_STATUSES } })
      .select('_id technicianId technicianTeam bookingDate startTime endTime serviceDurationMinutes').lean(),
    Assignment.find({technicianId:{$in:techIds},status:{$in:['pending_acceptance','accepted','en_route','on_site','in_progress']}}).select('technicianId').lean(),
    Order.find({ ...require('./standardJobTeam').scope({ $in: techIds }), archivedAt: null,
      'delivery.preferredDate': { $gte: minDate, $lte: maxDate }, status: { $in: ['technician_assigned','technician_accepted','out_for_delivery','arrived','installing'] } })
      .select('_id technicianId technicianTeam continuation delivery.preferredDate timeSlot fulfillmentType items routeDurationMin').lean(),
    projectAllocations(techIds, minDate, maxDate),
  ]);
  const activeLoad=new Map();activeAssignments.forEach(a=>activeLoad.set(String(a.technicianId),(activeLoad.get(String(a.technicianId))||0)+1));
  const scheduleMap = new Map(schedules.map(s => [String(s.technicianId),s]));
  const allocations = new Map();
  techIds.forEach(id => allocations.set(String(id), []));
  require('./standardJobTeam').capacityRows(existing).forEach(b => allocations.get(String(b.technicianId))?.push({ ...bookingWindow(b), date:dateKey(b.bookingDate), bookingId:String(b._id), planned:false }));
  require('./standardJobTeam').capacityRows(orders).forEach(order => allocations.get(String(order.technicianId))?.push({ ...orderWindow(order), date: dateKey(order.delivery?.preferredDate), planned: false }));
  projects.forEach(row => allocations.get(row.technicianId)?.push(row));

  const result = [];
  for (const booking of rows) {
    const key = dateKey(booking.bookingDate); const date = manilaDateTime(booking.bookingDate, 12 * 60); const day = date?.getUTCDay();
    const target = bookingWindow(booking); const bookingCoords = coordinates(booking);
    const timing = assignmentTimingState(booking);
    if (timing.isExpired || !date || !Number.isFinite(target.start) || !Number.isFinite(target.end)) {
      result.push({
        bookingId:String(booking._id),
        bookingReference:booking.bookingReference||`#${String(booking._id).slice(-8).toUpperCase()}`,
        customerName:booking.customer?.name||'Customer',
        serviceName:booking.service?.name||'Service',
        bookingDate:booking.bookingDate,
        startTime:booking.startTime,
        assignmentTiming:timing,
        ...recommendTeam('booking', booking, []),
        issue: timing.isExpired ? 'Reschedule this booking to a future date and time first.' : 'A valid appointment date and time are required.',
        candidates:[],
      });
      continue;
    }
    const priorTechIds = new Set((booking.cancellationHistory||[]).filter(h => ['declined','cancelled'].includes(h.action)).map(h => String(h.technicianId||'')).filter(Boolean));
    for (const member of booking.technicianTeam || []) if (['declined', 'expired'].includes(member.status)) priorTechIds.add(String(member.technicianId));
    const candidates = [];
    const exclusionReasons = {};
    for (const tech of techs) {
      const tid=String(tech._id); const schedule=scheduleMap.get(tid);
      const working=schedule?.workingDays?.find(w => w.dayOfWeek===day);
      const rest=schedule?.restDates?.some(r => dateKey(r?.date || r)===key);
      const nonWorking=schedule?.nonWorkingWeekdays?.some(w => Number(w?.dayOfWeek ?? w)===day);
      const onLeave=leaves.some(l => String(l.technicianId)===tid && key >= dateKey(l.startDate) && key <= dateKey(l.endDate));
      if (!working) { exclusionReasons[tid] = schedule ? 'Not Working This Day' : 'No Schedule'; continue; }
      if (rest) { exclusionReasons[tid] = 'Rest Day'; continue; }
      if (nonWorking) { exclusionReasons[tid] = 'Not Working This Day'; continue; }
      if (onLeave) { exclusionReasons[tid] = 'On Leave'; continue; }
      if (priorTechIds.has(tid)) { exclusionReasons[tid] = 'Previously Declined This Booking'; continue; }
      if (!Number.isFinite(target.start)) { exclusionReasons[tid] = 'Booking Time Is Invalid'; continue; }
      const shiftStart = Number(working.startMinutes ?? 480);
      const shiftEnd = Number(working.endMinutes ?? 1140);
      const overtimeMinutes = overtimeMinutesForWindow(target.start, target.end, shiftStart, shiftEnd);
      if (overtimeMinutes === null) { exclusionReasons[tid] = 'Outside Working Hours and Overtime Limit'; continue; }
      const dayJobs=(allocations.get(tid)||[]).filter(a => a.date===key);
      if (dayJobs.some(a => target.start < a.end && target.end > a.start)) { exclusionReasons[tid] = 'Already Booked at This Time'; continue; }
      const capacity=Math.max(1,latestAllowedFinish(shiftEnd)-shiftStart);
      const used=dayJobs.reduce((s,a)=>s+(a.end-a.start),0);
      if (used+target.duration>capacity) { exclusionReasons[tid] = 'At Capacity'; continue; }
      const dist=distanceKm(bookingCoords,coordinates(tech));
      const utilization=used/capacity;
      const openJobs=activeLoad.get(tid)||0;
      let score=100 - dayJobs.length*18 - openJobs*6 - utilization*35 - Math.ceil(overtimeMinutes / 60)*8 + (Number(tech.rating)||0)*4;
      if(key===dateKey(new Date()) && String(tech.availabilityStatus||'').toLowerCase()==='available')score+=15;
      if (dist!=null) score+=Math.max(0,35-dist*1.5);
      const reasons=['Available during requested schedule','No schedule conflict'];
      if(key===dateKey(new Date()))reasons.push(`Current status: ${tech.availabilityStatus||'Unknown'}`);
      if (!dayJobs.length) reasons.push('Lowest daily workload'); else reasons.push(`${dayJobs.length} existing booking${dayJobs.length===1?'':'s'} that day`);
      reasons.push(`${openJobs} current open assignment${openJobs===1?'':'s'}`);
      if (dist!=null) reasons.push(`${dist} km from customer`);
      reasons.push(`${Math.round((used/capacity)*100)}% of daily capacity used`);
      if (overtimeMinutes) reasons.push(`${overtimeMinutes} minutes of overtime`);
      candidates.push({ technicianId:tid,name:tech.name||'Technician',score:Math.round(score),distanceKm:dist,currentWorkload:dayJobs.length,openAssignments:openJobs,usedMinutes:used,capacityMinutes:capacity,overtimeMinutes,reasons });
    }
    candidates.sort((a,b)=>b.score-a.score || a.currentWorkload-b.currentWorkload || (a.distanceKm??9999)-(b.distanceKm??9999));
    const recommendation = recommendTeam('booking', booking, candidates);
    if (options.reservePlan !== false) for (const technician of recommendation.recommendedTeam) allocations.get(technician.technicianId).push({ ...target,date:key,bookingId:String(booking._id),planned:true });
    result.push({ bookingId:String(booking._id),bookingReference:booking.bookingReference||`#${String(booking._id).slice(-8).toUpperCase()}`,customerName:booking.customer?.name||'Customer',serviceName:booking.service?.name||'Service',bookingDate:booking.bookingDate,startTime:booking.startTime,scheduleKey:require('./standardJobTeam').scheduleKey('booking', booking),assignmentTiming:timing,...recommendation,candidates,exclusionReasons });
  }
  return result;
}

async function createReviewedAssignment(bookingId, technicianId, actor, responseMinutes=30) {
  const booking=await BookingService.findById(bookingId);
  if (!booking || !['awaiting_assignment','pending_reassignment'].includes(booking.status)) throw new Error('Booking is no longer awaiting assignment');
  if (isAssignmentWindowExpired(booking)) throw new Error('The technician-assignment window has expired. Please reschedule to a future date/time first.');
  const input = typeof technicianId === 'object' ? technicianId : { technicianId: String(technicianId), technicianIds: [String(technicianId)] };
  const selected = require('./standardJobTeam').normalize(input);
  require('./assignmentStaffing').assertRecommendedCrew('booking', booking, { assignmentSource: 'reviewed_plan' }, selected);
  const fresh=(await buildAssignmentPlan([booking],{reservePlan:false}))[0];
  if (selected.some(id => !fresh?.candidates?.some(c => c.technicianId === id))) throw new Error('A selected technician is no longer eligible for this schedule');
  const result = await require('./standardJobTeamService').createService().assign('booking', bookingId, {
    ...input, assignmentSource: 'reviewed_plan', responseMinutes,
    notes: 'Assigned from a staff-reviewed recommendation. ' + fresh.staffing.reason,
  }, actor);
  return { ...result, booking: result.job, technician: await Technician.findById(selected[0]).lean() };
}

module.exports={buildAssignmentPlan,createReviewedAssignment,minuteValue,bookingWindow};
