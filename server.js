const express = require('express');
const expressWs = require('express-ws');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const { Terminal: HeadlessTerminal } = require('@xterm/headless');

const PORT = 3900;

const app = express();
expressWs(app);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '5mb' }));

// 클립보드 (빈 메모장) 단일 파일
const CLIPBOARD_DIR = path.join(__dirname, 'clipboard');
const CLIPBOARD_FILE = path.join(CLIPBOARD_DIR, 'clipboard.md');
const IMAGES_DIR = path.join(CLIPBOARD_DIR, 'images');
if (!fs.existsSync(CLIPBOARD_DIR)) {
  fs.mkdirSync(CLIPBOARD_DIR, { recursive: true });
}
if (!fs.existsSync(IMAGES_DIR)) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

app.get('/api/clipboard', (req, res) => {
  try {
    if (!fs.existsSync(CLIPBOARD_FILE)) {
      return res.json({ content: '', mtime: null, exists: false });
    }
    const content = fs.readFileSync(CLIPBOARD_FILE, 'utf8');
    const stat = fs.statSync(CLIPBOARD_FILE);
    res.json({ content, mtime: stat.mtime, exists: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clipboard/clear', (req, res) => {
  try {
    fs.writeFileSync(CLIPBOARD_FILE, '', 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 모달에서 편집 후 저장
app.post('/api/clipboard/write', (req, res) => {
  try {
    const content = (req.body && typeof req.body.content === 'string') ? req.body.content : '';
    fs.writeFileSync(CLIPBOARD_FILE, content, 'utf8');
    const stat = fs.statSync(CLIPBOARD_FILE);
    res.json({ ok: true, mtime: stat.mtime });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// composer 에서 이미지 paste 시 업로드 — 이진 raw body
app.post(
  '/api/upload-image',
  express.raw({
    type: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'],
    limit: '20mb'
  }),
  (req, res) => {
    try {
      if (!req.body || !req.body.length) {
        return res.status(400).json({ error: '이미지 데이터가 없습니다' });
      }
      const mime = (req.headers['content-type'] || 'image/png').toLowerCase();
      const ext = (mime.split('/')[1] || 'png').replace('jpeg', 'jpg');
      const ts = new Date();
      const pad = n => String(n).padStart(2, '0');
      const stamp = `${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}_${String(Date.now() % 1000).padStart(3, '0')}`;
      const filename = `img-${stamp}.${ext}`;
      const filepath = path.join(IMAGES_DIR, filename);
      fs.writeFileSync(filepath, req.body);
      res.json({
        ok: true,
        path: filepath,
        filename,
        size: req.body.length
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// 프리셋
const configPath = path.join(__dirname, 'config.json');
function loadConfig() {
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  return { presets: [] };
}
function saveConfig(config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}
app.get('/api/presets', (req, res) => {
  res.json(loadConfig().presets);
});
app.post('/api/presets', (req, res) => {
  const config = loadConfig();
  config.presets = req.body.presets;
  saveConfig(config);
  res.json({ ok: true });
});

// ========== 가상 터미널(헤드리스) 세션 관리 ==========
let nextSessionId = 1;
const sessions = new Map(); // sessionId → { pty, headless, tool }

// 마지막 사용자 프롬프트 다음부터 끝까지 추출
function captureLastResponse(headless, fallbackLines = 100) {
  const buf = headless.buffer.active;
  const total = buf.length;
  if (total === 0) return '';

  // 마지막 사용자 프롬프트 라인(`^\s*>\s+\S`) 위치 찾기
  // (claude 의 활성 박스 프롬프트 `│ > xyz │` 는 `│` 가 첫 글자라 매치 안 됨 → 의도대로)
  let startY = -1;
  const scanLimit = Math.min(total, 1000);
  for (let y = total - 1; y >= total - scanLimit; y--) {
    const line = buf.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    if (/^\s*>\s+\S/.test(text)) {
      startY = y + 1;
      break;
    }
  }

  if (startY === -1) {
    startY = Math.max(0, total - fallbackLines);
  }

  // 추출 — 폭 때문에 wrap 된 줄은 옆으로 이어붙이고, 진짜 \n 만 줄바꿈으로 보존
  //
  // 두 가지 wrap 감지 방식:
  //  1) line.isWrapped === true (자연 soft-wrap, 글자가 칸 끝에 닿아 자동 넘김)
  //  2) 휴리스틱: 직전 줄이 거의 full width 까지 채워졌고 다음 줄이 새 마커로 시작 안 하면 wrap
  //     ← Claude Code Ink TUI 처럼 각 시각줄을 \n 으로 끊어 출력하는 경우 isWrapped 가 안 잡힘
  // 안전망: 다음 줄이 `1.` `- ` 같은 마커로 시작하면 어떤 경우든 새 줄로 분리
  const startsWithMarker = (s) => {
    const t = s.trimStart();
    return /^([-*•▪◦]\s|\d+[.)]\s|#+\s|>\s?|\|)/.test(t);
  };
  // CJK(전각) 글자는 2 cells 차지 — 시각 길이 계산
  const visualLength = (s) => {
    let len = 0;
    for (const ch of s) {
      const code = ch.codePointAt(0);
      if ((code >= 0x1100 && code <= 0x115F) ||
          (code >= 0x2E80 && code <= 0x303E) ||
          (code >= 0x3041 && code <= 0x33FF) ||
          (code >= 0x3400 && code <= 0x4DBF) ||
          (code >= 0x4E00 && code <= 0x9FFF) ||
          (code >= 0xAC00 && code <= 0xD7A3) ||
          (code >= 0xF900 && code <= 0xFAFF) ||
          (code >= 0xFF00 && code <= 0xFF60)) {
        len += 2;
      } else {
        len += 1;
      }
    }
    return len;
  };
  const cols = headless.cols || 120;
  const lines = [];
  for (let y = startY; y < total; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    let mergeIntoPrev = false;
    if (lines.length > 0 && text.length > 0 && !startsWithMarker(text)) {
      const prev = lines[lines.length - 1];
      if (line.isWrapped) {
        mergeIntoPrev = true;
      } else if (prev.length > 0 && visualLength(prev) >= cols - 1) {
        // 직전 줄이 거의 끝까지 채워졌으면 휴리스틱으로 wrap 판정
        mergeIntoPrev = true;
      }
    }
    if (mergeIntoPrev) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }

  // 끝부분 정리: 빈 줄, 박스문자, claude 활성 입력박스, 상태 푸터 제거
  const isBottomNoise = (s) => {
    const t = s.trim();
    if (!t) return true;
    if (/^[╭╮╯╰─━│|]+$/.test(t)) return true;
    if (/^[│|]\s*>?\s*[│|]?$/.test(t)) return true;       // 빈 입력박스 한 줄
    if (/^\?\s+for\s+shortcuts/i.test(t)) return true;
    if (/^[⏵⏸◯◉●·*✻✦✧]/.test(t)) return true;            // 상태/사고 아이콘 시작
    if (/cooked\s+for\s+\d+\s*s/i.test(t)) return true;   // ✻ Cooked for 46s
    if (/cogitated\s+for\s+\d+\s*s/i.test(t)) return true;// ✻ Cogitated for 35s
    if (/thinking\s*\.{0,3}/i.test(t) && t.length < 30) return true;
    return false;
  };
  while (lines.length > 0 && isBottomNoise(lines[lines.length - 1])) {
    lines.pop();
  }

  // 줄 끝 trailing 공백/탭만 제거 (사용자 요구: 그 외엔 손대지 말 것)
  const cleaned = lines.map(line => line.replace(/[ \t]+$/, ''));

  return cleaned.join('\n');
}

app.post('/api/clipboard/capture', (req, res) => {
  const sid = String(req.body && req.body.sessionId || '');
  const fallbackLines = Number(req.body && req.body.fallbackLines) || 100;
  const sess = sessions.get(sid);
  if (!sess) return res.status(404).json({ error: '세션을 찾을 수 없습니다 (PTY 가 종료됐거나 잘못된 sessionId)' });
  try {
    const content = captureLastResponse(sess.headless, fallbackLines);
    res.json({ content, sessionId: sid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// WebSocket: 터미널 세션
app.ws('/ws/terminal', (ws, req) => {
  const sessionId = String(nextSessionId++);
  const cwd = req.query.cwd || process.cwd();
  let tool = (req.query.tool || '').toLowerCase();
  if (!tool && req.query.claude === 'true') tool = 'claude';

  const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
  const term = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: cwd,
    env: process.env
  });

  const headless = new HeadlessTerminal({
    cols: 120,
    rows: 30,
    scrollback: 5000,
    allowProposedApi: true
  });

  sessions.set(sessionId, { pty: term, headless, tool });

  // 클라이언트에 sessionId 알림
  try {
    ws.send(JSON.stringify({ type: 'session', sessionId }));
  } catch (e) { /* ignore */ }

  // claude / codex 자동 실행
  if (tool === 'claude' || tool === 'codex') {
    setTimeout(() => {
      const command = tool === 'codex' ? 'codex --no-alt-screen' : tool;
      term.write(`${command}\r`);
    }, 500);
  }

  term.onData((data) => {
    try { headless.write(data); } catch (e) { /* ignore */ }
    try { ws.send(JSON.stringify({ type: 'output', data })); } catch (e) { /* ws closed */ }
  });

  term.onExit(() => {
    try { ws.send(JSON.stringify({ type: 'exit' })); } catch (e) { /* ws closed */ }
  });

  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type === 'input') {
        term.write(parsed.data);
      } else if (parsed.type === 'resize') {
        term.resize(parsed.cols, parsed.rows);
        try { headless.resize(parsed.cols, parsed.rows); } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
  });

  ws.on('close', () => {
    sessions.delete(sessionId);
    try { term.kill(); } catch (e) { /* ignore */ }
    try { headless.dispose(); } catch (e) { /* ignore */ }
  });
});

const server = app.listen(PORT, () => {
  console.log(`Claude Terminal running at http://localhost:${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Close the existing server window or choose another port.`);
    process.exit(1);
  }
  throw err;
});
