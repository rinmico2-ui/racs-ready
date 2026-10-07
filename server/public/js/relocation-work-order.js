(() => {
  const page = document.querySelector('.rr-page[data-booking-id]');
  const bookingId = page?.dataset.bookingId;
  const container = document.getElementById('relocationWorkOrder');
  const message = document.getElementById('relocationMessage');
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const show = (value, error = false) => { message.textContent = value; message.hidden = false; message.classList.toggle('is-error', error); };
  let data;
  async function load() {
    try {
      const response = await fetch(`/api/technician/relocation-work-order/${encodeURIComponent(bookingId)}`, { credentials: 'same-origin' });
      data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load work order.');
      const editable = data.assignmentStatus === 'in_progress';
      container.innerHTML = `<div class="rr-panel"><h2>${esc(data.bookingReference || 'Relocation work order')}</h2><p class="rr-details">${editable ? 'Mark tasks as you complete them.' : 'Start the assigned job to record task progress.'}</p></div>` + data.items.map(item => {
        const done = item.completedTasks || [];
        return `<section class="rr-card"><div class="rr-card-head"><div><h3>${esc(item.name)}</h3><small>${esc(item.brand || '')}${item.model ? ` · ${esc(item.model)}` : ''}${item.serialNumber ? ` · Serial ${esc(item.serialNumber)}` : ''}</small></div><span class="rr-badge">${done.length}/${data.stages.reduce((sum, stage) => sum + stage.tasks.length, 0)} tasks</span></div>
          <div class="rr-route"><div class="rr-location"><span>From</span><strong>${esc(item.from?.address)}</strong><small>${esc(item.from?.details || '')}</small></div><div class="rr-location"><span>To</span><strong>${esc(item.to?.address)}</strong><small>${esc(item.to?.details || '')}</small></div></div>
          ${data.stages.map((stage, index) => {
            const unlocked = index === 0 || data.stages.slice(0, index).every(previous => previous.tasks.every(([key]) => done.includes(`${previous.key}.${key}`)));
            return `<div class="rr-quote"><p class="rr-quote-title">${index + 1}. ${esc(stage.label)}</p>${stage.tasks.map(([key, label]) => {
              const task = `${stage.key}.${key}`;
              return `<label class="rr-quote-row" style="justify-content:flex-start;align-items:center;gap:9px"><input type="checkbox" data-item="${esc(item.id)}" data-task="${esc(task)}" ${done.includes(task) ? 'checked disabled' : !editable || !unlocked ? 'disabled' : ''}><span>${esc(label)}</span></label>`;
            }).join('')}</div>`;
          }).join('')}
        </section>`;
      }).join('');
    } catch (error) { container.innerHTML = ''; show(error.message, true); }
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
  load();
})();
