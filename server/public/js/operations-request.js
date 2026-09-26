(function(root) {
  'use strict';
  root.operationsFetchJson = async function(url, options) {
    options = options || {};
    var controller = new AbortController();
    var signal = options.signal;
    var timedOut = false;
    var abort = function() { controller.abort(); };
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    var timer = setTimeout(function() { timedOut = true; controller.abort(); }, options.timeoutMs || 15000);
    try {
      var response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      var data;
      try { data = await response.json(); }
      catch (error) {
        if (controller.signal.aborted) throw error;
        throw new Error('Could not read the response. Refresh the page and try again.');
      }
      if (!response.ok) throw new Error(data.error || 'Could not load this record. Please try again.');
      return data;
    } catch (error) {
      if (timedOut) throw new Error('Loading took too long. Please try again.');
      throw error;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
    }
  };
})(window);
