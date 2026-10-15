"use strict";
const { manilaDateKey } = require('./bookingDateTime');
async function notifyProjectScheduleChange(project, change, req, deps = {}) {
  const User = deps.User || require('../models/User');
  const notify = deps.notify || require('./notify').createNotification;
  const mailer = deps.mailer || require('./mailer');
  let account = null;
  const errors = [];
  try { account = project.customerId ? await User.findById(project.customerId).select('_id email').lean() : null; }
  catch (_) { errors.push('Customer account could not be loaded'); }
  const email = String(project.customer?.email || account?.email || '').trim();
  const start = manilaDateKey(change.startDate), end = manilaDateKey(change.endDate);
  const message = `Your ${project.service?.name || 'service project'} schedule has changed. The ${change.confirmed ? 'approved work window' : 'preferred work window'} is ${start} to ${end}. ${change.reason || ''}`;
  const result = { inAppSent:false, emailSent:false, sentAt:new Date(), status:'failed' };
  if (project.customerId) {
    try { result.inAppSent = Boolean(await notify({ type:'project_schedule_update', userId:project.customerId, role:'customer', title:'Project schedule updated', message, referenceId:project._id, referenceModel:'Project', link:'/book-history', priority:'high', io:req.app.get('io') })); }
    catch(error){errors.push('In-app notification failed');}
  }
  if (email) {
    try { result.emailSent=Boolean(await mailer.sendMail({to:email,subject:'Your project schedule has changed - CALIDRO RACS',text:message})); }
    catch(error){errors.push('Schedule email could not be queued');}
  }
  result.status=result.inAppSent&&result.emailSent?'sent':result.inAppSent||result.emailSent?'partial':'failed';
  result.error=errors.join('; ');
  const io=req.app.get('io');
  io?.to('admin-room').emit('project:updated',{projectId:project._id,reason:'schedule_changed'});
  if(project.customerId)io?.to(`customer:${project.customerId}`).emit('booking:updated',{bookingId:project.bookingId,projectId:project._id,reason:'project_schedule_changed'});
  return result;
}
module.exports={notifyProjectScheduleChange};
