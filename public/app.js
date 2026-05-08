(() => {
  const panelsEl = document.getElementById('panels');
  const termCountEl = document.getElementById('termCount');
  const panels = []; // { id, name, el, term, fitAddon, ws, minimized }
  let nextId = 1;
  let activePanel = null;

  function setActivePanel(panel) {
    activePanel = panel;
    panels.forEach(p => p.el.classList.toggle('active', p === panel));
  }

  // 시각적 wrap 으로 쪼개진 줄을 합쳐 논리 줄 단위로 선택영역 텍스트 재구성
  // 멀티/중간 줄은 줄 전체를 가져와서 wide(CJK) 문자가 컬럼 경계에서 잘리는 것 방지
  function getLogicalSelection(term) {
    const sel = term.getSelectionPosition && term.getSelectionPosition();
    if (!sel) return term.getSelection() || '';
    const buf = term.buffer.active;
    let result = '';
    const startY = sel.start.y;
    const endY = sel.end.y;
    for (let y = startY; y <= endY; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      let piece;
      if (startY === endY) {
        // 한 줄 안에서의 부분 선택
        piece = line.translateToString(true, sel.start.x, sel.end.x);
      } else if (y === startY) {
        piece = line.translateToString(true, sel.start.x);
      } else if (y === endY) {
        piece = line.translateToString(true, 0, sel.end.x);
      } else {
        // 중간 줄은 전체 (wide char 경계 문제 회피)
        piece = line.translateToString(true);
      }
      result += piece;
      if (y < endY) {
        const next = buf.getLine(y + 1);
        if (next && !next.isWrapped) result += '\n';
      }
    }
    return result;
  }

  // ========== Preset ==========
  async function loadPresets() {
    const res = await fetch('/api/presets');
    return res.json();
  }

  async function savePresets(presets) {
    await fetch('/api/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presets })
    });
  }

  // Preset dropdown
  const btnPreset = document.getElementById('btnPreset');
  const presetMenu = document.getElementById('presetMenu');

  btnPreset.addEventListener('click', async (e) => {
    e.stopPropagation();
    const presets = await loadPresets();
    presetMenu.innerHTML = '';
    if (presets.length === 0) {
      presetMenu.innerHTML = '<div class="preset-item" style="color:var(--text-dim)">No presets configured</div>';
    } else {
      presets.forEach(p => {
        const item = document.createElement('div');
        item.className = 'preset-item';
        item.innerHTML = `<span>${p.name}</span><span class="path">click to choose</span>`;
        item.title = p.cwd;
        item.addEventListener('click', () => {
          presetMenu.classList.add('hidden');
          openToolChoice(p);
        });
        presetMenu.appendChild(item);
      });
    }
    presetMenu.classList.toggle('hidden');
  });

  document.addEventListener('click', () => presetMenu.classList.add('hidden'));

  // ========== Tool Choice Popup ==========
  const toolChoiceModal = document.getElementById('toolChoiceModal');
  const toolChoicePresetName = document.getElementById('toolChoicePresetName');
  let pendingPreset = null;

  function openToolChoice(preset) {
    pendingPreset = preset;
    toolChoicePresetName.textContent = preset.name;
    toolChoiceModal.classList.remove('hidden');
  }

  toolChoiceModal.querySelectorAll('.tool-choice-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool;
      if (pendingPreset) {
        addTerminal(pendingPreset.name, pendingPreset.cwd, tool);
      }
      pendingPreset = null;
      toolChoiceModal.classList.add('hidden');
    });
  });

  document.getElementById('btnCancelToolChoice').addEventListener('click', () => {
    pendingPreset = null;
    toolChoiceModal.classList.add('hidden');
  });

  // 배경 클릭 닫기 — 단, 드래그가 모달 내부에서 시작된 경우는 닫지 않음
  function setupModalBackgroundClose(modal, onClose) {
    let mouseDownOnBackground = false;
    modal.addEventListener('mousedown', (e) => {
      mouseDownOnBackground = (e.target === modal);
    });
    modal.addEventListener('click', (e) => {
      if (e.target === modal && mouseDownOnBackground) {
        if (onClose) onClose();
        else modal.classList.add('hidden');
      }
      mouseDownOnBackground = false;
    });
  }
  setupModalBackgroundClose(toolChoiceModal, () => {
    pendingPreset = null;
    toolChoiceModal.classList.add('hidden');
  });

  // ========== Terminal Panel ==========
  function addTerminal(name, cwd, tool) {
    const id = nextId++;
    name = name || `Terminal ${id}`;
    cwd = cwd || 'D:\\kccfw\\workspace_kerp';
    // 하위호환: boolean(true)=claude, boolean(false)/undefined=none
    if (tool === true) tool = 'claude';
    else if (tool === false || tool == null) tool = 'none';

    // Panel element
    const panelEl = document.createElement('div');
    panelEl.className = 'panel';
    panelEl.dataset.id = id;
    panelEl.style.flex = '1 1 0';
    panelEl.innerHTML = `
      <div class="panel-header">
        <span class="panel-title">${name}</span>
        <div class="panel-actions">
          <button class="panel-btn capture" title="마지막 답변 캡처 → 클립보드 모달">📥</button>
          <button class="panel-btn move-left" title="왼쪽으로 이동">◀</button>
          <button class="panel-btn move-right" title="오른쪽으로 이동">▶</button>
          <button class="panel-btn minimize" title="최소화">─</button>
          <button class="panel-btn close" title="닫기">✕</button>
        </div>
      </div>
      <div class="panel-body" id="term-${id}"></div>
      <div class="panel-composer-resize" title="드래그하여 composer 높이 조절"></div>
      <div class="panel-composer">
        <textarea class="panel-composer-input" placeholder="여러 줄 입력 후 Ctrl+Enter — 이 터미널로 전송 (이미지 paste 가능)"></textarea>
        <button class="btn btn-primary panel-composer-send" title="이 터미널로 전송 (Ctrl+Enter)">Send</button>
      </div>
    `;
    panelsEl.appendChild(panelEl);

    // xterm
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'Cascadia Code', Consolas, 'Courier New', monospace",
      scrollback: 10000,
      theme: {
        background: '#0f0f23',
        foreground: '#e0e0e0',
        cursor: '#e94560',
        selectionBackground: '#2a2a4a'
      },
      allowProposedApi: true
    });

    const fitAddon = new FitAddon.FitAddon();
    const webLinksAddon = new WebLinksAddon.WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(document.getElementById(`term-${id}`));

    // Ctrl+V 붙여넣기 / Ctrl+C 복사 (선택영역 있을 때만)
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard.readText().then(text => {
          if (!text) return;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input', data: text }));
          }
        }).catch(() => {});
        return false;
      }
      if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
        const sel = getLogicalSelection(term);
        if (sel && sel.length > 0) {
          // Windows 클립보드는 \r\n 기대 — 정규화
          const text = sel.replace(/\r\n/g, '\n').replace(/\r/g, '').replace(/\n/g, '\r\n');
          navigator.clipboard.writeText(text).catch(() => {});
          term.clearSelection();
          return false;
        }
      }
      return true;
    });

    // 우클릭 붙여넣기
    document.getElementById(`term-${id}`).addEventListener('contextmenu', (e) => {
      e.preventDefault();
      navigator.clipboard.readText().then(text => {
        if (!text) return;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data: text }));
        }
      }).catch(() => {});
    });

    setTimeout(() => fitAddon.fit(), 50);

    // WebSocket with auto-reconnect
    const wsUrl = `ws://${location.host}/ws/terminal?cwd=${encodeURIComponent(cwd)}&tool=${encodeURIComponent(tool)}`;
    let ws = null;
    let inputDisposable = null;

    function connectWs(isReconnect) {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        if (isReconnect) {
          term.write('\r\n\x1b[32m[Reconnected - new session]\x1b[0m\r\n');
        }
        // 기존 입력 핸들러 제거 후 재등록
        if (inputDisposable) inputDisposable.dispose();
        inputDisposable = term.onData(data => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input', data }));
          }
        });
        setTimeout(() => {
          fitAddon.fit();
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }, 100);
      };

      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'output') {
          term.write(msg.data);
        } else if (msg.type === 'session') {
          panel.sessionId = msg.sessionId;
        } else if (msg.type === 'exit') {
          term.write('\r\n\x1b[31m[Session ended]\x1b[0m\r\n');
        }
      };

      ws.onclose = () => {
        term.write('\r\n\x1b[33m[Disconnected - reconnecting...]\x1b[0m\r\n');
        // 3초 후 재연결 시도, 반복
        setTimeout(() => connectWs(true), 3000);
      };
    }

    connectWs(false);

    const panel = { id, name, el: panelEl, term, fitAddon, get ws() { return ws; }, minimized: false, sessionId: null, resizeObserver: null };
    panels.push(panel);

    // 레이아웃 완료/패널 크기 변화 시마다 자동 refit + PTY resize 송신
    // (초기 cols 계산이 DOM 미완성 상태에서 어긋나 우측 잘림이 발생하는 문제 해결)
    let lastCols = 0, lastRows = 0;
    panel.resizeObserver = new ResizeObserver(() => {
      if (panel.minimized) return;
      try {
        panel.fitAddon.fit();
        if (panel.term.cols !== lastCols || panel.term.rows !== lastRows) {
          lastCols = panel.term.cols; lastRows = panel.term.rows;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', cols: panel.term.cols, rows: panel.term.rows }));
          }
        }
      } catch (e) { /* ignore */ }
    });
    panel.resizeObserver.observe(panelEl.querySelector('.panel-body'));

    // 최소화 버튼
    panelEl.querySelector('.minimize').addEventListener('click', () => toggleMinimize(panel));

    // 최소화 상태에서 헤더 클릭으로 복원
    panelEl.querySelector('.panel-header').addEventListener('click', (e) => {
      if (panel.minimized && !e.target.closest('.panel-btn')) {
        toggleMinimize(panel);
      }
    });

    // 닫기 버튼
    panelEl.querySelector('.close').addEventListener('click', () => removePanel(panel));

    // 좌/우 이동 버튼
    panelEl.querySelector('.move-left').addEventListener('click', (e) => {
      e.stopPropagation();
      movePanel(panel, -1);
    });
    panelEl.querySelector('.move-right').addEventListener('click', (e) => {
      e.stopPropagation();
      movePanel(panel, 1);
    });

    // 캡처 버튼
    panelEl.querySelector('.capture').addEventListener('click', (e) => {
      e.stopPropagation();
      captureFromPanel(panel);
    });

    // 패널별 composer
    const inputEl = panelEl.querySelector('.panel-composer-input');
    const sendBtn = panelEl.querySelector('.panel-composer-send');
    const composerResize = panelEl.querySelector('.panel-composer-resize');

    function sendThisPanel() {
      const text = inputEl.value;
      if (!text) return;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'input', data: '\x1b[200~' + text + '\x1b[201~' }));
      const hasAttachment = /(^|\s)@\S/.test(text);
      const longContent = text.length > 500;
      const delay = hasAttachment ? 500 : (longContent ? 300 : 200);
      setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data: '\r' }));
        }
      }, delay);
      inputEl.value = '';
      inputEl.focus();
    }

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        sendThisPanel();
      }
    });
    sendBtn.addEventListener('click', sendThisPanel);
    inputEl.addEventListener('focus', () => setActivePanel(panel));

    // 이미지 paste
    inputEl.addEventListener('paste', async (e) => {
      if (!e.clipboardData) return;
      const items = Array.from(e.clipboardData.items || []);
      const imgItem = items.find(it => it.kind === 'file' && it.type.startsWith('image/'));
      if (!imgItem) return;
      e.preventDefault();
      const blob = imgItem.getAsFile();
      if (!blob) return;
      const origPlaceholder = inputEl.placeholder;
      inputEl.placeholder = '📎 이미지 업로드 중...';
      try {
        const res = await fetch('/api/upload-image', {
          method: 'POST',
          headers: { 'Content-Type': imgItem.type },
          body: blob
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        insertAtCursor(inputEl, '@' + data.path);
        inputEl.placeholder = `📎 ${data.filename} 첨부됨`;
        setTimeout(() => { inputEl.placeholder = origPlaceholder; }, 2000);
      } catch (err) {
        inputEl.placeholder = '❌ 업로드 실패: ' + err.message;
        setTimeout(() => { inputEl.placeholder = origPlaceholder; }, 3000);
      }
    });

    // composer 높이 드래그 — 글로벌 CSS var 변경 (모든 패널 동시 변경)
    composerResize.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const cur = getComputedStyle(document.documentElement).getPropertyValue('--panel-composer-h').trim();
      const startH = parseInt(cur) || 100;
      composerResize.classList.add('active');
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';

      const onMove = (ev) => {
        const dy = startY - ev.clientY;
        const newH = Math.max(60, Math.min(window.innerHeight - 200, startH + dy));
        document.documentElement.style.setProperty('--panel-composer-h', newH + 'px');
        panels.forEach(p => { if (!p.minimized) p.fitAddon.fit(); });
      };
      const onUp = () => {
        composerResize.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        panels.forEach(p => {
          if (!p.minimized) {
            p.fitAddon.fit();
            if (p.ws.readyState === WebSocket.OPEN) {
              p.ws.send(JSON.stringify({ type: 'resize', cols: p.term.cols, rows: p.term.rows }));
            }
          }
        });
        const finalH = getComputedStyle(document.documentElement).getPropertyValue('--panel-composer-h').trim();
        try { localStorage.setItem('panelComposerHeight', finalH); } catch (_) {}
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // 활성 패널 표시 — xterm 은 자체 click 으로 포커스 처리하므로 term.focus() 호출 안 함
    // (panel 단위 click 리스너에서 term.focus 하면 textarea 클릭도 가로채서 입력 불가)
    panelEl.addEventListener('click', () => setActivePanel(panel));
    term.onSelectionChange(() => setActivePanel(panel));
    term.textarea && term.textarea.addEventListener('focus', () => setActivePanel(panel));

    updateCount();
    rebuildHandles();
    setActivePanel(panel);
    updateMoveButtons();

    return panel;
  }

  function movePanel(panel, dir) {
    const idx = panels.indexOf(panel);
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= panels.length) return;
    [panels[idx], panels[newIdx]] = [panels[newIdx], panels[idx]];
    rebuildHandles();
    updateMoveButtons();
    setTimeout(() => {
      panels.forEach(p => {
        if (!p.minimized) {
          p.fitAddon.fit();
          if (p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(JSON.stringify({ type: 'resize', cols: p.term.cols, rows: p.term.rows }));
          }
        }
      });
    }, 50);
  }

  function rebuildHandles() {
    // 기존 핸들 모두 제거
    panelsEl.querySelectorAll('.resize-handle').forEach(h => h.remove());
    // panels[] 순서대로 DOM 재배치 + 핸들 재삽입
    panels.forEach((p, i) => {
      if (i > 0) {
        const handle = document.createElement('div');
        handle.className = 'resize-handle';
        handle.dataset.leftPanelId = panels[i - 1].id;
        handle.dataset.rightPanelId = p.id;
        panelsEl.appendChild(handle);
        initResize(handle);
      }
      panelsEl.appendChild(p.el); // 기존 요소 이동
    });
  }

  function updateMoveButtons() {
    panels.forEach((p, i) => {
      const left = p.el.querySelector('.move-left');
      const right = p.el.querySelector('.move-right');
      if (left) left.style.visibility = (i === 0) ? 'hidden' : 'visible';
      if (right) right.style.visibility = (i === panels.length - 1) ? 'hidden' : 'visible';
    });
  }

  function toggleMinimize(panel) {
    panel.minimized = !panel.minimized;
    panel.el.classList.toggle('minimized', panel.minimized);
    const btn = panel.el.querySelector('.minimize');
    btn.textContent = panel.minimized ? '□' : '─';
    btn.title = panel.minimized ? '복원' : '최소화';

    if (!panel.minimized) {
      setTimeout(() => {
        panel.fitAddon.fit();
        if (panel.ws.readyState === WebSocket.OPEN) {
          panel.ws.send(JSON.stringify({ type: 'resize', cols: panel.term.cols, rows: panel.term.rows }));
        }
        panel.term.focus();
      }, 250);
    }
    recalcFlex();
  }

  function removePanel(panel) {
    if (panel.resizeObserver) {
      try { panel.resizeObserver.disconnect(); } catch (e) {}
    }
    if (panel.ws.readyState === WebSocket.OPEN) panel.ws.close();
    panel.term.dispose();

    const idx = panels.indexOf(panel);
    panel.el.remove();
    panels.splice(idx, 1);

    rebuildHandles();
    updateCount();
    updateMoveButtons();
    if (activePanel === panel) {
      setActivePanel(panels[Math.max(0, idx - 1)] || null);
    }
    recalcFlex();
  }

  function recalcFlex() {
    const expanded = panels.filter(p => !p.minimized);
    panels.forEach(p => {
      if (!p.minimized) {
        // 기존 flex-grow 비율 유지하되, 모든 확장 패널에 동등 기본값
        if (!p.el.style.flexGrow || p.el.style.flexGrow === '0') {
          p.el.style.flex = '1 1 0';
        }
      }
    });
    // refit all expanded
    setTimeout(() => {
      expanded.forEach(p => {
        p.fitAddon.fit();
        if (p.ws.readyState === WebSocket.OPEN) {
          p.ws.send(JSON.stringify({ type: 'resize', cols: p.term.cols, rows: p.term.rows }));
        }
      });
    }, 260);
  }

  function updateCount() {
    termCountEl.textContent = `${panels.length} terminal${panels.length !== 1 ? 's' : ''}`;
  }

  // ========== Resize Handle ==========
  function initResize(handle) {
    let startX, leftPanel, rightPanel, leftStart, rightStart, totalWidth;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const leftId = parseInt(handle.dataset.leftPanelId);
      const rightId = parseInt(handle.dataset.rightPanelId);
      leftPanel = panels.find(p => p.id === leftId);
      rightPanel = panels.find(p => p.id === rightId);
      if (!leftPanel || !rightPanel || leftPanel.minimized || rightPanel.minimized) return;

      startX = e.clientX;
      leftStart = leftPanel.el.offsetWidth;
      rightStart = rightPanel.el.offsetWidth;
      totalWidth = leftStart + rightStart;

      handle.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMove = (e) => {
        const dx = e.clientX - startX;
        let newLeft = leftStart + dx;
        let newRight = rightStart - dx;
        const minW = 200;
        if (newLeft < minW) { newLeft = minW; newRight = totalWidth - minW; }
        if (newRight < minW) { newRight = minW; newLeft = totalWidth - minW; }

        leftPanel.el.style.flex = `${newLeft} 1 0px`;
        rightPanel.el.style.flex = `${newRight} 1 0px`;
      };

      const onUp = () => {
        handle.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);

        // refit
        [leftPanel, rightPanel].forEach(p => {
          p.fitAddon.fit();
          if (p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(JSON.stringify({ type: 'resize', cols: p.term.cols, rows: p.term.rows }));
          }
        });
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ========== Add Terminal Button ==========
  document.getElementById('btnAddTerminal').addEventListener('click', () => {
    addTerminal();
  });

  // ========== Settings Modal ==========
  const settingsModal = document.getElementById('settingsModal');
  const presetListEl = document.getElementById('presetList');

  document.getElementById('btnSettings').addEventListener('click', async () => {
    const presets = await loadPresets();
    renderPresetEditor(presets);
    settingsModal.classList.remove('hidden');
  });

  document.getElementById('btnCloseModal').addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });

  document.getElementById('btnAddPreset').addEventListener('click', () => {
    const item = createPresetEditorItem({ name: '', cwd: '' });
    presetListEl.appendChild(item);
  });

  document.getElementById('btnSavePresets').addEventListener('click', async () => {
    const items = presetListEl.querySelectorAll('.preset-editor-item');
    const presets = [];
    items.forEach(item => {
      const name = item.querySelector('input[name="name"]').value.trim();
      const cwd = item.querySelector('input[name="cwd"]').value.trim();
      if (name && cwd) presets.push({ name, cwd });
    });
    await savePresets(presets);
    settingsModal.classList.add('hidden');
  });

  function renderPresetEditor(presets) {
    presetListEl.innerHTML = '';
    presets.forEach(p => {
      presetListEl.appendChild(createPresetEditorItem(p));
    });
  }

  function createPresetEditorItem(p) {
    const div = document.createElement('div');
    div.className = 'preset-editor-item';
    div.innerHTML = `
      <input name="name" placeholder="Name" value="${p.name || ''}">
      <input name="cwd" placeholder="Working directory path" value="${p.cwd || ''}">
      <button class="btn-remove" title="삭제">✕</button>
    `;
    div.querySelector('.btn-remove').addEventListener('click', () => div.remove());
    return div;
  }

  // ========== Window resize ==========
  window.addEventListener('resize', () => {
    panels.forEach(p => {
      if (!p.minimized) {
        p.fitAddon.fit();
        if (p.ws.readyState === WebSocket.OPEN) {
          p.ws.send(JSON.stringify({ type: 'resize', cols: p.term.cols, rows: p.term.rows }));
        }
      }
    });
  });

  // ========== Keyboard shortcut ==========
  document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+T: 새 터미널
    if (e.ctrlKey && e.shiftKey && e.key === 'T') {
      e.preventDefault();
      addTerminal();
    }
  });

  // ========== Per-panel composer 공용 유틸 ==========
  function insertAtCursor(textarea, text) {
    const start = textarea.selectionStart || 0;
    const end = textarea.selectionEnd || 0;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    const sep = (before && !/[\s]$/.test(before)) ? ' ' : '';
    const insert = sep + text + ' ';
    textarea.value = before + insert + after;
    const pos = start + insert.length;
    textarea.selectionStart = textarea.selectionEnd = pos;
    textarea.focus();
  }

  // 저장된 panel composer 높이 복원
  try {
    const savedH = localStorage.getItem('panelComposerHeight');
    if (savedH) document.documentElement.style.setProperty('--panel-composer-h', savedH);
  } catch (_) {}

  // ========== Clipboard Modal ==========
  const clipboardModal = document.getElementById('clipboardModal');
  const clipboardContent = document.getElementById('clipboardContent');
  const clipboardMtime = document.getElementById('clipboardMtime');

  function fmtMtime(iso) {
    if (!iso) return '(파일 없음)';
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    return `수정: ${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function flashBtn(btn, label, ms) {
    const orig = btn.textContent;
    btn.textContent = label;
    setTimeout(() => { btn.textContent = orig; }, ms || 1200);
  }

  async function loadClipboardFromFile() {
    try {
      const res = await fetch('/api/clipboard');
      const data = await res.json();
      clipboardContent.value = data.content || '';
      clipboardMtime.textContent = fmtMtime(data.mtime);
    } catch (err) {
      clipboardContent.value = `[로드 실패: ${err.message}]`;
      clipboardMtime.textContent = '';
    }
  }

  async function captureFromPanel(panel) {
    if (!panel.sessionId) {
      alert('세션 ID 가 아직 없습니다 (WebSocket 연결 직후일 수 있음, 잠시 후 다시 시도).');
      return;
    }
    try {
      const res = await fetch('/api/clipboard/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: panel.sessionId, fallbackLines: 100 })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      clipboardContent.value = data.content || '';
      clipboardMtime.textContent = `📥 ${panel.name} 에서 캡처됨 (저장 전)`;
      clipboardModal.classList.remove('hidden');
      // 위 끝 보여주기
      clipboardContent.scrollTop = 0;
    } catch (err) {
      alert('캡처 실패: ' + err.message);
    }
  }

  document.getElementById('btnClipboard').addEventListener('click', async () => {
    await loadClipboardFromFile();
    clipboardModal.classList.remove('hidden');
  });

  document.getElementById('btnClipboardClose').addEventListener('click', () => {
    clipboardModal.classList.add('hidden');
  });

  document.getElementById('btnClipboardReload').addEventListener('click', async () => {
    if (clipboardContent.value && !confirm('편집 중인 내용이 있습니다. 파일에서 다시 읽으면 사라집니다. 계속할까요?')) return;
    await loadClipboardFromFile();
  });

  document.getElementById('btnClipboardSave').addEventListener('click', async () => {
    const btn = document.getElementById('btnClipboardSave');
    try {
      const res = await fetch('/api/clipboard/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: clipboardContent.value })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      clipboardMtime.textContent = fmtMtime(data.mtime);
      flashBtn(btn, '✓ Saved');
    } catch (err) {
      alert('저장 실패: ' + err.message);
    }
  });

  document.getElementById('btnClipboardCopy').addEventListener('click', async () => {
    const text = clipboardContent.value;
    if (!text) return;
    const norm = text.replace(/\r\n/g, '\n').replace(/\r/g, '').replace(/\n/g, '\r\n');
    try {
      await navigator.clipboard.writeText(norm);
      flashBtn(document.getElementById('btnClipboardCopy'), '✓ Copied');
    } catch (err) {
      alert('복사 실패: ' + err.message);
    }
  });

  document.getElementById('btnClipboardClear').addEventListener('click', async () => {
    if (!confirm('clipboard.md 를 비우고 textarea 도 비웁니다. 계속할까요?')) return;
    try {
      await fetch('/api/clipboard/clear', { method: 'POST' });
      clipboardContent.value = '';
      clipboardMtime.textContent = '(비어있음)';
    } catch (err) {
      alert('비우기 실패: ' + err.message);
    }
  });

  setupModalBackgroundClose(clipboardModal);

})();
