(function (root) {
  // Keep the terminal's logical selection, but draw only occupied text cells.
  function textRanges(term) {
    const selection = term.getSelectionPosition();
    if (!selection) return [];
    const buffer = term.buffer.active, ranges = [];
    const first = Math.max(selection.start.y, buffer.viewportY);
    const last = Math.min(selection.end.y, buffer.viewportY + term.rows - 1);
    for (let y = first; y <= last; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      const start = y === selection.start.y ? selection.start.x : 0;
      const end = y === selection.end.y ? selection.end.x : term.cols;
      let left = end, right = start;
      for (let x = 0; x < term.cols; x++) {
        const cell = line.getCell(x);
        const width = cell?.getWidth() || 0;
        if (!width || !cell.getChars().trim() || x + width <= start || x >= end) continue;
        left = Math.min(left, x);
        right = Math.max(right, x + width);
      }
      if (right > left) ranges.push({ row: y - buffer.viewportY, start: left, end: right });
    }
    return ranges;
  }

  function install(term, { onResume } = {}) {
    const element = term.element;
    const screen = element?.querySelector('.xterm-screen');
    if (!screen) return { write: data => term.write(data), resume() {}, dispose() {}, get held() { return false; } };
    const doc = element.ownerDocument, win = doc.defaultView;
    const overlay = doc.createElement('div');
    overlay.className = 'terminal-text-selection';
    overlay.setAttribute('aria-hidden', 'true');
    screen.appendChild(overlay);
    element.classList.add('text-selection');
    const resumeButton = doc.createElement('button');
    resumeButton.className = 'btn terminal-selection-resume hidden';
    resumeButton.textContent = '선택 해제 · 최신 출력 보기';
    resumeButton.title = '작업은 계속 실행 중입니다. 선택을 해제하면 쌓인 출력이 표시됩니다.';
    element.appendChild(resumeButton);
    let held = false, dragging = false, queued = [], queuedSize = 0, frame = null;
    let previousDisableStdin = term.options.disableStdin;

    function paint() {
      frame = null;
      const width = screen.clientWidth / term.cols, height = screen.clientHeight / term.rows;
      overlay.replaceChildren(...textRanges(term).map(range => {
        const box = doc.createElement('div');
        Object.assign(box.style, { left: `${range.start * width}px`, top: `${range.row * height}px`, width: `${(range.end - range.start) * width}px`, height: `${height}px` });
        return box;
      }));
      resumeButton.classList.toggle('hidden', !held || !term.hasSelection());
    }
    function schedulePaint() { if (frame === null) frame = win.requestAnimationFrame(paint); }
    function resume(reason = 'explicit') {
      const wasHeld = held;
      element.dataset.selectionState = typeof reason === 'string' ? reason : 'explicit';
      held = false;
      dragging = false;
      if (wasHeld) term.options.disableStdin = previousDisableStdin;
      term.clearSelection();
      overlay.replaceChildren();
      resumeButton.classList.add('hidden');
      const output = queued.join('');
      queued = []; queuedSize = 0;
      if (output) term.write(output);
      if (wasHeld) onResume?.();
    }
    function mouseDown(event) {
      if (event.button !== 0 || event.altKey || !screen.contains(event.target)) return;
      resume('new-selection');
      previousDisableStdin = term.options.disableStdin;
      held = dragging = true;
      // SGR hover/mouse-up reports count as user input in xterm and clear its
      // selection before onData runs. Block them at the public input gate.
      // Custom keyboard handlers still run, so Ctrl+C can copy and typing can resume.
      term.options.disableStdin = true;
      element.dataset.selectionState = 'held';
      if (term.modes.mouseTrackingMode !== 'none') Object.defineProperty(event, 'shiftKey', { value: true });
    }
    function mouseUp() {
      if (!dragging) return;
      dragging = false;
      if (!term.hasSelection()) resume('empty-selection');
      else schedulePaint();
    }
    function selectionChanged() {
      if (!dragging && held && !term.hasSelection()) resume('selection-cleared');
      schedulePaint();
    }
    function wheel() { if (held && !dragging) resume('wheel'); }
    // Observe xterm's selection redraws while dragging; onSelectionChange fires
    // on mouseup, too late to paint the intermediate drag positions.
    const observer = new win.MutationObserver(schedulePaint);
    const nativeSelection = screen.querySelector('.xterm-selection');
    if (nativeSelection) observer.observe(nativeSelection, { childList: true, subtree: true, attributes: true });
    const subscriptions = [term.onSelectionChange(selectionChanged), term.onRender(schedulePaint), term.onScroll(schedulePaint)];
    element.addEventListener('mousedown', mouseDown, true);
    element.addEventListener('wheel', wheel, { capture: true, passive: true });
    doc.addEventListener('mouseup', mouseUp);
    resumeButton.onclick = resume;

    return {
      get held() { return held; },
      write(data) {
        if (!held) { term.write(data); return; }
        queued.push(data); queuedSize += data.length;
        // Bound memory if a long-running build keeps producing output.
        if (queuedSize > 8 * 1024 * 1024) resume();
      },
      resume,
      dispose() {
        if (held) term.options.disableStdin = previousDisableStdin;
        observer.disconnect();
        if (frame !== null) win.cancelAnimationFrame(frame);
        subscriptions.forEach(subscription => subscription.dispose());
        element.removeEventListener('mousedown', mouseDown, true);
        element.removeEventListener('wheel', wheel, true);
        doc.removeEventListener('mouseup', mouseUp);
        queued = []; overlay.remove(); resumeButton.remove();
        element.classList.remove('text-selection');
      }
    };
  }
  const api = { install, textRanges };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TerminalSelection = api;
})(typeof window === 'undefined' ? globalThis : window);
