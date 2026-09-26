const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const express = require('express');
const ejs = require('ejs');
const publicAssets = require('../middleware/publicAssets');
const read = relative => fs.readFileSync(path.join(__dirname, relative), 'utf8');

test('public JavaScript and CSS bypass session work, but uploads do not', async () => {
  const app = express();
  let sessionReads = 0;
  app.use(publicAssets(path.join(__dirname, '../public')));
  app.use((req, res) => { sessionReads++; res.status(401).send('Authentication required'); });
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const request = resource => new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: server.address().port, path: resource }, response => {
      let body = '';
      response.setEncoding('utf8'); response.on('data', value => { body += value; });
      response.on('end', () => resolve({ status: response.statusCode, body, headers: response.headers }));
    }).on('error', reject);
  });
  try {
    const script = await request('/js/performance.js');
    assert.equal(script.status, 200);
    assert.match(script.body, /optimizeMedia/);
    assert.ok(script.headers.etag);
    assert.equal((await request('/css/performance.css')).status, 200);
    assert.equal(sessionReads, 0);
    for (const resource of ['/uploads/gcash-receipts/example.jpg', '/uploads/repairs/example.jpg', '/js/%2e%2e/uploads/example.jpg']) {
      assert.equal((await request(resource)).status, 401);
    }
    assert.equal(sessionReads, 3);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('public-only static routing is mounted before session and user database middleware', () => {
  const source = read('../index.js');
  const assets = source.indexOf("require('./middleware/publicAssets')");
  assert.ok(assets >= 0);
  assert.ok(assets < source.indexOf('session({'));
  assert.ok(assets < source.indexOf('app.use(attachCurrentUser)'));
  assert.match(source, /requireBookingEvidenceAccess/);
  assert.doesNotMatch(read('../middleware/publicAssets.js'), /router\.use\(['"]\/uploads/);
});

function animationBrowser({ lite = false, reduced = false } = {}) {
  const source = read('../public/js/services-multi.js');
  const start = source.indexOf('let stopServiceRouteAnimation = null;');
  const end = source.indexOf('async function getActualRoute', start);
  const frames = new Map(), timers = new Map(), listeners = new Map();
  let nextId = 0;
  const context = {
    document: {
      hidden: false, documentElement: { classList: { contains: () => lite } },
      addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener: name => listeners.delete(name),
    },
    window: { matchMedia: () => ({ matches: reduced }) },
    requestAnimationFrame(callback) { const id = ++nextId; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  function line() {
    return { styles: [], events: {},
      setStyle(style) { this.styles.push(style); },
      once(name, callback) { this.events[name] = callback; },
      off(name) { delete this.events[name]; },
    };
  }
  return {
    context, frames, timers, listeners, line,
    animate: route => context.animateRoute(route),
    timer(delay) { const [id, timer] = [...timers].find(([, value]) => value.delay === delay); timers.delete(id); timer.callback(); },
    frame(time) { const [id, callback] = [...frames][0]; frames.delete(id); callback(time); },
  };
}

test('route animation cancels every frame and timer after three seconds', () => {
  const browser = animationBrowser();
  const line = browser.line();
  browser.animate(line); browser.timer(500); browser.frame(1000);
  assert.equal(browser.frames.size, 1);
  browser.timer(3000);
  assert.equal(browser.frames.size, 0);
  assert.equal(browser.timers.size, 0);
  assert.equal(browser.listeners.size, 0);
  assert.equal(line.styles.at(-1).dashArray, '');
});

test('replacing or removing a route stops its old animation', () => {
  const browser = animationBrowser();
  const first = browser.line(), second = browser.line();
  browser.animate(first); browser.timer(500); browser.frame(1000);
  browser.animate(second);
  assert.equal(browser.frames.size, 0);
  assert.equal(first.styles.at(-1).dashOffset, '');
  assert.equal(browser.timers.size, 2);
  second.events.remove();
  assert.equal(browser.timers.size, 0);
  assert.equal(browser.listeners.size, 0);
});

test('route effects stop in hidden tabs and respect reduced-motion and low-power devices', () => {
  const browser = animationBrowser();
  browser.animate(browser.line()); browser.timer(500);
  browser.context.document.hidden = true;
  browser.listeners.get('visibilitychange')();
  assert.equal(browser.frames.size, 0);
  assert.equal(browser.timers.size, 0);
  for (const options of [{ lite: true }, { reduced: true }]) {
    const quiet = animationBrowser(options);
    quiet.animate(quiet.line());
    assert.equal(quiet.frames.size, 0);
    assert.equal(quiet.timers.size, 0);
  }
});

test('staff polling skips hidden tabs and prevents overlapping refresh batches', () => {
  for (const name of ['admin', 'secretary', 'technician']) {
    const source = read('../views/partials/' + name + '-sidebar.ejs');
    assert.match(source, /if\(document\.hidden\|\|\w+\)return/);
    assert.doesNotThrow(() => ejs.compile(source));
    for (const match of source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
      if (!match[1].includes('<%')) assert.doesNotThrow(() => new vm.Script(match[1]));
    }
  }
  const dashboard = read('../views/pages/technician/techniciandashboard.ejs');
  assert.match(dashboard, /if\(document\.hidden\|\|dashboardRefreshRunning\)return/);
  assert.match(dashboard, /Promise\.allSettled\(\[loadDashboard/);
});
