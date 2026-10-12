(() => {
  const page = document.querySelector('.rr-page[data-booking-id]');
  const bookingId = page?.dataset.bookingId;
  const container = document.getElementById('relocationWorkOrder');
  const message = document.getElementById('relocationMessage');
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const show = (value, error = false) => { message.textContent = value; message.hidden = false; message.classList.toggle('is-error', error); };
  const browser = typeof window !== 'undefined' ? window : globalThis;
  const mapController = browser.RelocationWorkOrderMap?.createController({ L: browser.L, createLayer: browser.createEsriHybridLayer, fetch, document });
  let data;
  let loadSequence = 0;
  async function load() {
    const sequence = ++loadSequence;
    try {
      const response = await fetch(`/api/technician/relocation-work-order/${encodeURIComponent(bookingId)}`, { credentials: 'same-origin' });
      const result = await response.json().catch(() => ({ error: 'Could not load the work order. Refresh and try again.' }));
      if (sequence !== loadSequence) return;
      data = result;
      if (!response.ok) throw new Error(data.error || 'Could not load work order.');
      mapController?.clear();
      const editable = data.items.some(item => item.editable);
      container.innerHTML = `<div class="rr-panel rw-job-summary"><div><span class="rw-section-label">Booking</span><h2>${esc(data.bookingReference || 'Aircon relocation')}</h2></div><p class="rr-details">${editable ? 'Work through the steps below. Tick a task only after you finish it.' : ['completed', 'repair_completed'].includes(data.bookingStatus) ? 'This job is complete. Its recorded work is shown below.' : 'Accept and start this job in Assignments before recording work here.'}</p></div>` + data.items.map((item, itemIndex) => {
        const stages = item.stages || data.stages;
        const done = item.completedTasks || [];
        const total = stages.reduce((sum, stage) => sum + stage.tasks.length, 0);
        const activeStage = stages.findIndex(stage => stage.tasks.some(([key]) => !done.includes(stage.key + '.' + key)));
        const sameProperty = item.scope === 'same_property';
        const differentAddress = item.scope === 'custom_quote';
        const moveTitle = sameProperty ? 'Move within the same property' : differentAddress ? 'Move to another address' : 'Move type needs confirmation';
        const details = [item.brand, item.airconTypeName, item.hp ? item.hp + ' HP' : '', item.quantity > 1 ? item.quantity + ' units' : '', item.model].filter(Boolean);
        const missing = item.missingDetails || [];
        const currentLabel = sameProperty ? 'Current position' : 'Current address';
        const nextLabel = sameProperty ? 'New position' : 'New address';
        const currentText = sameProperty ? item.from?.details || 'Position needs confirmation' : item.from?.address || 'Address needs confirmation';
        const nextText = sameProperty ? item.to?.details || 'Position needs confirmation' : item.to?.address || 'Destination needs confirmation';
        return `<section class="rr-card rw-work-card"><div class="rr-card-head"><div><span class="rw-section-label">Aircon</span><h3>${esc(details.join(' / ') || item.name)}</h3>${item.serialNumber ? '<small>Serial ' + esc(item.serialNumber) + '</small>' : ''}</div><a class="rr-button rr-button-light" href="/technician/assignments?id=${encodeURIComponent(item.assignmentId || '')}">Open assigned job</a></div>
          <div class="rw-move-type"><i class="bi bi-geo-alt" aria-hidden="true"></i><strong>${moveTitle}</strong><span>${sameProperty ? 'A nearby move on the same property.' : differentAddress ? 'Remove here, then deliver and install at the new address.' : 'The move choice was not saved on this older booking.'}</span></div>
          <div class="rr-route"><div class="rr-location"><span>A &middot; ${currentLabel}</span><strong>${esc(currentText)}</strong><small>${esc(sameProperty ? item.from?.address || '' : item.from?.details || '')}</small></div><div class="rr-location"><span>B &middot; ${nextLabel}</span><strong>${esc(nextText)}</strong><small>${esc(sameProperty ? item.to?.address || '' : item.to?.details || '')}</small></div></div>
          ${missing.length ? '<aside class="rw-missing-details" role="note"><strong>Details to confirm with the admin or secretary</strong><p>This booking is missing:</p><ul>' + missing.map(detail => '<li>' + esc(detail) + '</li>').join('') + '</ul><p>Use the agreed move details before removing the aircon.</p></aside>' : ''}
          <details class="rw-map-details" open><summary>Location map</summary><section class="rw-map-section" aria-label="Map of aircon locations"><div class="rw-map-head"><h4>${sameProperty ? 'Property location' : 'Move locations'}</h4><div class="rw-map-legend"><span><i class="rw-map-dot" aria-hidden="true"></i>A &middot; Current location</span><span><i class="rw-map-dot is-destination" aria-hidden="true"></i>B &middot; New location</span></div></div><div class="rw-map" data-relocation-map="${itemIndex}"></div><p class="rw-map-status" data-relocation-map-status="${itemIndex}" role="status" aria-live="polite">${mapController ? 'Loading map...' : 'The map could not load. Your saved addresses are shown above.'}</p></section></details>
          <div class="rw-progress-head"><div><h4>Work steps</h4><p>${done.length} of ${total} tasks finished</p></div><span class="rr-badge">${activeStage < 0 ? 'Work checklist finished' : 'Step ' + (activeStage + 1) + ' of ' + stages.length}</span></div>
          <div class="rw-progress" role="progressbar" aria-label="Relocation checklist" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done.length}"><span style="width:${total ? Math.round(done.length / total * 100) : 0}%"></span></div>
          <div class="rw-work-steps">${stages.map((stage, index) => {
            const unlocked = index === 0 || stages.slice(0, index).every(previous => previous.tasks.every(([key]) => done.includes(previous.key + '.' + key)));
            const finished = stage.tasks.filter(([key]) => done.includes(stage.key + '.' + key)).length;
            const complete = finished === stage.tasks.length;
            const description = stage.key === 'transport' && sameProperty ? 'Protect the aircon and carry it to the agreed new position on this property.' : stage.description || '';
            return `<details class="rw-step${complete ? ' is-complete' : ''}" ${index === activeStage ? 'open' : ''}><summary><span class="rw-step-number">${complete ? '<i class="bi bi-check-lg" aria-hidden="true"></i>' : index + 1}</span><span class="rw-step-name">${esc(stage.label)}</span><span class="rw-step-count">${finished}/${stage.tasks.length}</span></summary><div class="rw-step-content"><p class="rr-details">${esc(description)}</p>${!unlocked ? '<p class="rw-step-lock">Finish the previous step to unlock these tasks.</p>' : ''}<div class="rw-task-list">${stage.tasks.map(([key, label]) => {
              const task = stage.key + '.' + key;
              return `<label class="rw-task${done.includes(task) ? ' is-done' : ''}"><input type="checkbox" data-item="${esc(item.id)}" data-task="${esc(task)}" ${done.includes(task) ? 'checked disabled' : !item.editable || !unlocked ? 'disabled' : ''}><span>${esc(label)}</span></label>`;
            }).join('')}</div></div></details>`;
          }).join('')}</div>
          ${activeStage < 0 ? '<div class="rw-finish-note"><i class="bi bi-check-circle" aria-hidden="true"></i><span>Checklist finished. Open the assigned job to handle any remaining payment and submit the completion photo.</span></div>' : ''}
        </section>`;
      }).join('');
      if (mapController) await Promise.all(data.items.map((item, index) => mapController.render(item,
        container.querySelector(`[data-relocation-map="${index}"]`), container.querySelector(`[data-relocation-map-status="${index}"]`))));
    } catch (error) { if (sequence !== loadSequence) return; mapController?.clear(); container.innerHTML = ''; show(error.message, true); }
  }
  container.addEventListener('change', async event => {
    const input = event.target.closest('input[data-task]');
    if (!input || !input.checked) return;
    input.disabled = true;
    try {
      const response = await fetch(`/api/technician/relocation-work-order/${encodeURIComponent(bookingId)}/items/${encodeURIComponent(input.dataset.item)}/tasks`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: input.dataset.task }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not save task.');
      show('Task saved. Continue with the next step.');
      await load();
    } catch (error) { input.checked = false; input.disabled = false; show(error.message, true); }
  });
  document.getElementById('relocationRefresh')?.addEventListener('click', load);
  container.addEventListener('toggle', event => {
    if (event.target.matches?.('.rw-map-details') && event.target.open) mapController?.resize();
  }, true);
  load();
})();
