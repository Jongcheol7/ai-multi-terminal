const test = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/headless');
const { JSDOM } = require('jsdom');
const { textRanges, install } = require('../public/terminal-selection');

test('multi-line highlights exclude margins and blank lines without splitting Korean or emoji cells', async t => {
  const term = new Terminal({ cols: 30, rows: 6, allowProposedApi: true });
  t.after(() => term.dispose());
  await new Promise(resolve => term.write('  한글 A   \r\n\r\n😀 끝   ', resolve));
  term.getSelectionPosition = () => ({ start: { x: 0, y: 0 }, end: { x: 20, y: 2 } });
  assert.deepEqual(textRanges(term), [
    { row: 0, start: 2, end: 8 }, { row: 2, start: 0, end: 4 }
  ]);
  term.getSelectionPosition = () => ({ start: { x: 3, y: 0 }, end: { x: 5, y: 0 } });
  assert.deepEqual(textRanges(term), [{ row: 0, start: 2, end: 6 }]);
});

test('mouseup keeps selected output stable until release, then flushes every queued chunk in order', async t => {
  const dom = new JSDOM('<div class="xterm"><div class="xterm-screen"><div class="xterm-selection"></div></div></div>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { document, MouseEvent, WheelEvent } = dom.window;
  const writes = [], callbacks = {};
  let selected = false;
  const subscribe = name => fn => { callbacks[name] = fn; return { dispose() { delete callbacks[name]; } }; };
  const engine = new Terminal({ cols: 30, rows: 6, allowProposedApi: true });
  t.after(() => engine.dispose());
  await new Promise(resolve => engine.write('\x1b[?1003h\x1b[?1006h', resolve));
  const reports = [];
  engine.onData(data => { reports.push(data); selected = false; callbacks.selection?.(); });
  const term = {
    options: engine.options,
    element: document.querySelector('.xterm'), modes: { mouseTrackingMode: 'any' },
    rows: 5, cols: 20, getSelectionPosition: () => undefined,
    hasSelection: () => selected, clearSelection() { selected = false; callbacks.selection?.(); },
    write(data) { writes.push(data); selected = false; callbacks.selection?.(); },
    onSelectionChange: subscribe('selection'), onRender: subscribe('render'), onScroll: subscribe('scroll')
  };
  const controller = install(term), screen = document.querySelector('.xterm-screen');
  const down = new MouseEvent('mousedown', { bubbles: true, button: 0 });
  screen.dispatchEvent(down);
  assert.equal(down.shiftKey, true);
  selected = true;
  document.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
  // A real SGR hover report previously fired xterm's user-input event, clearing
  // the selection immediately after the mouse was released and moved.
  engine._core.coreMouseService.triggerMouseEvent({ col: 5, row: 2, x: 40, y: 32, button: 3, action: 32, ctrl: false, alt: false, shift: false });
  assert.deepEqual(reports, []);
  assert.equal(engine.options.disableStdin, true);
  controller.write('first redraw'); controller.write('second redraw');
  assert.equal(selected, true);
  assert.equal(controller.held, true);
  assert.deepEqual(writes, []);
  screen.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }));
  assert.equal(controller.held, false);
  assert.equal(engine.options.disableStdin, false);
  engine._core.coreMouseService.triggerMouseEvent({ col: 6, row: 2, x: 48, y: 32, button: 3, action: 32, ctrl: false, alt: false, shift: false });
  assert.equal(reports.length, 1);
  assert.deepEqual(writes, ['first redrawsecond redraw']);
  controller.write('live');
  assert.deepEqual(writes, ['first redrawsecond redraw', 'live']);
  controller.dispose();
  assert.equal(document.querySelector('.terminal-text-selection'), null);
  assert.deepEqual(callbacks, {});
});
