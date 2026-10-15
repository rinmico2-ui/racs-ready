(function () {
  'use strict';
  var fileInput = document.getElementById('inventoryCsvFile');
  if (!fileInput) return;
  var review = document.getElementById('inventoryImportReview'), commit = document.getElementById('inventoryImportCommit');
  var errorBox = document.getElementById('inventoryImportError'), output = document.getElementById('inventoryImportPreview');
  var token = '', busy = false;
  function error(message) { errorBox.textContent = message; errorBox.hidden = !message; }
  function invalidate() { token = ''; commit.disabled = true; output.replaceChildren(); error(''); }
  fileInput.addEventListener('change', invalidate);
  function table(rows) {
    output.replaceChildren();
    var element = document.createElement('table'); element.className = 'table table-sm';
    var header = element.createTHead().insertRow(); ['Product / row', 'Variants', 'Result'].forEach(function (value) { var cell = document.createElement('th'); cell.textContent = value; header.appendChild(cell); });
    var body = element.createTBody();
    rows.forEach(function (entry) { var row = body.insertRow(); [entry.modelLine || 'Row ' + entry.row, entry.variants || '', entry.error || entry.message || 'Ready to import'].forEach(function (value) { row.insertCell().textContent = value; }); });
    var wrapper = document.createElement('div'); wrapper.className = 'table-responsive'; wrapper.appendChild(element); output.appendChild(wrapper);
  }
  async function submit(mode) {
    if (busy) return;
    var file = fileInput.files[0];
    if (!file || file.size > 1024 * 1024 || !/\.csv$/i.test(file.name)) { error('Choose a CSV file up to 1 MB.'); return; }
    busy = true; review.disabled = commit.disabled = true; fileInput.disabled = true; error('');
    var button = mode === 'preview' ? review : commit, original = button.textContent;
    button.textContent = mode === 'preview' ? 'Checking file…' : 'Importing…';
    try {
      var form = new FormData(); form.append('csv', file); if (token) form.append('previewToken', token);
      var data = await RACSRequest.json(window.InventoryImportConfig.api + '/import/' + mode, { method: 'POST', body: form, timeoutMs: 120000 });
      if (mode === 'preview') {
        token = data.previewToken || '';
        table((data.products || []).concat(data.errors || []));
        if (!token) error('Correct the errors in the file and review it again. No products were imported.');
      } else {
        token = ''; table(data.results || []);
        var note = document.createElement('p'); note.className = 'alert alert-info'; note.textContent = data.created + ' products imported. ' + data.failed + ' products need attention.'; output.prepend(note);
        var refresh = document.createElement('button'); refresh.className = 'btn btn-outline-primary'; refresh.type = 'button'; refresh.textContent = 'Refresh inventory'; refresh.addEventListener('click', function () { window.location.reload(); }); output.appendChild(refresh);
      }
    } catch (e) { error(e.message); if (mode === 'commit') token = ''; }
    finally { busy = false; fileInput.disabled = false; review.disabled = false; commit.disabled = !token; button.textContent = original; }
  }
  review.addEventListener('click', function () { submit('preview'); });
  commit.addEventListener('click', function () { if (token) submit('commit'); });
})();
