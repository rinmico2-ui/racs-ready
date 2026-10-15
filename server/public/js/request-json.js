(function (root) {
  'use strict';
  function failure(message, status, payload) {
    var error = new Error(message);
    error.status = status || 0;
    error.code = payload && payload.code;
    error.fields = payload && payload.fields;
    return error;
  }
  function statusMessage(status) {
    if (status === 401) return 'Your session has expired. Please sign in again.';
    if (status === 403) return 'You do not have permission to perform this action.';
    if (status === 429) return 'Too many requests. Please wait a moment and try again.';
    if ([502, 503, 504].includes(status)) return 'The server is temporarily unavailable. Please try again shortly.';
    if (status >= 500) return 'The server could not complete this request. Please try again.';
    return 'The request could not be completed. Please try again.';
  }
  async function read(response) {
    var payload;
    try { payload = await response.json(); }
    catch (_) { throw failure(statusMessage(response.status), response.status); }
    if (!response.ok) {
      payload = payload || {};
      var message = response.status === 403 || response.status >= 500
        ? statusMessage(response.status)
        : typeof payload.error === 'string' ? payload.error : statusMessage(response.status);
      throw failure(message, response.status, payload);
    }
    if (!payload || typeof payload !== 'object') throw failure('The server returned an unexpected response. Please try again.', response.status);
    return payload;
  }
  async function request(url, options) {
    options = options || {};
    var controller = new AbortController();
    var external = options.signal;
    var timedOut = false;
    var abort = function () { controller.abort(); };
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', abort, { once: true });
    }
    var timer = setTimeout(function () { timedOut = true; controller.abort(); }, options.timeoutMs || 20000);
    try {
      var init = Object.assign({ credentials: 'same-origin' }, options, { signal: controller.signal });
      delete init.timeoutMs;
      return await read(await fetch(url, init));
    } catch (error) {
      if (timedOut) throw failure('This request took too long. Refresh to check its status before trying again.', 0);
      if (error.name === 'AbortError') throw error;
      if (error instanceof TypeError) throw failure('Unable to reach the server. Check your connection and try again.', 0);
      throw error;
    } finally {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', abort);
    }
  }
  root.RACSRequest = { json: request, read: read, statusMessage: statusMessage };
})(window);
