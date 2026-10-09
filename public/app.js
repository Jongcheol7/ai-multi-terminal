(() => {
  const ui = window.TerminalUI;
  const panelsEl = document.getElementById('panels');
  const termCountEl = document.getElementById('termCount');
  const panels = []; // { id, name, el, term, fitAddon, ws, minimized }
  let nextId = 1;
  let activePanel = null;
  let layoutMode = ui.read('layout', 'columns') === 'grid' ? 'grid' : 'columns';
  let focusMode = false;
  let pageLeaving = false;
  let sessionRecords = [];
  let sidebarMode = ui.read('sidebarMode', 'sessions');
  const savedCollapsedProjects = ui.read('collapsedProjects', []);
  const collapsedProjects = new Set(Array.isArray(savedCollapsedProjects) ? savedCollapsedProjects : []);
  const toolNames = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity', none: 'Shell' };
  const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

  function saveWorkspace() {
    ui.write('workspace', {
      active: activePanel?.sessionId,
      panels: panels.filter(p => !p.closed).map(p => ({
        sessionId: p.sessionId, name: p.name, title: p.title, autoTitle: p.autoTitle, cwd: p.cwd, tool: p.tool,
        minimized: p.minimized, flex: p.el.style.flex, creating: p.createAllowed
      }))
    });
  }

    function fitPanel(panel) {
    clearTimeout(panel.fitTimer);
    panel.fitTimer = setTimeout(() => {
      if (panel.closed || panel.restoring || panel.selection?.held || panel.minimized || panel.el.classList.contains('focus-hidden')) return;
      const body = panel.el.querySelector('.panel-body');
      if (!body.clientWidth || !body.clientHeight) return;
      try {
        panel.fitAddon.fit();
        const cols = panel.term.cols, rows = panel.term.rows;
        if (panel.ready && panel.ws?.readyState === WebSocket.OPEN && (panel.sentCols !== cols || panel.sentRows !== rows)) {
          panel.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
          panel.sentCols = cols;
          panel.sentRows = rows;
        }
      } catch (_) { /* panel is being disposed */ }
    }, 90);
  }

  function applyLayout() {
    panelsEl.classList.toggle('layout-grid', layoutMode === 'grid' && !focusMode);
    panelsEl.classList.toggle('layout-focus', focusMode);
    panels.forEach(p => p.el.classList.toggle('focus-hidden', focusMode && p !== activePanel));
    document.getElementById('btnLayoutColumns').setAttribute('aria-pressed', String(layoutMode === 'columns' && !focusMode));
    document.getElementById('btnLayoutGrid').setAttribute('aria-pressed', String(layoutMode === 'grid' && !focusMode));
    document.getElementById('btnLayoutFocus').setAttribute('aria-pressed', String(focusMode));
    rebuildHandles();
    requestAnimationFrame(() => panels.forEach(fitPanel));
  }

  function setActivePanel(panel) {
    activePanel = panel;
    panels.forEach(p => p.el.classList.toggle('active', p === panel));
    document.querySelectorAll('.session-tab').forEach(tab => {
      const selected = Number(tab.dataset.id) === panel?.id;
      tab.classList.toggle('active', selected);
      tab.querySelector('[role="tab"]').setAttribute('aria-selected', String(selected));
    });
    document.getElementById('activeSessionLabel').textContent = panel ? `${panel.name} · ${toolNames[panel.tool]}` : '';
    if (focusMode) applyLayout();
    document.querySelectorAll('.sidebar-session').forEach(row => row.classList.toggle('active', row.dataset.sessionId === panel?.sessionId));
    updateStatusBar();
    saveWorkspace();
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
    const presets = await ui.request('/api/presets');
    if (!Array.isArray(presets)) throw new Error('프리셋 목록 형식이 올바르지 않습니다.');
    return presets;
  }

  async function savePresets(presets) {
    await ui.request('/api/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presets })
    });
  }

  // Preset dropdown
  const btnPreset = document.getElementById('btnPreset');
  const presetMenu = document.getElementById('presetMenu');
  const presetSearch = document.getElementById('presetSearch');
  const presetResults = document.getElementById('presetResults');
  let presetCache = [];
  const presetKey = p => JSON.stringify([p.name, p.cwd.toLowerCase()]);
  let favoriteKeys = ui.read('favorites', []);
  let recentKeys = ui.read('recentPresets', []);
  if (!Array.isArray(favoriteKeys)) favoriteKeys = [];
  if (!Array.isArray(recentKeys)) recentKeys = [];

  function closePresetMenu() {
    presetMenu.classList.add('hidden');
    btnPreset.setAttribute('aria-expanded', 'false');
  }
  function renderPresetMenu() { renderPresetList(presetResults, presetSearch.value); }
  function sessionProjectKeys() {
    return [...new Set([...presetCache, ...sessionRecords].map(project => project.cwd.toLowerCase()))];
  }
  function renderProjectSidebar() {
    document.getElementById('btnToggleSessionGroups').classList.toggle('hidden', sidebarMode !== 'sessions');
    if (sidebarMode === 'projects') renderPresetList(document.getElementById('projectResults'), document.getElementById('projectSearch').value, true);
    else renderSessionSidebar();
  }
  function renderSessionSidebar() {
    const target = document.getElementById('projectResults');
    const scrollTop = target.scrollTop;
    const focused = document.activeElement;
    const focusedSession = focused?.closest('.sidebar-session')?.dataset.sessionId;
    const focusedMenu = focused?.classList.contains('session-menu-button');
    const query = document.getElementById('projectSearch').value.trim().toLocaleLowerCase();
    const groups = new Map();
    presetCache.forEach(p => groups.set(p.cwd.toLowerCase(), { ...p, records: [] }));
    sessionRecords.forEach(record => {
      const key = record.cwd.toLowerCase();
      if (!groups.has(key)) groups.set(key, { name: record.projectName, cwd: record.cwd, records: [] });
      groups.get(key).records.push(record);
    });
    const allCollapsed = !query && groups.size > 0 && [...groups.keys()].every(key => collapsedProjects.has(key));
    const toggleGroups = document.getElementById('btnToggleSessionGroups');
    toggleGroups.disabled = groups.size === 0;
    toggleGroups.textContent = allCollapsed ? '모두 펼치기' : '모두 접기';
    toggleGroups.title = allCollapsed ? '모든 프로젝트 펼치기' : query ? '검색을 지우고 모든 프로젝트 접기' : '모든 프로젝트 접기';
    target.replaceChildren();
    const ordered = [...groups.values()].sort((a, b) => {
      const favorite = Number(favoriteKeys.includes(presetKey(b))) - Number(favoriteKeys.includes(presetKey(a)));
      if (favorite) return favorite;
      return (b.records[0]?.updatedAt || '').localeCompare(a.records[0]?.updatedAt || '');
    });
    ordered.forEach(project => {
      const projectMatch = `${project.name} ${project.cwd}`.toLocaleLowerCase().includes(query);
      const records = project.records.filter(record => projectMatch || record.title.toLocaleLowerCase().includes(query));
      if (query && !projectMatch && !records.length) return;
      const key = project.cwd.toLowerCase();
      const section = document.createElement('section');
      section.className = 'session-project';
      const header = document.createElement('div');
      header.className = 'session-project-heading';
      const collapse = document.createElement('button');
      const isCollapsed = !query && collapsedProjects.has(key);
      collapse.className = 'session-project-toggle';
      collapse.textContent = `${isCollapsed ? '›' : '⌄'} ${project.name}`;
      collapse.title = project.cwd;
      collapse.setAttribute('aria-expanded', String(!isCollapsed));
      collapse.onclick = () => {
        if (collapsedProjects.has(key)) collapsedProjects.delete(key); else collapsedProjects.add(key);
        ui.write('collapsedProjects', [...collapsedProjects]);
        renderSessionSidebar();
      };
      const add = document.createElement('button');
      add.className = 'panel-btn'; add.textContent = '+';
      add.setAttribute('aria-label', `${project.name} 새 세션`);
      add.onclick = () => openToolChoice(project);
      header.append(collapse, add);
      section.appendChild(header);
      if (!isCollapsed) records.forEach(record => {
        const row = document.createElement('div');
        row.className = 'sidebar-session';
        row.dataset.sessionId = record.id;
        row.classList.toggle('active', activePanel?.sessionId === record.id);
        const open = document.createElement('button');
        open.className = 'sidebar-session-open';
        const status = document.createElement('span');
        status.className = 'tab-state';
        const visible = panels.find(panel => panel.sessionId === record.id);
        status.dataset.status = visible?.el.querySelector('.panel-status').dataset.status || (record.status === 'running' ? 'connected' : 'ended');
        status.title = record.status === 'running' ? '실행 중' : '저장된 기록';
        const title = document.createElement('span');
        title.className = 'sidebar-session-title'; title.textContent = record.title;
        const tool = document.createElement('span');
        tool.className = 'sidebar-session-tool'; tool.textContent = toolNames[record.tool] || record.tool;
        open.append(status, title, tool);
        open.title = `${record.title}\n${new Date(record.updatedAt).toLocaleString()}`;
        open.onclick = () => openSavedSession(record);
        const menu = document.createElement('button');
        menu.className = 'session-menu-button'; menu.textContent = '⋯';
        menu.setAttribute('aria-label', `${record.title} 세션 관리`);
        menu.onclick = () => openSessionDetails(record);
        row.append(open, menu);
        section.appendChild(row);
      });
      if (!isCollapsed && !records.length) {
        const empty = document.createElement('button');
        empty.className = 'sidebar-new-session'; empty.textContent = '+ 첫 세션 시작';
        empty.onclick = () => openToolChoice(project);
        section.appendChild(empty);
      }
      target.appendChild(section);
    });
    if (!target.childElementCount) {
      const empty = document.createElement('p'); empty.className = 'preset-empty';
      empty.textContent = query ? '검색 결과가 없습니다.' : '프로젝트를 추가하거나 빈 터미널로 시작하세요.';
      target.appendChild(empty);
    }
    target.scrollTop = scrollTop;
    if (focusedSession) {
      const row = [...target.querySelectorAll('.sidebar-session')].find(item => item.dataset.sessionId === focusedSession);
      row?.querySelector(focusedMenu ? '.session-menu-button' : '.sidebar-session-open')?.focus({ preventScroll: true });
    }
  }
  let sessionsRefreshing = false;
  async function refreshSessions() {
    if (sessionsRefreshing || pageLeaving) return;
    sessionsRefreshing = true;
    try {
      const data = await ui.request('/api/sessions');
      if (!Array.isArray(data.sessions)) throw new Error('세션 목록 형식이 올바르지 않습니다.');
      const changed = JSON.stringify(sessionRecords) !== JSON.stringify(data.sessions);
      sessionRecords = data.sessions;
      ui.error(document.getElementById('sessionListError'), data.error || '');
      if (changed) renderProjectSidebar();
      updateStatusBar();
    } catch (failure) { ui.error(document.getElementById('sessionListError'), `세션 목록 연결 실패: ${failure.message} ↻로 다시 시도할 수 있습니다.`); }
    finally { sessionsRefreshing = false; }
  }
  function openSavedSession(record) {
    let panel = panels.find(item => item.sessionId === record.id);
    if (!panel) panel = addTerminal(record.projectName, record.cwd, record.tool, { sessionId: record.id, title: record.title, autoTitle: record.title.startsWith('새 ') });
    if (panel.minimized) toggleMinimize(panel);
    setActivePanel(panel);
    if (window.innerWidth <= 760) toggleSidebar(false);
    panel.term.focus();
  }
  function renderPresetList(target, search, showPath = false) {
    target.replaceChildren();
    const query = search.trim().toLocaleLowerCase();
    const matching = presetCache.filter(p => `${p.name} ${p.cwd}`.toLocaleLowerCase().includes(query));
    const seen = new Set();
    const groups = [
      ['즐겨찾기', matching.filter(p => favoriteKeys.includes(presetKey(p)))],
      ['최근 사용', recentKeys.map(key => matching.find(p => presetKey(p) === key)).filter(Boolean)],
      [query ? '검색 결과' : '모든 프로젝트', matching]
    ];
    for (const [title, items] of groups) {
      const unique = items.filter(p => !seen.has(presetKey(p)));
      if (!unique.length) continue;
      const heading = document.createElement('div');
      heading.className = 'preset-section';
      heading.textContent = title;
      target.appendChild(heading);
      unique.forEach(p => {
        const key = presetKey(p);
        seen.add(key);
        const row = document.createElement('div');
        row.className = 'preset-item';
        const choose = document.createElement('button');
        choose.className = 'preset-select';
        choose.textContent = p.name;
        choose.title = p.cwd;
        if (showPath) {
          const path = document.createElement('span');
          path.className = 'project-path';
          path.textContent = p.cwd;
          choose.appendChild(path);
        }
        choose.addEventListener('click', () => {
          closePresetMenu();
          openToolChoice(p);
        });
        const favorite = document.createElement('button');
        favorite.className = 'preset-favorite';
        const selected = favoriteKeys.includes(key);
        favorite.textContent = selected ? '★' : '☆';
        favorite.setAttribute('aria-pressed', String(selected));
        favorite.setAttribute('aria-label', `${p.name} 즐겨찾기 ${selected ? '해제' : '추가'}`);
        favorite.addEventListener('click', () => {
          favoriteKeys = selected ? favoriteKeys.filter(value => value !== key) : [...favoriteKeys, key];
          ui.write('favorites', favoriteKeys);
          renderPresetMenu();
          renderProjectSidebar();
          document.getElementById(showPath ? 'projectSearch' : 'presetSearch').focus();
        });
        row.append(choose, favorite);
        target.appendChild(row);
      });
    }
    if (!seen.size) {
      const empty = document.createElement('p');
      empty.className = 'preset-empty';
      empty.textContent = query ? '검색 결과가 없습니다.' : 'Settings에서 프로젝트를 추가해 주세요.';
      target.appendChild(empty);
    }
  }
  async function refreshPresetMenu() {
    try {
      presetCache = await loadPresets();
      if (!presetMenu.classList.contains('hidden')) renderPresetMenu();
      renderProjectSidebar();
    } catch (failure) {
      for (const target of [presetResults, document.getElementById('projectResults')]) {
        target.replaceChildren();
        const message = document.createElement('p');
        message.className = 'inline-error';
        message.textContent = failure.message;
        const retry = document.createElement('button');
        retry.className = 'btn';
        retry.textContent = '다시 불러오기';
        retry.onclick = refreshPresetMenu;
        target.append(message, retry);
      }
    }
  }
  btnPreset.addEventListener('click', e => {
    e.stopPropagation();
    if (!presetMenu.classList.contains('hidden')) { closePresetMenu(); return; }
    presetSearch.value = '';
    presetMenu.classList.remove('hidden');
    btnPreset.setAttribute('aria-expanded', 'true');
    renderPresetMenu();
    presetSearch.focus();
    refreshPresetMenu();
  });
  presetSearch.addEventListener('input', renderPresetMenu);
  presetMenu.addEventListener('keydown', e => {
    const choices = [...presetResults.querySelectorAll('.preset-select')];
    const index = choices.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closePresetMenu(); btnPreset.focus(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!choices.length) return;
      const next = index < 0 ? (e.key === 'ArrowDown' ? 0 : choices.length - 1) : (index + (e.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
      choices[next].focus();
      choices[next].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && document.activeElement === presetSearch) {
      e.preventDefault(); choices[0]?.click();
    }
  });
  presetMenu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', closePresetMenu);

  // ========== Tool Choice Popup ==========
  const toolChoiceModal = document.getElementById('toolChoiceModal');
  const toolChoicePresetName = document.getElementById('toolChoicePresetName');
  let pendingPreset = null;

  function openToolChoice(preset) {
    pendingPreset = preset;
    toolChoicePresetName.textContent = preset.name;
    ui.openModal(toolChoiceModal);
  }

  toolChoiceModal.querySelectorAll('.tool-choice-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool;
      if (pendingPreset) {
        const key = presetKey(pendingPreset);
        recentKeys = [key, ...recentKeys.filter(value => value !== key)].slice(0, 8);
        ui.write('recentPresets', recentKeys);
        renderProjectSidebar();
        addTerminal(pendingPreset.name, pendingPreset.cwd, tool);
      }
      pendingPreset = null;
      ui.closeModal(toolChoiceModal);
    });
  });

  document.getElementById('btnCancelToolChoice').addEventListener('click', () => {
    pendingPreset = null;
    ui.closeModal(toolChoiceModal);
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
        else ui.closeModal(modal);
      }
      mouseDownOnBackground = false;
    });
  }
  setupModalBackgroundClose(toolChoiceModal, () => {
    pendingPreset = null;
    ui.closeModal(toolChoiceModal);
  });

  // ========== Terminal Panel ==========
  function addTerminal(name, cwd, tool, restored = null) {
    const id = nextId++;
    name = name || `Terminal ${id}`;
    cwd = cwd || 'C:\\MyDev';
    // 하위호환: boolean(true)=claude, boolean(false)/undefined=none
    if (tool === true) tool = 'claude';
    else if (tool === false || tool == null) tool = 'none';
    if (!toolNames[tool]) tool = 'none';

    // Panel element
    const panelEl = document.createElement('div');
    panelEl.className = 'panel';
    panelEl.dataset.id = id;
    panelEl.id = `panel-${id}`;
    panelEl.setAttribute('role', 'tabpanel');
    panelEl.setAttribute('aria-label', `${name} · ${toolNames[tool]}`);
    panelEl.style.flex = '1 1 0';
    panelEl.innerHTML = `
      <div class="panel-header">
        <div class="panel-title-group">
          <span class="panel-title" title="${escapeHtml(cwd)}">${escapeHtml(name)}</span>
          <span class="panel-tool">${toolNames[tool]}</span>
          <span class="panel-status" data-status="connecting" role="status">연결 중</span>
        </div>
        <div class="panel-actions">
          <button class="panel-btn capture" title="마지막 답변 캡처 → 클립보드 모달">📥</button>
          <button class="panel-btn move-left" title="왼쪽으로 이동">◀</button>
          <button class="panel-btn move-right" title="오른쪽으로 이동">▶</button>
          <button class="panel-btn minimize" title="최소화">─</button>
          <button class="panel-btn maximize" title="이 패널 크게 보기" aria-label="이 패널 크게 보기">⛶</button>
          <button class="panel-btn close" title="닫기">✕</button>
        </div>
      </div>
      <div class="session-actions hidden"><span class="session-message"></span><button class="btn session-restart">새 세션 시작</button></div>
      <div class="panel-body" id="term-${id}"></div>
      <p class="panel-feedback inline-error hidden" role="alert"></p>
      <div class="panel-composer-resize" title="드래그하여 composer 높이 조절"></div>
      <div class="panel-composer">
        <textarea class="panel-composer-input" placeholder="여러 줄 입력 후 Ctrl+Enter — 이 터미널로 전송 (이미지 paste 가능)"></textarea>
        <div class="composer-buttons">
          <button class="btn panel-history" title="이 프로젝트·도구의 최근 전송 내용">기록</button>
          <button class="btn btn-primary panel-composer-send" title="이 터미널로 전송 (Ctrl+Enter)" disabled>Send</button>
        </div>
      </div>
    `;
    panelsEl.appendChild(panelEl);

    // xterm
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "Consolas, 'Cascadia Mono', 'Malgun Gothic', monospace",
      lineHeight: 1.15,
      minimumContrastRatio: 4.5,
      scrollback: 10000,
      theme: {
        background: '#1e1e1e',
        foreground: '#e6e6e6',
        cursor: '#aeafad',
        // The text-selection overlay paints trimmed ranges instead of full cells.
        selectionBackground: '#00000000',
        selectionInactiveBackground: '#00000000'
      },
      allowProposedApi: true
    });

    const fitAddon = new FitAddon.FitAddon();
    const webLinksAddon = new WebLinksAddon.WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(document.getElementById(`term-${id}`));
    const selection = window.TerminalSelection.install(term, { onResume: () => fitPanel(panel) });

    // Ctrl+V 붙여넣기 / Ctrl+C 복사 (선택영역 있을 때만)
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const copying = e.ctrlKey && ['c', 'C', 'Insert'].includes(e.key) && term.hasSelection();
      if (selection.held && !copying && !['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
        selection.resume();
        if (e.key === 'Escape') { e.preventDefault(); return false; }
      }
      if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard.readText().then(text => {
          if (!text) return;
          if (panel.ready && !panel.exited && ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input', data: text }));
          }
        }).catch(() => {});
        return false;
      }
      if (e.ctrlKey && ['c', 'C', 'Insert'].includes(e.key)) {
        const sel = getLogicalSelection(term);
        if (sel && sel.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          // Windows 클립보드는 \r\n 기대 — 정규화
          const text = sel.replace(/\r\n/g, '\n').replace(/\r/g, '').replace(/\n/g, '\r\n');
          navigator.clipboard.writeText(text).catch(() => {
            ui.error(panelEl.querySelector('.panel-feedback'), '복사하지 못했습니다. 선택은 유지했으니 Ctrl+C로 다시 시도해 주세요.');
          });
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
        if (panel.ready && !panel.exited && ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data: text }));
        }
      }).catch(() => {});
    });

    let ws = null;
    const panel = {
      id, name, cwd, tool, title: restored?.title || `새 ${toolNames[tool]} 세션`, autoTitle: restored?.autoTitle ?? !restored?.title,
      el: panelEl, term, fitAddon, selection, get ws() { return ws; },
      minimized: false, sessionId: restored?.sessionId || crypto.randomUUID(),
      resizeObserver: null, closed: false, ready: false, exited: false,
      createAllowed: !restored || restored.creating === true, shouldReconnect: true, reconnectTimer: null,
      pendingSend: null, sendTimer: null, ackTimer: null, uploading: 0
    };
    panels.push(panel);
    if (restored?.flex) panelEl.style.flex = restored.flex;

    function updateSendState() {
      panelEl.querySelector('.panel-composer-send').disabled = !panel.ready || panel.exited || !!panel.pendingSend || panel.uploading > 0;
    }
    panel.updateSendState = updateSendState;
    function setStatus(status, label) {
      const badge = panelEl.querySelector('.panel-status');
      badge.dataset.status = status;
      badge.textContent = label;
      const tabBadge = document.querySelector(`.session-tab[data-id="${id}"] .tab-state`);
      if (tabBadge) { tabBadge.dataset.status = status; tabBadge.title = label; }
      renderProjectSidebar();
      updateStatusBar();
      updateSendState();
    }
    function sendFailure(message) {
      clearTimeout(panel.sendTimer);
      clearTimeout(panel.ackTimer);
      panel.pendingSend = null;
      updateSendState();
      ui.error(panelEl.querySelector('.panel-feedback'), message);
    }
    function unavailable(message) {
      panel.ready = false;
      panel.shouldReconnect = false;
      panel.missing = true;
      setStatus('ended', '세션 없음');
      panelEl.querySelector('.session-actions').classList.remove('hidden');
      panelEl.querySelector('.session-message').textContent = message;
    }
    function connectWs() {
      if (panel.closed || pageLeaving || !panel.shouldReconnect) return;
      clearTimeout(panel.reconnectTimer);
      clearTimeout(panel.connectionTimer);
      panel.ready = false;
      setStatus('connecting', panel.createAllowed ? '연결 중' : '재연결 중');
      const query = new URLSearchParams({
        sessionId: panel.sessionId, create: panel.createAllowed ? '1' : '0', cwd, name, tool
      });
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/terminal?${query}`);
      ws = socket;
      panel.connectionTimer = setTimeout(() => {
        if (panel.closed || socket !== ws || pageLeaving) return;
        socket.onclose = null;
        socket.close();
        connectWs();
      }, 15000);
      socket.onmessage = e => {
        if (panel.closed || socket !== ws) return;
        let msg;
        try { msg = JSON.parse(e.data); } catch (_) { return; }
        if (msg.type === 'pong') {
          if (msg.requestId === panel.probeId) { clearTimeout(panel.probeTimer); panel.probeId = null; }
        } else if (msg.type === 'output') {
          selection.write(msg.data);
        } else if (msg.type === 'session') {
          clearTimeout(panel.connectionTimer);
          panel.createAllowed = false;
          panel.sessionId = msg.sessionId;
          panel.exited = !!msg.exited;
          panel.archived = !!msg.archived;
          panel.missing = !!msg.archived;
          if (msg.title) setPanelTitle(panel, msg.title);
          panel.restoring = true;
          panel.sentCols = panel.sentRows = null;
          if (msg.windowsPty) term.options.windowsPty = msg.windowsPty;
          selection.resume();
          term.reset();
          if (msg.cols && msg.rows) term.resize(msg.cols, msg.rows);
          // Older server snapshots restore mouse tracking but omit its encoding.
          // ConPTY uses SGR reports; legacy reports make wheel input disappear.
          const mouseEncoding = msg.windowsPty?.backend === 'conpty' ? '\x1b[?1006h' : '';
          term.write(mouseEncoding + (msg.snapshot || ''), () => {
            if (panel.closed || socket !== ws || socket.readyState !== WebSocket.OPEN) return;
            panel.restoring = false;
            panel.ready = !panel.exited;
            setStatus(panel.exited ? 'ended' : 'connected', panel.exited ? '종료됨' : '연결됨');
            if (panel.exited) {
              panelEl.querySelector('.session-actions').classList.remove('hidden');
              panelEl.querySelector('.session-message').textContent = msg.archived ? '이 PC에 저장된 세션 기록입니다. 새 작업은 새 세션으로 시작할 수 있습니다.' : '종료된 터미널의 출력입니다.';
            }
            fitPanel(panel);
            saveWorkspace();
            refreshSessions();
          });
        } else if (msg.type === 'exit' || msg.type === 'terminated') {
          panel.ready = false;
          panel.exited = true;
          panel.shouldReconnect = false;
          setStatus('ended', '종료됨');
          panelEl.querySelector('.session-actions').classList.remove('hidden');
          panelEl.querySelector('.session-message').textContent = '터미널이 종료되었습니다.';
          if (panel.pendingSend) sendFailure('전송 중 터미널이 종료되었습니다. 입력 내용은 보관했습니다.');
          refreshSessions();
        } else if (msg.type === 'session-title') {
          setPanelTitle(panel, msg.title);
          refreshSessions();
        } else if (msg.type === 'session-missing' || msg.type === 'session-error') {
          clearTimeout(panel.connectionTimer);
          unavailable(msg.message);
        } else if (msg.type === 'operation-error') {
          sendFailure(msg.message);
        } else if (msg.type === 'input-ack' && panel.pendingSend?.id === msg.requestId) {
          const sent = panel.pendingSend.text;
          clearTimeout(panel.ackTimer);
          panel.pendingSend = null;
          const key = JSON.stringify([cwd.toLowerCase(), tool]);
          let history = ui.read('history.' + key, []);
          if (!Array.isArray(history)) history = [];
          history = [{ text: sent, time: new Date().toISOString() }, ...history.filter(item => item.text !== sent)].slice(0, 30);
          const stored = ui.write('history.' + key, history);
          const input = panelEl.querySelector('.panel-composer-input');
          if (input.value === sent) input.value = '';
          saveDraft(panel);
          updateSendState();
          ui.error(panelEl.querySelector('.panel-feedback'), stored ? '' : '브라우저 저장 공간이 부족해 전송 기록을 보관하지 못했습니다.');
          input.focus();
          if (panel.autoTitle) {
            const title = sent.replace(/\s+/g, ' ').trim().slice(0, 60);
            if (title) ui.request(`/api/sessions/${encodeURIComponent(panel.sessionId)}/title`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title })
            }).then(() => { panel.autoTitle = false; saveWorkspace(); refreshSessions(); })
              .catch(failure => ui.error(panelEl.querySelector('.panel-feedback'), `세션 이름 저장 실패: ${failure.message}`));
          }
        }
      };
      socket.onclose = () => {
        if (panel.closed || socket !== ws || pageLeaving) return;
        panel.ready = false;
        clearTimeout(panel.connectionTimer);
        clearTimeout(panel.probeTimer);
        panel.probeId = null;
        if (panel.pendingSend) sendFailure('연결이 끊겨 전송을 확인하지 못했습니다. 입력을 보관했으니 터미널 내용을 확인한 뒤 다시 보내 주세요.');
        if (!panel.shouldReconnect) { updateSendState(); return; }
        setStatus('disconnected', '연결 끊김');
        panel.reconnectTimer = setTimeout(connectWs, 3000);
      };
    }
    panel.connect = connectWs;
    panel.probeConnection = () => {
      if (panel.closed || pageLeaving || !panel.shouldReconnect || panel.probeId) return;
      if (!ws || ws.readyState === WebSocket.CLOSED) { connectWs(); return; }
      if (ws.readyState !== WebSocket.OPEN) return;
      const socket = ws;
      panel.probeId = crypto.randomUUID();
      socket.send(JSON.stringify({ type: 'ping', requestId: panel.probeId }));
      panel.probeTimer = setTimeout(() => {
        panel.probeId = null;
        if (panel.closed || socket !== ws || pageLeaving) return;
        if (panel.pendingSend) sendFailure('연결 응답이 없어 다시 연결합니다. 입력 초안은 보관했습니다.');
        socket.onclose = null;
        socket.close();
        connectWs();
      }, 7000);
    };
    panel.stopConnection = () => {
      panel.shouldReconnect = false;
      clearTimeout(panel.reconnectTimer);
      clearTimeout(panel.sendTimer);
      clearTimeout(panel.ackTimer);
      clearTimeout(panel.fitTimer);
      clearTimeout(panel.probeTimer);
      clearTimeout(panel.connectionTimer);
      panel.probeId = null;
      if (ws) { ws.onclose = null; ws.close(); }
    };
    term.onData(data => {
      if (panel.ready && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
    });
    panelEl.querySelector('.session-restart').addEventListener('click', () => {
      ui.dialog({
        title: '새 세션 시작', message: `${name}의 새 터미널을 시작합니다. 이전 출력은 화면에서 지워지고 입력 초안은 유지됩니다.`,
        confirmText: '새 세션 시작', onConfirm: async () => {
          if (!panel.missing) await ui.request(`/api/sessions/${encodeURIComponent(panel.sessionId)}/close`, { method: 'POST' });
          panel.stopConnection();
          const previousId = panel.sessionId;
          panel.sessionId = crypto.randomUUID();
          saveDraft(panel);
          ui.remove('draft.' + previousId);
          panel.createAllowed = true;
          panel.shouldReconnect = true;
          panel.exited = panel.missing = false;
          panel.archived = false;
          panel.autoTitle = true;
          setPanelTitle(panel, `새 ${toolNames[tool]} 세션`);
          panelEl.querySelector('.session-actions').classList.add('hidden');
          selection.resume();
          term.reset();
          saveWorkspace();
          connectWs();
        }
      });
    });

    // Debounce geometry changes through one path; never resize a restoring terminal.
    panel.resizeObserver = new ResizeObserver(() => fitPanel(panel));
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
    panelEl.querySelector('.close').addEventListener('click', () => ui.dialog({
      title: '터미널 종료', message: `${name} · ${toolNames[tool]}의 터미널을 종료합니다. 이 터미널에서 진행 중인 작업도 종료됩니다.`,
      confirmText: '종료', onConfirm: () => removePanel(panel)
    }));
    panelEl.querySelector('.maximize').addEventListener('click', e => {
      e.stopPropagation();
      setActivePanel(panel);
      if (panel.minimized) toggleMinimize(panel);
      focusMode = !focusMode;
      applyLayout();
    });

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
    const savedDraft = ui.read('draft.' + panel.sessionId, '');
    inputEl.value = typeof savedDraft === 'string' ? savedDraft : '';
    inputEl.addEventListener('input', () => saveDraft(panel));
    panelEl.querySelector('.panel-history').addEventListener('click', () => showInputHistory(panel));

    function sendThisPanel() {
      const text = inputEl.value;
      if (!text) return;
      if (!panel.ready || panel.exited || panel.pendingSend || panel.uploading || !ws || ws.readyState !== WebSocket.OPEN) return;
      selection.resume();
      const socket = ws;
      panel.pendingSend = { id: crypto.randomUUID(), text };
      updateSendState();
      ui.error(panelEl.querySelector('.panel-feedback'));
      ws.send(JSON.stringify({ type: 'input', data: '\x1b[200~' + text + '\x1b[201~' }));
      const hasAttachment = /(^|\s)@\S/.test(text);
      const longContent = text.length > 500;
      const delay = hasAttachment ? 500 : (longContent ? 300 : 200);
      panel.sendTimer = setTimeout(() => {
        if (!panel.closed && panel.ready && panel.pendingSend && ws === socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'input', data: '\r', requestId: panel.pendingSend.id }));
          panel.ackTimer = setTimeout(() => sendFailure('전송 확인 응답을 받지 못했습니다. 입력은 보관했으니 터미널 내용을 확인해 주세요.'), 8000);
        }
      }, delay);
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
      panel.uploading++;
      updateSendState();
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
        if (panel.closed) return;
        insertAtCursor(inputEl, '@' + data.path);
        saveDraft(panel);
        inputEl.placeholder = `📎 ${data.filename} 첨부됨`;
        setTimeout(() => { inputEl.placeholder = origPlaceholder; }, 2000);
      } catch (err) {
        if (!panel.closed) ui.error(panelEl.querySelector('.panel-feedback'), '이미지 첨부 실패: ' + err.message + ' — 이미지를 다시 붙여넣어 주세요.');
      } finally {
        panel.uploading--;
        inputEl.placeholder = origPlaceholder;
        updateSendState();
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
        panels.forEach(fitPanel);
      };
      const onUp = () => {
        composerResize.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        panels.forEach(fitPanel);
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
    if (restored?.minimized) toggleMinimize(panel);
    applyLayout();
    connectWs();

    return panel;
  }

  function setPanelTitle(panel, title) {
    panel.title = title;
    panel.el.querySelector('.panel-title').textContent = title;
    panel.el.querySelector('.panel-title').title = `${panel.name}\n${panel.cwd}`;
    updateCount();
    saveWorkspace();
  }

  function saveDraft(panel) {
    const text = panel.el.querySelector('.panel-composer-input').value;
    if (!ui.write('draft.' + panel.sessionId, text)) {
      ui.error(panel.el.querySelector('.panel-feedback'), '브라우저 저장 공간을 사용할 수 없어 입력 초안을 자동 보관하지 못했습니다.');
    }
  }

  const historyModal = document.getElementById('historyModal');
  let historyPanel = null;
  function showInputHistory(panel) {
    historyPanel = panel;
    const key = JSON.stringify([panel.cwd.toLowerCase(), panel.tool]);
    const entries = ui.read('history.' + key, []);
    const list = document.getElementById('historyList');
    list.replaceChildren();
    document.getElementById('historyTitle').textContent = `${panel.name} · ${toolNames[panel.tool]} 최근 전송`;
    if (Array.isArray(entries)) entries.forEach(entry => {
      if (!entry || typeof entry.text !== 'string') return;
      const button = document.createElement('button');
      button.className = 'history-entry';
      const time = document.createElement('span');
      time.className = 'history-time';
      time.textContent = new Date(entry.time).toLocaleString();
      const content = document.createElement('span');
      content.className = 'history-text';
      content.textContent = entry.text;
      button.append(time, content);
      button.onclick = async () => {
        if (panel.closed) return;
        const input = panel.el.querySelector('.panel-composer-input');
        const apply = () => {
          input.value = entry.text;
          saveDraft(panel);
          ui.closeModal(historyModal);
          input.focus();
        };
        if (input.value && input.value !== entry.text) await ui.dialog({
          title: '입력 내용 바꾸기', message: '현재 입력 초안을 선택한 기록으로 바꿉니다.',
          confirmText: '불러오기', onConfirm: apply
        });
        else apply();
      };
      list.appendChild(button);
    });
    if (!list.childElementCount) list.textContent = '이 프로젝트·도구에서 아직 보낸 내용이 없습니다.';
    ui.openModal(historyModal);
  }
  document.getElementById('btnCloseHistory').onclick = () => ui.closeModal(historyModal);
  document.getElementById('btnClearHistory').onclick = () => {
    if (!historyPanel) return;
    const panel = historyPanel;
    ui.dialog({
      title: '전송 기록 지우기', message: `${panel.name} · ${toolNames[panel.tool]}의 로컬 전송 기록을 지웁니다. 입력 초안은 유지됩니다.`,
      confirmText: '지우기', onConfirm: () => {
        ui.remove('history.' + JSON.stringify([panel.cwd.toLowerCase(), panel.tool]));
        document.getElementById('historyList').textContent = '전송 기록을 지웠습니다.';
      }
    });
  };
  setupModalBackgroundClose(historyModal);

  function movePanel(panel, dir) {
    const idx = panels.indexOf(panel);
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= panels.length) return;
    [panels[idx], panels[newIdx]] = [panels[newIdx], panels[idx]];
    rebuildHandles();
    updateMoveButtons();
    setTimeout(() => {
      panels.forEach(fitPanel);
    }, 50);
    updateCount();
    saveWorkspace();
  }

  function rebuildHandles() {
    // 기존 핸들 모두 제거
    panelsEl.querySelectorAll('.resize-handle').forEach(h => h.remove());
    // panels[] 순서대로 DOM 재배치 + 핸들 재삽입
    panels.forEach((p, i) => {
      if (i > 0 && layoutMode === 'columns' && !focusMode) {
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
        if (panel.closed) return;
        fitPanel(panel);
        panel.term.focus();
      }, 250);
    }
    recalcFlex();
    if (panel.minimized && focusMode && activePanel === panel) {
      focusMode = false;
      applyLayout();
    }
    updateCount();
    saveWorkspace();
  }

  async function removePanel(panel) {
    if (panel.closed) return;
    if (!panel.missing) await ui.request(`/api/sessions/${encodeURIComponent(panel.sessionId)}/close`, { method: 'POST' });
    detachPanel(panel);
    await refreshSessions();
  }

  function detachPanel(panel) {
    if (panel.closed) return;
    saveDraft(panel);
    panel.closed = true;
    panel.stopConnection();
    if (panel.resizeObserver) {
      try { panel.resizeObserver.disconnect(); } catch (e) {}
    }
    panel.selection.dispose();
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
    if (!panels.length) focusMode = false;
    applyLayout();
    saveWorkspace();
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
      expanded.forEach(fitPanel);
    }, 260);
  }

  function updateCount() {
    termCountEl.textContent = `${panels.length} terminal${panels.length !== 1 ? 's' : ''}`;
    document.getElementById('emptyWorkspace').classList.toggle('hidden', panels.length > 0);
    panelsEl.classList.toggle('single-panel', panels.length === 1);
    const tabs = document.getElementById('sessionTabs');
    tabs.replaceChildren();
    panels.forEach(panel => {
      const tab = document.createElement('div');
      tab.className = 'session-tab';
      tab.dataset.id = panel.id;
      tab.classList.toggle('active', panel === activePanel);
      const choose = document.createElement('button');
      choose.className = 'session-tab-select';
      choose.setAttribute('role', 'tab');
      choose.setAttribute('aria-selected', String(panel === activePanel));
      choose.setAttribute('aria-controls', panel.el.id);
      const state = document.createElement('span');
      state.className = 'tab-state';
      state.dataset.status = panel.el.querySelector('.panel-status').dataset.status;
      state.title = panel.el.querySelector('.panel-status').textContent;
      const label = document.createElement('span');
      label.textContent = `${panel.title} · ${toolNames[panel.tool]}${panel.minimized ? ' (최소화)' : ''}`;
      choose.append(state, label);
      choose.title = panel.cwd;
      choose.onclick = () => {
        if (panel.minimized) toggleMinimize(panel);
        setActivePanel(panel);
        panel.term.focus();
      };
      const close = document.createElement('button');
      close.className = 'session-tab-close';
      close.textContent = '×';
      close.setAttribute('aria-label', `${panel.title} 탭 닫기`);
      close.title = '화면에서 닫기 — 터미널은 계속 실행됩니다';
      close.onclick = () => detachPanel(panel);
      tab.append(choose, close);
      tabs.appendChild(tab);
    });
    document.getElementById('activeSessionLabel').textContent = activePanel ? `${activePanel.name} · ${toolNames[activePanel.tool]}` : '';
    document.getElementById('workspaceHint').textContent = panels.length ? '입력 자동 보관 · Ctrl+Enter 전송' : '프로젝트를 선택해 터미널을 열어 주세요.';
    updateStatusBar();
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
        [leftPanel, rightPanel].forEach(fitPanel);
        saveWorkspace();
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
    const button = document.getElementById('btnSettings');
    button.disabled = true;
    try {
      renderPresetEditor(await loadPresets());
      ui.error(document.getElementById('settingsError'));
      ui.openModal(settingsModal);
    } catch (failure) {
      ui.dialog({ title: '설정을 열지 못했습니다', message: failure.message, confirmText: '다시 시도', onConfirm: async () => {
        renderPresetEditor(await loadPresets());
        ui.error(document.getElementById('settingsError'));
        ui.openModal(settingsModal);
      } });
    } finally { button.disabled = false; }
  });

  document.getElementById('btnCloseModal').addEventListener('click', () => {
    ui.closeModal(settingsModal);
  });

  document.getElementById('btnAddPreset').addEventListener('click', () => {
    const item = createPresetEditorItem({ name: '', cwd: '' });
    presetListEl.appendChild(item);
  });

  document.getElementById('btnSavePresets').addEventListener('click', async () => {
    if (settingsModal.dataset.busy === 'true') return;
    ui.error(document.getElementById('settingsError'));
    const items = presetListEl.querySelectorAll('.preset-editor-item');
    const presets = [];
    let invalid = null;
    items.forEach(item => {
      const name = item.querySelector('input[name="name"]').value.trim();
      const cwd = item.querySelector('input[name="cwd"]').value.trim();
      if (!name || !cwd) invalid ||= item;
      else presets.push({ name, cwd });
    });
    if (invalid) {
      ui.error(document.getElementById('settingsError'), '이름과 작업 폴더를 모두 입력해 주세요. 필요 없는 빈 행은 삭제할 수 있습니다.');
      invalid.querySelector('input').focus();
      return;
    }
    const controls = [...settingsModal.querySelectorAll('input, button')];
    settingsModal.dataset.busy = 'true';
    settingsModal.setAttribute('aria-busy', 'true');
    controls.forEach(control => { control.disabled = true; });
    try {
      await savePresets(presets);
      presetCache = presets;
      renderProjectSidebar();
      settingsModal.dataset.busy = 'false';
      ui.closeModal(settingsModal);
    } catch (failure) {
      ui.error(document.getElementById('settingsError'), `${failure.message} 입력은 유지했습니다. Save로 다시 시도해 주세요.`);
    } finally {
      settingsModal.dataset.busy = 'false';
      settingsModal.setAttribute('aria-busy', 'false');
      controls.forEach(control => { control.disabled = false; });
    }
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
      <input name="name" placeholder="Name" aria-label="프로젝트 이름">
      <input name="cwd" placeholder="Working directory path" aria-label="작업 폴더">
      <button class="btn-remove" title="삭제">✕</button>
    `;
    div.querySelector('input[name="name"]').value = p.name || '';
    div.querySelector('input[name="cwd"]').value = p.cwd || '';
    div.querySelector('.btn-remove').addEventListener('click', () => div.remove());
    return div;
  }

  // ========== Window resize ==========
  window.addEventListener('resize', () => {
    panels.forEach(fitPanel);
  });

  // ========== Keyboard shortcut ==========
  document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+T: 새 터미널
    if (e.ctrlKey && e.shiftKey && e.key === 'T') {
      if (document.querySelector('.modal:not(.hidden)')) return;
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
  const clipboardError = document.getElementById('clipboardError');

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
      const data = await ui.request('/api/clipboard');
      clipboardContent.value = data.content || '';
      clipboardMtime.textContent = fmtMtime(data.mtime);
      ui.error(clipboardError);
    } catch (err) {
      ui.error(clipboardError, `불러오기 실패: ${err.message} 현재 내용은 유지했습니다. Reload로 다시 시도해 주세요.`);
      throw err;
    }
  }

  async function clipboardOperation(operation) {
    if (clipboardModal.dataset.busy === 'true') return;
    const controls = [...clipboardModal.querySelectorAll('button')];
    clipboardModal.dataset.busy = 'true';
    clipboardModal.setAttribute('aria-busy', 'true');
    clipboardContent.readOnly = true;
    controls.forEach(button => { button.disabled = true; });
    ui.error(clipboardError);
    try { return await operation(); }
    catch (failure) { ui.error(clipboardError, failure.message); throw failure; }
    finally {
      clipboardModal.dataset.busy = 'false';
      clipboardModal.setAttribute('aria-busy', 'false');
      clipboardContent.readOnly = false;
      controls.forEach(button => { button.disabled = false; });
    }
  }

  async function captureFromPanel(panel, retry = false) {
    if (panel.closed || clipboardModal.dataset.busy === 'true') return;
    if (!panel.ready && !panel.exited) {
      ui.dialog({ title: '아직 연결되지 않았습니다', message: '터미널 연결이 완료된 뒤 다시 캡처해 주세요.' });
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
      ui.error(clipboardError);
      ui.openModal(clipboardModal, clipboardContent);
      // 위 끝 보여주기
      clipboardContent.scrollTop = 0;
    } catch (err) {
      if (retry) throw err;
      ui.dialog({ title: '캡처 실패', message: err.message, confirmText: '다시 시도', onConfirm: () => captureFromPanel(panel, true) });
    }
  }

  document.getElementById('btnClipboard').addEventListener('click', async () => {
    ui.openModal(clipboardModal, clipboardContent);
    await clipboardOperation(loadClipboardFromFile).catch(() => {});
  });

  document.getElementById('btnClipboardClose').addEventListener('click', () => {
    ui.closeModal(clipboardModal);
  });

  document.getElementById('btnClipboardReload').addEventListener('click', async () => {
    if (clipboardContent.value) {
      await ui.dialog({ title: '파일 다시 읽기', message: '입력창의 내용을 파일에 저장된 내용으로 바꿉니다.',
        confirmText: '다시 읽기', onConfirm: () => clipboardOperation(loadClipboardFromFile) });
    } else await clipboardOperation(loadClipboardFromFile).catch(() => {});
  });

  document.getElementById('btnClipboardSave').addEventListener('click', async () => {
    const btn = document.getElementById('btnClipboardSave');
    await clipboardOperation(async () => {
      const data = await ui.request('/api/clipboard/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: clipboardContent.value })
      });
      clipboardMtime.textContent = fmtMtime(data.mtime);
      flashBtn(btn, '✓ Saved');
    }).catch(failure => ui.error(clipboardError, `저장 실패: ${failure.message} 입력은 유지했습니다. Save로 다시 시도해 주세요.`));
  });

  document.getElementById('btnClipboardCopy').addEventListener('click', async () => {
    const text = clipboardContent.value;
    if (!text) return;
    const norm = text.replace(/\r\n/g, '\n').replace(/\r/g, '').replace(/\n/g, '\r\n');
    await clipboardOperation(async () => {
      await navigator.clipboard.writeText(norm);
      flashBtn(document.getElementById('btnClipboardCopy'), '✓ Copied');
    }).catch(failure => ui.error(clipboardError, `복사 실패: ${failure.message} Copy All로 다시 시도해 주세요.`));
  });

  document.getElementById('btnClipboardClear').addEventListener('click', async () => {
    await ui.dialog({ title: '클립보드 비우기', message: 'clipboard.md 파일과 입력창의 내용을 모두 비웁니다.', confirmText: '비우기',
      onConfirm: () => clipboardOperation(async () => {
        await ui.request('/api/clipboard/clear', { method: 'POST' });
        clipboardContent.value = '';
        clipboardMtime.textContent = '(비어있음)';
      }) });
  });

  setupModalBackgroundClose(clipboardModal);

  function updateStatusBar() {
    const panel = activePanel;
    document.getElementById('statusConnection').textContent = panel?.el.querySelector('.panel-status').textContent || '준비됨';
    document.getElementById('statusProject').textContent = panel?.cwd || '';
    document.getElementById('statusProject').title = panel?.cwd || '';
    document.getElementById('statusSummary').textContent = `${panels.length}개 탭 · ${sessionRecords.filter(record => record.status === 'running').length}개 실행 중`;
  }

  const sessionDetailsModal = document.getElementById('sessionDetailsModal');
  let detailsRecord = null;
  function openSessionDetails(record) {
    detailsRecord = record;
    document.getElementById('sessionTitleInput').value = record.title;
    document.getElementById('sessionDetailsInfo').textContent = `${record.projectName} · ${toolNames[record.tool] || record.tool}\n${record.cwd}`;
    document.getElementById('btnEndSession').disabled = record.status !== 'running';
    ui.error(document.getElementById('sessionDetailsError'));
    ui.openModal(sessionDetailsModal, document.getElementById('sessionTitleInput'));
  }
  document.getElementById('btnCloseSessionDetails').onclick = () => ui.closeModal(sessionDetailsModal);
  document.getElementById('btnSaveSessionTitle').onclick = async () => {
    if (!detailsRecord || sessionDetailsModal.dataset.busy === 'true') return;
    const record = detailsRecord;
    const controls = [...sessionDetailsModal.querySelectorAll('input, button')];
    const disabled = controls.map(control => control.disabled);
    sessionDetailsModal.dataset.busy = 'true';
    controls.forEach(control => { control.disabled = true; });
    try {
      const updated = await ui.request(`/api/sessions/${encodeURIComponent(record.id)}/title`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: document.getElementById('sessionTitleInput').value })
      });
      const panel = panels.find(item => item.sessionId === record.id);
      if (panel) { panel.autoTitle = false; setPanelTitle(panel, updated.title); }
      sessionDetailsModal.dataset.busy = 'false';
      ui.closeModal(sessionDetailsModal);
      await refreshSessions();
    } catch (failure) { ui.error(document.getElementById('sessionDetailsError'), failure.message); }
    finally {
      sessionDetailsModal.dataset.busy = 'false';
      controls.forEach((control, index) => { control.disabled = disabled[index]; });
    }
  };
  document.getElementById('btnEndSession').onclick = () => {
    const record = detailsRecord;
    if (!record) return;
    ui.dialog({ title: '터미널 종료', message: `${record.title}에서 진행 중인 작업을 종료합니다. 세션 기록은 목록에 남습니다.`, confirmText: '종료',
      onConfirm: async () => {
        await ui.request(`/api/sessions/${encodeURIComponent(record.id)}/close`, { method: 'POST' });
        ui.closeModal(sessionDetailsModal);
        await refreshSessions();
      } });
  };
  document.getElementById('btnDeleteSession').onclick = () => {
    const record = detailsRecord;
    if (!record) return;
    ui.dialog({ title: '세션 기록 삭제', message: `${record.title}의 저장된 터미널 화면과 목록을 삭제합니다. 실행 중인 터미널도 종료되며, 삭제한 기록은 복구할 수 없습니다.`, confirmText: '삭제',
      onConfirm: async () => {
        await ui.request(`/api/sessions/${encodeURIComponent(record.id)}/delete`, { method: 'POST' });
        const panel = panels.find(item => item.sessionId === record.id);
        if (panel) detachPanel(panel);
        ui.remove('draft.' + record.id);
        ui.closeModal(sessionDetailsModal);
        await refreshSessions();
      } });
  };
  setupModalBackgroundClose(sessionDetailsModal);

  const commandModal = document.getElementById('commandModal');
  const commandSearch = document.getElementById('commandSearch');
  function renderCommands() {
    const commands = [
      { title: '터미널: 빈 Shell 세션 만들기', detail: '새 터미널', run: () => addTerminal() },
      { title: '보기: 가로 분할', detail: '레이아웃', run: () => document.getElementById('btnLayoutColumns').click() },
      { title: '보기: 2×2 배치', detail: '레이아웃', run: () => document.getElementById('btnLayoutGrid').click() },
      { title: '보기: 선택 패널 확대 / 복원', detail: '레이아웃', run: () => document.getElementById('btnLayoutFocus').click() },
      { title: '보기: 사이드바 표시 / 숨김', detail: 'Ctrl+B', run: () => document.getElementById('btnProjects').click() },
      { title: '프로젝트 설정', detail: '설정', run: () => document.getElementById('btnSettings').click() },
      { title: '클립보드 열기', detail: '로컬 메모', run: () => document.getElementById('btnClipboard').click() },
      { title: '세션 목록 새로고침', detail: '연결 확인', run: refreshSessions },
      ...presetCache.map(p => ({ title: `${p.name}: 새 세션`, detail: p.cwd, run: () => openToolChoice(p) })),
      ...sessionRecords.map(record => ({ title: record.title, detail: `${record.projectName} · ${toolNames[record.tool]}`, run: () => openSavedSession(record) }))
    ];
    const query = commandSearch.value.trim().replace(/^>/, '').trim().toLocaleLowerCase();
    const target = document.getElementById('commandResults');
    target.replaceChildren();
    commands.filter(command => `${command.title} ${command.detail}`.toLocaleLowerCase().includes(query)).slice(0, 60).forEach(command => {
      const button = document.createElement('button');
      button.className = 'command-option';
      const title = document.createElement('span'); title.textContent = command.title;
      const detail = document.createElement('span'); detail.className = 'command-detail'; detail.textContent = command.detail;
      button.append(title, detail);
      button.onclick = () => { ui.closeModal(commandModal); command.run(); };
      target.appendChild(button);
    });
    if (!target.childElementCount) {
      const empty = document.createElement('p'); empty.className = 'preset-empty'; empty.textContent = '일치하는 명령이나 세션이 없습니다.'; target.appendChild(empty);
    }
  }
  function openCommands() {
    if (document.querySelector('.modal:not(.hidden)')) return;
    commandSearch.value = '';
    renderCommands();
    ui.openModal(commandModal, commandSearch);
  }
  document.getElementById('btnCommands').onclick = openCommands;
  document.getElementById('btnStatusCommands').onclick = openCommands;
  document.getElementById('activityCommands').onclick = openCommands;
  document.getElementById('btnCloseCommands').onclick = () => ui.closeModal(commandModal);
  commandSearch.oninput = renderCommands;
  commandModal.addEventListener('keydown', event => {
    const choices = [...document.querySelectorAll('.command-option')];
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!choices.length) return;
      const current = choices.indexOf(document.activeElement);
      const next = current < 0 ? (event.key === 'ArrowDown' ? 0 : choices.length - 1) : (current + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
      choices[next].focus(); choices[next].scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && document.activeElement === commandSearch) { event.preventDefault(); choices[0]?.click(); }
  });
  setupModalBackgroundClose(commandModal);
  document.addEventListener('keydown', event => {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'p') { event.preventDefault(); openCommands(); }
    if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'b' && !document.querySelector('.modal:not(.hidden)') && !event.target.closest('.xterm, textarea, input')) {
      event.preventDefault(); document.getElementById('btnProjects').click();
    }
  });

  for (const [id, mode] of [['btnLayoutColumns', 'columns'], ['btnLayoutGrid', 'grid']]) {
    document.getElementById(id).onclick = () => {
      layoutMode = mode;
      focusMode = false;
      ui.write('layout', mode);
      applyLayout();
    };
  }
  document.getElementById('btnLayoutFocus').onclick = () => {
    if (!activePanel) return;
    if (activePanel.minimized) toggleMinimize(activePanel);
    focusMode = !focusMode;
    applyLayout();
  };
  document.getElementById('sessionTabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const choices = [...document.querySelectorAll('.session-tab-select')];
    if (!choices.length) return;
    event.preventDefault();
    const current = Math.max(0, choices.indexOf(document.activeElement));
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + choices.length) % choices.length;
    choices[next].click();
    choices[next].focus();
    choices[next].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  window.addEventListener('pagehide', () => {
    pageLeaving = true;
    panels.forEach(saveDraft);
    saveWorkspace();
    panels.forEach(panel => panel.stopConnection());
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    pageLeaving = false;
    panels.forEach(panel => {
      if (!panel.closed && !panel.missing) { panel.shouldReconnect = true; panel.connect(); }
    });
  });
  function checkConnections() {
    if (document.hidden || pageLeaving) return;
    panels.forEach(panel => { panel.probeConnection(); fitPanel(panel); });
    refreshSessions();
  }
  document.addEventListener('visibilitychange', checkConnections);
  window.addEventListener('online', checkConnections);
  window.addEventListener('focus', checkConnections);
  setInterval(() => { if (!document.hidden) refreshSessions(); }, 5000);
  const savedWorkspace = ui.read('workspace', { panels: [] });
  if (Array.isArray(savedWorkspace?.panels)) {
    const seen = new Set();
    savedWorkspace.panels.forEach(saved => {
      if (!saved || typeof saved.sessionId !== 'string' || typeof saved.cwd !== 'string' || seen.has(saved.sessionId)) return;
      seen.add(saved.sessionId);
      addTerminal(saved.name, saved.cwd, saved.tool, saved);
    });
    const selected = panels.find(panel => panel.sessionId === savedWorkspace.active);
    if (selected) setActivePanel(selected);
  }
  updateCount();
  applyLayout();
  const sidebar = document.getElementById('projectSidebar');
  function updateSidebarButtons(show) {
    const button = document.getElementById('btnProjects');
    button.textContent = show ? '목록 접기' : '목록 열기';
    button.title = show ? '왼쪽 목록 접기 (입력창 밖에서 Ctrl+B)' : '왼쪽 목록 열기 (입력창 밖에서 Ctrl+B)';
    button.setAttribute('aria-expanded', String(show));
    ['sessions', 'projects'].forEach(mode => {
      const activity = document.getElementById(mode === 'sessions' ? 'activitySessions' : 'activityProjects');
      const active = show && sidebarMode === mode;
      activity.classList.toggle('active', active);
      activity.setAttribute('aria-expanded', String(active));
      activity.setAttribute('aria-controls', 'projectSidebar');
    });
  }
  function toggleSidebar(show) {
    if (!show && sidebar.contains(document.activeElement)) document.getElementById('btnProjects').focus({ preventScroll: true });
    sidebar.classList.toggle('hidden', !show);
    updateSidebarButtons(show);
    ui.write('sidebarVisible', show);
    requestAnimationFrame(() => panels.forEach(fitPanel));
  }
  toggleSidebar(ui.read('sidebarVisible', true));
  document.getElementById('btnProjects').onclick = () => toggleSidebar(sidebar.classList.contains('hidden'));
  document.getElementById('btnCollapseSidebar').onclick = () => toggleSidebar(false);
  document.getElementById('projectSearch').oninput = renderProjectSidebar;
  function selectSidebar(mode, show = true) {
    sidebarMode = mode;
    ui.write('sidebarMode', mode);
    document.getElementById('btnSidebarSessions').setAttribute('aria-pressed', String(mode === 'sessions'));
    document.getElementById('btnSidebarProjects').setAttribute('aria-pressed', String(mode === 'projects'));
    if (show) toggleSidebar(true);
    else updateSidebarButtons(!sidebar.classList.contains('hidden'));
    renderProjectSidebar();
  }
  document.getElementById('btnSidebarSessions').onclick = () => selectSidebar('sessions');
  document.getElementById('btnSidebarProjects').onclick = () => selectSidebar('projects');
  function toggleSidebarMode(mode) {
    if (sidebarMode === mode && !sidebar.classList.contains('hidden')) toggleSidebar(false);
    else selectSidebar(mode);
  }
  document.getElementById('activitySessions').onclick = () => toggleSidebarMode('sessions');
  document.getElementById('activityProjects').onclick = () => toggleSidebarMode('projects');
  document.getElementById('activityClipboard').onclick = () => document.getElementById('btnClipboard').click();
  document.getElementById('activitySettings').onclick = () => document.getElementById('btnSettings').click();
  document.getElementById('btnRefreshSessions').onclick = () => { refreshSessions(); refreshPresetMenu(); };
  document.getElementById('btnToggleSessionGroups').onclick = () => {
    const keys = sessionProjectKeys();
    const search = document.getElementById('projectSearch');
    const expand = !search.value.trim() && keys.length > 0 && keys.every(key => collapsedProjects.has(key));
    search.value = '';
    keys.forEach(key => { if (expand) collapsedProjects.delete(key); else collapsedProjects.add(key); });
    ui.write('collapsedProjects', [...collapsedProjects]);
    renderSessionSidebar();
  };
  document.getElementById('btnSidebarSettings').onclick = () => document.getElementById('btnSettings').click();
  document.getElementById('btnEmptyPreset').onclick = event => { event.stopPropagation(); btnPreset.click(); };
  document.getElementById('btnEmptyShell').onclick = () => addTerminal();
  refreshPresetMenu();
  refreshSessions();
  selectSidebar(sidebarMode, false);

})();
