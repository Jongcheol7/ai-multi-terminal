const { randomUUID } = require('crypto');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const fs = require('fs');
const path = require('path');

// A browser connection observes a session; only explicit close ends its PTY.
function createSessionStore({ spawn, storageDirectory, windowsPty, createTerminal = options => new Terminal(options) }) {
  const sessions = new Map();
  const records = new Map();
  const snapshots = new Map();
  let persistenceError = '';
  let indexReadable = true;
  const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(id);
  if (storageDirectory) {
    try {
      const indexPath = path.join(storageDirectory, 'index.json');
      if (fs.existsSync(indexPath)) {
        const saved = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        if (!Array.isArray(saved)) throw new Error('세션 목록 형식이 올바르지 않습니다.');
        saved.forEach(record => {
          if (record && validId(record.id) && typeof record.cwd === 'string') records.set(record.id, { ...record, status: 'saved' });
        });
      }
    } catch (error) {
      indexReadable = false;
      persistenceError = `이전 세션 기록을 읽지 못했습니다. 원본은 보존했습니다: ${error.message}`;
    }
  }
  function writeJson(filename, value) {
    fs.mkdirSync(storageDirectory, { recursive: true });
    const target = path.join(storageDirectory, filename);
    fs.writeFileSync(target + '.tmp', JSON.stringify(value), 'utf8');
    fs.renameSync(target + '.tmp', target);
  }
  function persist(session) {
    if (!storageDirectory || !indexReadable) return;
    try {
      if (session && !session.closed) {
        writeJson(session.id + '.json', {
          cols: session.headless.cols, rows: session.headless.rows, windowsPty,
          snapshot: session.serializer.serialize({ scrollback: 1000 })
        });
      }
      writeJson('index.json', [...records.values()]);
      persistenceError = '';
    } catch (error) { persistenceError = `세션 기록 저장 실패: ${error.message}`; }
  }
  function snapshotFor(id) {
    if (snapshots.has(id)) return snapshots.get(id);
    if (storageDirectory) {
      const target = path.join(storageDirectory, id + '.json');
      if (fs.existsSync(target)) return JSON.parse(fs.readFileSync(target, 'utf8'));
    }
    return { cols: 120, rows: 30, snapshot: '' };
  }
  function list() {
    return {
      sessions: [...records.values()].map(record => ({
        ...record, status: sessions.has(record.id) ? (sessions.get(record.id).exited ? 'ended' : 'running') : 'saved'
      })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      error: persistenceError || undefined
    };
  }
  function rename(id, title) {
    const record = records.get(id);
    if (!record) throw new Error('세션을 찾을 수 없습니다.');
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 120) throw new Error('세션 이름을 1~120자로 입력해 주세요.');
    record.title = title.trim();
    record.updatedAt = new Date().toISOString();
    persist(sessions.get(id));
    if (sessions.has(id)) broadcast(sessions.get(id), { type: 'session-title', title: record.title });
    if (persistenceError) throw new Error(persistenceError);
    return record;
  }

  function send(ws, message) {
    if (ws.readyState !== 1) return;
    try { ws.send(JSON.stringify(message)); } catch (_) { /* disconnected observer */ }
  }

  function broadcast(session, message) {
    for (const client of session.clients) send(client, message);
  }

  function create(id, options) {
    const tool = ['claude', 'codex', 'agy'].includes(options.tool) ? options.tool : 'none';
    const headless = createTerminal({ cols: 120, rows: 30, scrollback: 5000, allowProposedApi: true, windowsPty });
    const serializer = new SerializeAddon();
    headless.loadAddon(serializer);
    let term;
    try {
      term = spawn(options.cwd);
    } catch (error) {
      headless.dispose();
      throw error;
    }
    const session = {
      id, pty: term, headless, serializer, tool, cwd: options.cwd,
      name: options.name || 'Terminal', clients: new Set(), exited: false,
      closed: false, startupTimer: null, dirty: false
    };
    sessions.set(id, session);
    const now = new Date().toISOString();
    records.set(id, {
      id, projectName: session.name, cwd: session.cwd, tool,
      title: options.title || `새 ${tool === 'none' ? 'Shell' : tool === 'agy' ? 'Antigravity' : tool === 'claude' ? 'Claude' : 'Codex'} 세션`,
      createdAt: now, updatedAt: now, status: 'running'
    });
    persist(session);

    term.onData(data => {
      if (session.closed) return;
      // Serialize and broadcast from the same parsed state, including pending output.
      headless.write(data, () => {
        if (!session.closed) {
          session.dirty = true;
          broadcast(session, { type: 'output', data });
        }
      });
    });
    term.onExit(event => {
      if (session.closed) return;
      session.exited = true;
      clearTimeout(session.startupTimer);
      headless.write('', () => {
        if (!session.closed) {
          records.get(id).status = 'ended';
          persist(session);
          broadcast(session, { type: 'exit', exitCode: event.exitCode });
        }
      });
    });

    if (tool !== 'none') {
      session.startupTimer = setTimeout(() => {
        if (session.closed || session.exited) return;
        // Keep the Windows console-window workaround in place.
        const command = tool === 'codex' ? 'codex --no-daemon --no-alt-screen' : tool;
        term.write(`${command}\r`);
      }, 500);
    }
    return session;
  }

  function connect(ws, options) {
    const id = options.id || randomUUID();
    if (!validId(id)) {
      send(ws, { type: 'session-error', message: '잘못된 세션 ID입니다.' });
      ws.close(1008);
      return;
    }
    let session = sessions.get(id);
    if (!session && records.has(id)) {
      try {
        const record = records.get(id);
        send(ws, { type: 'session', sessionId: id, name: record.projectName, cwd: record.cwd,
          tool: record.tool, title: record.title, exited: true, archived: true, ...snapshotFor(id) });
      } catch (error) { send(ws, { type: 'session-error', message: `세션 기록을 읽지 못했습니다: ${error.message}` }); }
      return;
    }
    if (!session && !options.create) {
      send(ws, { type: 'session-missing', message: '서버가 재시작되었거나 이 터미널이 종료되었습니다.' });
      ws.close(1008);
      return;
    }
    if (!session) {
      try { session = create(id, options); }
      catch (error) {
        send(ws, { type: 'session-error', message: `터미널을 열지 못했습니다: ${error.message}` });
        ws.close(1011);
        return;
      }
    }
    let attached = false;
    ws.on('close', () => {
      session.clients.delete(ws);
      if (!session.closed && !session.clients.size) headlessReady(session, () => { if (!session.closed) persist(session); });
    });
    ws.on('message', raw => {
      if (!attached || session.closed || session.closing || session.exited) return;
      try {
        const message = JSON.parse(raw);
        if (message.type === 'input' && typeof message.data === 'string') {
          session.pty.write(message.data);
          if (message.requestId || message.data.includes('\r')) records.get(id).updatedAt = new Date().toISOString();
          if (typeof message.requestId === 'string') send(ws, { type: 'input-ack', requestId: message.requestId });
        } else if (message.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
          const cols = Math.max(2, Math.min(500, message.cols));
          const rows = Math.max(2, Math.min(200, message.rows));
          session.headless.resize(cols, rows);
          session.pty.resize(cols, rows);
        }
      } catch (error) {
        send(ws, { type: 'operation-error', message: `터미널 입력 처리 실패: ${error.message}` });
      }
    });
    headlessReady(session, () => {
      if (ws.readyState !== 1 || session.closed) return;
      session.clients.add(ws);
      attached = true;
      send(ws, {
        type: 'session', sessionId: id, name: session.name, cwd: session.cwd,
        tool: session.tool, title: records.get(id).title, exited: session.exited,
        cols: session.headless.cols, rows: session.headless.rows, windowsPty,
        snapshot: session.serializer.serialize({ scrollback: 5000 })
      });
    });
    return session;
  }

  function headlessReady(session, callback) {
    session.headless.write('', callback);
  }

  async function close(id) {
    const session = sessions.get(id);
    if (!session) return;
    if (session.closing) return session.closing;
    session.closing = (async () => {
      await new Promise(resolve => session.headless.write('', resolve));
      const snapshot = { cols: session.headless.cols, rows: session.headless.rows, windowsPty, snapshot: session.serializer.serialize({ scrollback: 1000 }) };
      snapshots.set(id, snapshot);
      records.get(id).status = 'ended';
      records.get(id).updatedAt = new Date().toISOString();
      persist(session);
      if (storageDirectory && !persistenceError) snapshots.delete(id);
      session.closed = true;
      sessions.delete(id);
      clearTimeout(session.startupTimer);
      broadcast(session, { type: 'terminated' });
      for (const ws of session.clients) {
        try { ws.close(1000); } catch (_) { /* already closed */ }
      }
      session.clients.clear();
      if (!session.exited) {
        try { session.pty.kill(); } catch (_) { /* already exited */ }
      }
      session.headless.dispose();
    })();
    return session.closing;
  }

  async function remove(id) {
    if (!validId(id)) throw new Error('잘못된 세션 ID입니다.');
    await close(id);
    if (storageDirectory && indexReadable) {
      const filename = path.join(storageDirectory, id + '.json');
      if (fs.existsSync(filename)) fs.unlinkSync(filename);
    }
    records.delete(id);
    snapshots.delete(id);
    persist();
    if (persistenceError) throw new Error(persistenceError);
  }
  const checkpointTimer = storageDirectory ? setInterval(() => {
    for (const session of sessions.values()) {
      if (!session.dirty || session.closed) continue;
      session.dirty = false;
      persist(session);
    }
  }, 30000) : null;
  checkpointTimer?.unref();

  return { sessions, connect, close, list, rename, remove };
}

module.exports = { createSessionStore };
