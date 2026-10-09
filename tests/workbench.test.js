const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { Terminal: HeadlessTerminal } = require('@xterm/headless');

const root = path.join(__dirname, '..', 'public');
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
async function fixture(t, saved = {}) {
  const errors = [], sockets = [], terminals = [], requests = [], timers = new Map();
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), {
    url: 'http://localhost:3900', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole
  });
  const w = dom.window, d = w.document;
  let now = 0, nextTimer = 1;
  w.setTimeout = (callback, delay = 0) => { const id = nextTimer++; timers.set(id, { at: now + delay, callback }); return id; };
  w.clearTimeout = id => timers.delete(id);
  w.setInterval = () => 0;
  w.requestAnimationFrame = callback => w.setTimeout(callback, 16);
  const tick = ms => {
    const until = now + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); now = next[1].at; next[1].callback();
    }
    now = until;
  };
  Object.defineProperties(w.HTMLElement.prototype, {
    clientWidth: { get() { return 800; } }, clientHeight: { get() { return 400; } }
  });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.ResizeObserver = class { observe() {} disconnect() {} };
  class Terminal {
    constructor(options) { this.options = options; this.cols = 80; this.rows = 24; this.output = ''; terminals.push(this); }
    loadAddon(addon) { addon.term = this; }
    open(body) { this.textarea = d.createElement('textarea'); this.textarea.className = 'xterm-helper-textarea'; body.append(this.textarea); }
    attachCustomKeyEventHandler() {} onData(callback) { this.input = callback; } onSelectionChange() {}
    write(data, callback) { this.output += data; callback?.(); }
    reset() { this.output = ''; } resize(cols, rows) { this.cols = cols; this.rows = rows; }
    focus() { this.textarea.focus(); } dispose() {} getSelection() { return ''; }
  }
  w.Terminal = Terminal;
  w.FitAddon = { FitAddon: class { fit() { this.term.resize(90, 25); } } };
  w.WebLinksAddon = { WebLinksAddon: class {} };
  w.WebSocket = class {
    static OPEN = 1; static CLOSED = 3;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.onclose?.(); }
    receive(data) { this.readyState = 1; this.onmessage?.({ data: JSON.stringify(data) }); }
  };
  const state = { sessions: [], failSave: false };
  w.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === '/api/presets' && options.method === 'POST' && state.failSave) return { ok: false, status: 500, json: async () => ({ error: 'disk full' }) };
    const body = url === '/api/presets' ? [{ name: '한글 프로젝트', cwd: 'C:/project' }]
      : url === '/api/sessions' ? { sessions: state.sessions } : { ok: true };
    return { ok: true, status: 200, json: async () => body };
  };
  Object.entries(saved).forEach(([key, value]) => w.localStorage.setItem('multiTerminal.v2.' + key, JSON.stringify(value)));
  w.eval(fs.readFileSync(path.join(root, 'ui.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(root, 'terminal-selection.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(root, 'app.js'), 'utf8'));
  await settle();
  t.after(async () => { await settle(); dom.window.close(); assert.deepEqual(errors, []); });
  const click = selector => { assert.ok(d.querySelector(selector), selector); d.querySelector(selector).click(); };
  const connect = (socket = sockets.at(-1)) => {
    const id = new URL(socket.url).searchParams.get('sessionId');
    socket.receive({ type: 'session', sessionId: id, title: '새 Shell 세션', cols: 120, rows: 30, snapshot: '복원된 화면' });
    return id;
  };
  return { w, d, sockets, terminals, requests, state, tick, click, connect };
}

test('restores a saved workspace and draft without creating another server session', async t => {
  const { d, sockets, connect, tick } = await fixture(t, {
    collapsedProjects: {}, workspace: { panels: [{ sessionId: 'saved-session-01', name: '프로젝트', cwd: 'C:/project', tool: 'none' }] },
    'draft.saved-session-01': '보관한 입력'
  });
  assert.equal(sockets.length, 1);
  assert.equal(new URL(sockets[0].url).searchParams.get('create'), '0');
  assert.equal(d.querySelector('.panel-composer-input').value, '보관한 입력');
  connect(); tick(150);
  assert.equal(d.querySelector('.panel-status').textContent, '연결됨');
  assert.equal(sockets[0].sent.filter(message => message.type === 'resize').length, 1);
});

test('coalesces resize events and reconnects a stale foreground connection to the same ID', async t => {
  const { w, d, sockets, connect, tick, click } = await fixture(t);
  click('#btnAddTerminal');
  const id = connect(); tick(150);
  const first = sockets[0];
  for (let i = 0; i < 20; i++) w.dispatchEvent(new w.Event('resize'));
  tick(150);
  assert.equal(first.sent.filter(message => message.type === 'resize').length, 1);
  w.dispatchEvent(new w.Event('focus'));
  assert.equal(first.sent.at(-1).type, 'ping');
  tick(7100);
  assert.equal(sockets.length, 2);
  assert.equal(new URL(sockets[1].url).searchParams.get('sessionId'), id);
  assert.equal(new URL(sockets[1].url).searchParams.get('create'), '0');
  connect(sockets[1]);
  assert.equal(d.querySelector('.panel-status').textContent, '연결됨');
});

test('keeps an unacknowledged draft after disconnect and does not resend it automatically', async t => {
  const { w, d, sockets, click, connect, tick } = await fixture(t);
  click('#btnAddTerminal'); const id = connect();
  const input = d.querySelector('.panel-composer-input');
  input.value = '한글 여러 줄\n작성한 내용'; input.dispatchEvent(new w.Event('input'));
  click('.panel-composer-send'); tick(250);
  assert.ok(sockets[0].sent.some(message => message.requestId));
  sockets[0].close(); tick(3100); connect();
  assert.equal(input.value, '한글 여러 줄\n작성한 내용');
  assert.equal(JSON.parse(w.localStorage.getItem('multiTerminal.v2.draft.' + id)), input.value);
  assert.equal(sockets[1].sent.filter(message => message.type === 'input').length, 0);
});

test('tab close detaches the screen without ending its terminal', async t => {
  const { d, sockets, requests, click, connect } = await fixture(t);
  click('#btnAddTerminal'); connect(); click('.session-tab-close');
  assert.equal(d.querySelectorAll('.panel').length, 0);
  assert.equal(sockets[0].readyState, 3);
  assert.equal(requests.filter(request => request.url.endsWith('/close')).length, 0);
});

test('failed preset saves retain edits and show an inline retry path', async t => {
  const { d, state, click } = await fixture(t);
  click('#btnSettings'); await settle();
  const input = d.querySelector('#presetList input[name="name"]'); input.value = '수정 내용';
  state.failSave = true; click('#btnSavePresets'); await settle();
  assert.equal(input.value, '수정 내용');
  assert.equal(d.querySelector('#settingsModal').classList.contains('hidden'), false);
  assert.match(d.querySelector('#settingsError').textContent, /disk full/);
  assert.equal(d.querySelector('#btnSavePresets').disabled, false);
  state.failSave = false; click('#btnSavePresets'); await settle();
  assert.equal(d.querySelector('#settingsModal').classList.contains('hidden'), true);
});

test('lists project sessions and opens them through the command palette', async t => {
  const { w, d, state, sockets, click } = await fixture(t);
  state.sessions = [{ id: 'named-session-01', projectName: '한글 프로젝트', cwd: 'C:/project', tool: 'claude', title: '화면 크기 수정', status: 'running', updatedAt: new Date().toISOString() }];
  click('#btnRefreshSessions'); await settle();
  assert.match(d.querySelector('#projectResults').textContent, /화면 크기 수정/);
  click('#btnCommands');
  const search = d.querySelector('#commandSearch'); search.value = '화면 크기 수정'; search.dispatchEvent(new w.Event('input'));
  click('.command-option');
  assert.equal(new URL(sockets[0].url).searchParams.get('sessionId'), 'named-session-01');
  assert.equal(new URL(sockets[0].url).searchParams.get('create'), '0');
});

test('restoring ConPTY mouse tracking keeps wheel reports in SGR format, including wide terminals', async t => {
  const { sockets, terminals, click } = await fixture(t);
  click('#btnAddTerminal');
  sockets[0].receive({
    type: 'session', sessionId: 'mouse-session-01', cols: 300, rows: 40,
    windowsPty: { backend: 'conpty', buildNumber: 26100 },
    snapshot: '\x1b[?1049h마우스 복원\x1b[?1003h\x1b[?2004h'
  });
  const restored = new HeadlessTerminal({ cols: 300, rows: 40, allowProposedApi: true });
  t.after(() => restored.dispose());
  await new Promise(resolve => restored.write(terminals[0].output, resolve));
  const reports = [];
  restored.onData(data => reports.push(data));
  // The public API has no synthetic mouse input; use the pinned engine here
  // to verify the actual wire report, not just the presence of an escape code.
  restored._core.coreMouseService.triggerMouseEvent({
    col: 250, row: 5, x: 2000, y: 80, button: 4, action: 0,
    ctrl: false, alt: false, shift: false
  });
  assert.equal(reports.join(''), '\x1b[<64;251;6M');
  assert.equal(restored.modes.bracketedPasteMode, true);
  assert.equal(restored.buffer.active.type, 'alternate');
});
