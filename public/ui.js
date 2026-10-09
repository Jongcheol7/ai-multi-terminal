(() => {
  const prefix = 'multiTerminal.v2.';
  const modalStack = [];
  function read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(prefix + key)) ?? fallback; }
    catch (_) { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem(prefix + key, JSON.stringify(value)); return true; }
    catch (_) { return false; }
  }
  function remove(key) {
    try { localStorage.removeItem(prefix + key); } catch (_) { /* storage unavailable */ }
  }
  async function request(url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      let data;
      try { data = await response.json(); }
      catch (_) { throw new Error(`서버 응답을 읽지 못했습니다 (HTTP ${response.status}).`); }
      if (!response.ok) throw new Error(data?.error || `요청 실패 (HTTP ${response.status}).`);
      return data;
    } catch (failure) {
      if (controller.signal.aborted) throw new Error('서버 응답이 지연되었습니다. 연결을 확인한 뒤 다시 시도해 주세요.');
      throw failure;
    } finally { clearTimeout(timeout); }
  }
  function error(element, message = '') {
    element.textContent = message;
    element.classList.toggle('hidden', !message);
  }
  function openModal(modal, focusElement) {
    modal.returnFocus = document.activeElement;
    const index = modalStack.indexOf(modal);
    if (index >= 0) modalStack.splice(index, 1);
    modalStack.push(modal);
    modal.classList.remove('hidden');
    (focusElement || modal.querySelector('button, input, textarea, [tabindex]'))?.focus();
  }
  function closeModal(modal) {
    if (modal.dataset.busy === 'true') return;
    modal.classList.add('hidden');
    const index = modalStack.indexOf(modal);
    if (index >= 0) modalStack.splice(index, 1);
    const top = modalStack[modalStack.length - 1];
    if (top) {
      if (!top.contains(document.activeElement)) (top.querySelector('input, textarea, button:not(:disabled)'))?.focus();
    } else if (modal.returnFocus?.isConnected && !modal.returnFocus.closest('.hidden')) modal.returnFocus.focus();
  }
  for (const [index, modal] of [...document.querySelectorAll('.modal')].entries()) {
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const heading = modal.querySelector('h2');
    if (heading) {
      heading.id ||= `modalTitle${index}`;
      modal.setAttribute('aria-labelledby', heading.id);
    }
  }
  document.addEventListener('keydown', event => {
    const modal = modalStack.filter(item => !item.classList.contains('hidden')).pop();
    if (!modal) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (modal.dataset.busy === 'true') return;
      if (modal.id === 'actionModal') modal.querySelector('#actionCancel').click();
      else (modal.querySelector('#btnCloseModal, #btnClipboardClose, #btnCancelToolChoice, #btnCloseHistory, #btnCloseSessionDetails, #btnCloseCommands') || {}).click?.();
    } else if (event.key === 'Tab') {
      const items = [...modal.querySelectorAll('button, input, textarea, select, [tabindex="0"]')]
        .filter(item => !item.disabled && item.getClientRects().length);
      if (!items.length) { event.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    }
  }, true);

  const modal = document.getElementById('actionModal');
  const confirm = document.getElementById('actionConfirm');
  const cancel = document.getElementById('actionCancel');
  let dialogOpen = false;
  function dialog({ title, message, confirmText = '확인', onConfirm, cancelText = '취소' }) {
    if (dialogOpen) return Promise.resolve(false);
    dialogOpen = true;
    document.getElementById('actionTitle').textContent = title;
    document.getElementById('actionMessage').textContent = message;
    error(document.getElementById('actionError'));
    confirm.textContent = confirmText;
    cancel.textContent = cancelText;
    cancel.classList.toggle('hidden', !onConfirm);
    openModal(modal, onConfirm ? cancel : confirm);
    return new Promise(resolve => {
      function finish(result) {
        modal.dataset.busy = 'false';
        confirm.disabled = cancel.disabled = false;
        closeModal(modal);
        dialogOpen = false;
        confirm.onclick = cancel.onclick = null;
        resolve(result);
      }
      cancel.onclick = () => { if (modal.dataset.busy !== 'true') finish(false); };
      confirm.onclick = async () => {
        if (modal.dataset.busy === 'true') return;
        modal.dataset.busy = 'true';
        confirm.disabled = cancel.disabled = true;
        error(document.getElementById('actionError'));
        try { if (onConfirm) await onConfirm(); finish(true); }
        catch (failure) {
          error(document.getElementById('actionError'), failure.message);
          modal.dataset.busy = 'false';
          confirm.disabled = cancel.disabled = false;
          confirm.textContent = '다시 시도';
          confirm.focus();
        }
      };
    });
  }
  window.TerminalUI = { read, write, remove, request, error, openModal, closeModal, dialog };
})();
