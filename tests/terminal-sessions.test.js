const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Terminal } = require('@xterm/headless');
const { createSessionStore } = require('../terminal-sessions');
const fs = require('node:fs');
const path = require('node:path');

class Socket extends EventEmitter {
  readyState = 1;
  messages = [];
  send(raw) { const message = JSON.parse(raw); this.messages.push(message); this.emit('sent', message); }
  close() { if (this.readyState !== 1) return; this.readyState = 3; this.emit('close'); }
}
function received(ws, type) {
  const existing = ws.messages.find(message => message.type === type);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.off('sent', listener); reject(new Error(`Missing ${type}`)); }, 1500);
    const listener = message => {
      if (message.type !== type) return;
      clearTimeout(timeout); ws.off('sent', listener); resolve(message);
    };
    ws.on('sent', listener);
  });
}
function fixture(t, settings = {}) {
  const spawned = [];
  const store = createSessionStore({ ...settings, spawn(cwd) {
    const term = new EventEmitter();
    term.cwd = cwd; term.writes = []; term.kills = 0;
    term.write = data => term.writes.push(data);
    term.resize = (cols, rows) => { term.size = { cols, rows }; };
    term.kill = () => { term.kills++; term.emit('exit', { exitCode: 0 }); };
    term.onData = callback => term.on('data', callback);
    term.onExit = callback => term.on('exit', callback);
    spawned.push(term);
    return term;
  } });
  t.after(async () => { for (const id of [...store.sessions.keys()]) await store.close(id); });
  const options = { id: 'session-test-01', create: true, cwd: 'C:/project', name: '프로젝트', tool: 'none' };
  return { store, spawned, options };
}

test('disconnect and reconnect retain the same PTY and unseen output', async t => {
  const { store, spawned, options } = fixture(t);
  const first = new Socket();
  const session = store.connect(first, options);
  await received(first, 'session');
  first.close();
  assert.equal(spawned[0].kills, 0);
  assert.equal(store.sessions.size, 1);
  spawned[0].emit('data', '\x1b[32m연결이 끊긴 동안의 출력\x1b[0m');
  const second = new Socket();
  assert.equal(store.connect(second, { ...options, create: false }), session);
  const restored = await received(second, 'session');
  assert.match(restored.snapshot, /연결이 끊긴 동안의 출력/);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].kills, 0);
});

test('restoring a missing session never silently starts a new process', async t => {
  const { store, spawned, options } = fixture(t);
  const ws = new Socket();
  store.connect(ws, { ...options, create: false });
  assert.equal((await received(ws, 'session-missing')).type, 'session-missing');
  assert.equal(spawned.length, 0);
});

test('two connections to a new ID create only one PTY and both receive output', async t => {
  const { store, spawned, options } = fixture(t);
  const first = new Socket(), second = new Socket();
  store.connect(first, options);
  store.connect(second, options);
  await Promise.all([received(first, 'session'), received(second, 'session')]);
  spawned[0].emit('data', 'shared output');
  await Promise.all([received(first, 'output'), received(second, 'output')]);
  assert.equal(spawned.length, 1);
});

test('explicit close ends the PTY once and disconnects its observers', async t => {
  const { store, spawned, options } = fixture(t);
  const ws = new Socket();
  store.connect(ws, options);
  await received(ws, 'session');
  await store.close(options.id);
  await store.close(options.id);
  assert.equal(spawned[0].kills, 1);
  assert.equal(store.sessions.size, 0);
  assert.equal(ws.readyState, 3);
  assert.equal((await received(ws, 'terminated')).type, 'terminated');
});

test('exited sessions retain their screen and reject further input', async t => {
  const { store, spawned, options } = fixture(t);
  const ws = new Socket();
  store.connect(ws, options);
  await received(ws, 'session');
  spawned[0].emit('data', 'completed');
  spawned[0].emit('exit', { exitCode: 0 });
  await received(ws, 'exit');
  ws.close();
  const next = new Socket();
  store.connect(next, { ...options, create: false });
  const snapshot = await received(next, 'session');
  assert.equal(snapshot.exited, true);
  assert.match(snapshot.snapshot, /completed/);
  next.emit('message', JSON.stringify({ type: 'input', data: 'bad' }));
  assert.deepEqual(spawned[0].writes, []);
});

test('a submitted input gets an acknowledgement only after PTY write', async t => {
  const { store, spawned, options } = fixture(t);
  const ws = new Socket();
  store.connect(ws, options);
  await received(ws, 'session');
  ws.emit('message', JSON.stringify({ type: 'input', data: 'hello\r', requestId: 'message-1' }));
  assert.deepEqual(spawned[0].writes, ['hello\r']);
  assert.equal((await received(ws, 'input-ack')).requestId, 'message-1');
});

test('invalid input and dimensions do not corrupt or terminate a session', async t => {
  const { store, spawned, options } = fixture(t);
  const ws = new Socket();
  store.connect(ws, options);
  await received(ws, 'session');
  ws.emit('message', 'not JSON');
  await received(ws, 'operation-error');
  ws.emit('message', JSON.stringify({ type: 'resize', cols: 9999, rows: -5 }));
  assert.deepEqual(spawned[0].size, { cols: 500, rows: 2 });
  assert.equal(store.sessions.size, 1);
  assert.equal(spawned[0].kills, 0);
});

test('replay restores CJK text, colors, cursor and alternate-screen content', async t => {
  const { store, spawned, options } = fixture(t);
  const first = new Socket();
  const session = store.connect(first, options);
  await received(first, 'session');
  spawned[0].emit('data', '\x1b[31m한글 normal\x1b[0m\r\n\x1b[?1049h\x1b[2J\x1b[3;5H\x1b[32m대체 화면\x1b[0m\x1b[?2004h');
  await received(first, 'output');
  first.close();
  const next = new Socket();
  store.connect(next, { ...options, create: false });
  const replay = await received(next, 'session');
  const restored = new Terminal({ cols: replay.cols, rows: replay.rows, allowProposedApi: true });
  t.after(() => restored.dispose());
  await new Promise(resolve => restored.write(replay.snapshot, resolve));
  assert.equal(restored.buffer.active.type, 'alternate');
  assert.equal(restored.buffer.active.getLine(2).translateToString(true), '    대체 화면');
  assert.equal(restored.buffer.active.cursorX, session.headless.buffer.active.cursorX);
  assert.equal(restored.buffer.active.cursorY, session.headless.buffer.active.cursorY);
  assert.equal(restored.buffer.active.getLine(2).getCell(4).getFgColor(), 2);
  assert.equal(restored.modes.bracketedPasteMode, true);
  assert.match(restored.buffer.normal.getLine(0).translateToString(true), /한글 normal/);
});

test('closing flushes pending output and a new store opens saved history without spawning a PTY', async t => {
  const directory = fs.mkdtempSync(path.join(__dirname, '.session-test-'));
  const { store, spawned, options } = fixture(t, { storageDirectory: directory });
  const ws = new Socket(); store.connect(ws, options); await received(ws, 'session');
  store.rename(options.id, '저장한 세션 이름');
  spawned[0].emit('data', '종료 직전 한글 출력');
  await Promise.all([store.close(options.id), store.close(options.id)]);
  assert.equal(spawned[0].kills, 1);
  const restored = createSessionStore({ storageDirectory: directory, spawn() { throw new Error('Must not start a PTY'); } });
  const next = new Socket(); restored.connect(next, { ...options, create: false });
  const saved = await received(next, 'session');
  assert.equal(saved.archived, true);
  assert.equal(saved.title, '저장한 세션 이름');
  assert.match(saved.snapshot, /종료 직전 한글 출력/);
  await restored.remove(options.id);
  assert.equal(restored.list().sessions.length, 0);
  // Remove only the three known files in this test's own directory.
  for (const filename of ['index.json', options.id + '.json', 'index.json.tmp']) {
    const target = path.join(directory, filename);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }
  fs.rmdirSync(directory);
});
