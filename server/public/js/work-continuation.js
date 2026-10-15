(function () {
  "use strict";
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]);
  async function api(url, body) {
    const response = await fetch(url, body ? { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) } : {});
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) throw Error(data?.error || 'The request could not be completed. Refresh and try again.');
    return data;
  }
  async function request(source, id) {
    const result = await Swal.fire({ title:'Continue on another visit',
      html:'<p class="small text-muted">Close this visit and ask Operations to arrange the remaining work. Existing payments and completed work stay recorded.</p><label class="form-label d-block text-start" for="continuationReason">Reason *</label><input class="form-control mb-3" id="continuationReason" maxlength="500"><label class="form-label d-block text-start" for="continuationWork">Work still needed *</label><textarea class="form-control mb-3" id="continuationWork" maxlength="1500" rows="3"></textarea><label class="form-label d-block text-start" for="continuationMinutes">Estimated next visit duration (minutes) *</label><input class="form-control" id="continuationMinutes" type="number" min="15" max="480" step="15" value="60">',
      showCancelButton:true, confirmButtonText:'Request next visit', showLoaderOnConfirm:true,
      preConfirm:async () => {
        const body={reason:document.getElementById('continuationReason').value.trim(),remainingWork:document.getElementById('continuationWork').value.trim(),remainingMinutes:Number(document.getElementById('continuationMinutes').value)};
        if(body.reason.length<5||body.remainingWork.length<10||!Number.isInteger(body.remainingMinutes)||body.remainingMinutes<15||body.remainingMinutes>480){Swal.showValidationMessage('Provide a reason, remaining work, and duration from 15 to 480 minutes.');return false;}
        try{return await api(`/api/work-continuations/${source}/${encodeURIComponent(id)}/request`,body);}catch(error){Swal.showValidationMessage(error.message);return false;}
      } });
    if(result.isConfirmed){await Swal.fire({icon:'success',title:'Next visit requested',text:result.value.message});window.location.reload();}
  }
  async function loadQueue(root) {
    const source=root.dataset.continuationQueue;
    try{
      const data=await api(`/api/work-continuations/pending?source=${source}`);
      root.innerHTML=data.jobs.length?`<div class="alert alert-warning"><strong>Unfinished work: ${data.jobs.length} continuation request(s)</strong><p class="small mb-2">Confirm the next visit using live technician availability.</p>${data.jobs.map((job,index)=>`<div class="d-flex flex-wrap align-items-center justify-content-between gap-2 border-top py-2"><div><strong>${esc(job.bookingReference||job.orderReference)}</strong> · ${esc(job.customer?.name)}<div class="small">${esc(job.continuation.remainingWork)}</div></div><button class="btn btn-sm btn-primary" type="button" data-continuation-schedule="${index}">Schedule next visit</button></div>`).join('')}</div>`:'';
      root.onclick=event=>{const button=event.target.closest('[data-continuation-schedule]');if(button)schedule(source,data.jobs[Number(button.dataset.continuationSchedule)],root).catch(error=>Swal.fire({icon:'error',text:error.message}));};
    }catch(error){root.innerHTML=`<div class="alert alert-danger small">${esc(error.message)} <button type="button" class="btn btn-sm btn-outline-danger">Retry continuation requests</button></div>`;root.onclick=()=>loadQueue(root);}
  }
  async function schedule(source,job,root){
    let verified=null,sequence=0;
    const {technicians} = await api(`/api/work-continuations/technicians?source=${source}`).catch(() => ({technicians:[]}));
    if(!technicians.some(tech => String(tech._id)===String(job.technicianId))) technicians.unshift({_id:job.technicianId,name:'Current technician (availability will be checked)'});
    await Swal.fire({title:'Schedule continuation',width:680,showCancelButton:true,confirmButtonText:'Confirm next visit',showLoaderOnConfirm:true,
      html:`<p class="small text-muted">${esc(job.continuation.remainingWork)}</p><label class="form-label d-block text-start" for="continuationTechnician">Technician *</label><select class="form-select mb-3" id="continuationTechnician">${technicians.map(tech=>`<option value="${esc(tech._id)}" ${String(tech._id)===String(job.technicianId)?'selected':''}>${esc(tech.name)}</option>`).join('')}</select><label class="form-label d-block text-start" for="continuationDate">Work date *</label><input type="date" class="form-control mb-3" id="continuationDate"><label class="form-label d-block text-start">Visit duration (minutes) *</label><input class="form-control mb-3" id="continuationDuration" type="number" min="15" max="480" value="${Number(job.continuation.remainingMinutes)}"><button type="button" class="btn btn-outline-primary mb-3" id="continuationCheck">Check technician availability</button><div id="continuationSlots" role="status" class="small text-muted">Choose a date, then check availability.</div>`,
      didOpen:()=>{
        const date=document.getElementById('continuationDate'),duration=document.getElementById('continuationDuration'),slots=document.getElementById('continuationSlots');
        const invalidate=()=>{sequence++;verified=null;slots.textContent='Check availability again after changing the date or duration.';};date.onchange=invalidate;duration.oninput=invalidate;document.getElementById('continuationTechnician').onchange=invalidate;
        document.getElementById('continuationCheck').onclick=async()=>{
          const ticket=++sequence;verified=null;slots.textContent='Checking current technician availability...';
          try{const body={date:date.value,remainingMinutes:Number(duration.value),technicianId:document.getElementById('continuationTechnician').value};const result=await api(`/api/work-continuations/${source}/${job._id}/availability`,body);if(ticket!==sequence)return;verified=body;const open=result.timeSlots.filter(row=>row.available===true);slots.innerHTML=open.length?`<label class="form-label d-block text-start" for="continuationTime">Available start time *</label><select class="form-select" id="continuationTime">${open.map(row=>`<option value="${esc(row.startTime)}">${esc(row.startTime)}</option>`).join('')}</select>`:'No slots are available for this technician. Choose another technician or date.';}catch(error){if(ticket===sequence)slots.textContent=error.message;}
        };
      },
      preConfirm:async()=>{const time=document.getElementById('continuationTime')?.value;if(!verified||!time){Swal.showValidationMessage('Check availability and choose an available time.');return false;}try{return await api(`/api/work-continuations/${source}/${job._id}/schedule`,{...verified,startTime:time,requestId:job.continuation.requestId});}catch(error){Swal.showValidationMessage(error.message);return false;}},
    }).then(result=>{if(result.isConfirmed){loadQueue(root);window.location.reload();}});
  }
  window.RACSWorkContinuation={request,loadQueue};
  document.addEventListener('DOMContentLoaded',()=>document.querySelectorAll('[data-continuation-queue]').forEach(loadQueue));
})();
