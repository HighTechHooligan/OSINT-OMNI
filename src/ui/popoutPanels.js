/**
 * Pop-out panels: floating, draggable, resizable views that can sit side by
 * side over the globe (several dossiers at once) or be popped out into their
 * own browser window for a second screen.
 *
 * Any feature can request one:
 *   const panel = panels.open({ key, title, subtitle, render(body) {...} });
 *   panel.update({ title, subtitle });   // header text
 *   panel.body                            // the element render() filled
 *
 * Opening an already-open key focuses it instead of duplicating it. A popped
 * out window keeps the very same DOM nodes (adoptNode), so updates made after
 * popping out still land; closing that window docks the panel back.
 */

const STEP_PX = 28;

export function createPopoutPanels({
  root = document.body,
  maxPanels = 8,
  win = window,
} = {}) {
  /** @type {Map<string, object>} */
  const open = new Map();
  let z = 160;
  let cascade = 0;
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn([...open.keys()]));

  function place(el) {
    const w = Math.min(380, win.innerWidth - 32);
    const left = Math.max(16, win.innerWidth - w - 24 - cascade * STEP_PX);
    const top = Math.max(16, 72 + cascade * STEP_PX);
    cascade = (cascade + 1) % 8;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${w}px`;
  }

  function focus(entry) {
    if (entry.popped) {
      entry.popped.focus();
      return;
    }
    entry.el.style.zIndex = String(++z);
    for (const other of open.values())
      other.el.classList.toggle('popout-front', other === entry);
  }

  function makeDraggable(entry, handle) {
    handle.addEventListener('pointerdown', (event) => {
      if (entry.popped || event.button !== 0 || event.target.closest('button'))
        return;
      const el = entry.el;
      const startX = event.clientX - el.offsetLeft;
      const startY = event.clientY - el.offsetTop;
      handle.setPointerCapture(event.pointerId);
      const move = (e) => {
        el.style.left = `${Math.min(win.innerWidth - 60, Math.max(-el.offsetWidth + 80, e.clientX - startX))}px`;
        el.style.top = `${Math.min(win.innerHeight - 40, Math.max(0, e.clientY - startY))}px`;
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  function dockBack(entry) {
    const child = entry.popped;
    if (!child) return;
    entry.popped = null;
    root.appendChild(root.ownerDocument.adoptNode(entry.el));
    entry.el.classList.remove('popout-windowed');
    entry.el.querySelector('[data-pp="popout"]').hidden = false;
    entry.el.querySelector('[data-pp="dock"]').hidden = true;
    place(entry.el);
    focus(entry);
    try {
      if (!child.closed) child.close();
    } catch {
      // window already gone
    }
  }

  /** Move the panel into its own browser window. */
  function popOut(entry) {
    if (entry.popped) return entry.popped.focus();
    const rect = entry.el.getBoundingClientRect();
    const child = win.open(
      '',
      `omni-${entry.key.replace(/[^\w-]/g, '_')}`,
      `popup,width=${Math.round(Math.max(360, rect.width))},height=${Math.round(Math.max(420, rect.height))}`,
    );
    if (!child) {
      entry.update({
        note: 'Pop-out blocked by the browser. Allow pop-ups for this site and try again.',
      });
      return null;
    }
    const doc = child.document;
    doc.open();
    doc.write(
      '<!doctype html><html><head><meta charset="utf-8"><title></title></head><body class="popout-window-body"></body></html>',
    );
    doc.close();
    doc.title = `${entry.title} · OSINT OMNI`;
    const source = root.ownerDocument;
    for (const node of source.querySelectorAll('style, link[rel="stylesheet"]'))
      doc.head.appendChild(doc.importNode(node, true));
    doc.documentElement.className = source.documentElement.className;
    doc.body.className += ` ${source.body.className}`;
    entry.popped = child;
    entry.el.classList.add('popout-windowed');
    entry.el.style.removeProperty('left');
    entry.el.style.removeProperty('top');
    entry.el.style.removeProperty('width');
    entry.el.querySelector('[data-pp="popout"]').hidden = true;
    entry.el.querySelector('[data-pp="dock"]').hidden = false;
    doc.body.appendChild(doc.adoptNode(entry.el));
    child.addEventListener('pagehide', () => {
      if (entry.popped === child && open.has(entry.key)) dockBack(entry);
    });
    return child;
  }

  function close(entry) {
    if (!open.has(entry.key)) return;
    open.delete(entry.key);
    const child = entry.popped;
    entry.popped = null;
    entry.el.remove();
    try {
      if (child && !child.closed) child.close();
    } catch {
      // ignore
    }
    entry.onClose?.();
    emit();
  }

  /**
   * Open (or focus) a panel.
   * @param {{ key:string, title:string, subtitle?:string, kind?:string,
   *   render:(body:HTMLElement, panel:object)=>void, onClose?:()=>void }} spec
   */
  function openPanel({
    key,
    title,
    subtitle = '',
    kind = 'view',
    render,
    onClose,
  }) {
    const existing = open.get(key);
    if (existing) {
      focus(existing);
      return existing.handle;
    }
    if (open.size >= maxPanels) close(open.values().next().value);
    const doc = root.ownerDocument;
    const el = doc.createElement('section');
    el.className = `popout-panel popout-${kind}`;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', title);
    el.innerHTML = `
      <header class="popout-head">
        <div class="popout-titles">
          <span class="popout-kind"></span>
          <strong class="popout-title"></strong>
          <small class="popout-subtitle"></small>
        </div>
        <div class="popout-actions">
          <button type="button" data-pp="min" title="Collapse" aria-label="Collapse">▁</button>
          <button type="button" data-pp="popout" title="Open in its own window" aria-label="Pop out to a new window">⧉</button>
          <button type="button" data-pp="dock" title="Dock back into the app" aria-label="Dock back" hidden>⇲</button>
          <button type="button" data-pp="close" title="Close" aria-label="Close">×</button>
        </div>
      </header>
      <p class="popout-note" hidden></p>
      <div class="popout-body"></div>`;
    const entry = { key, el, title, popped: null, onClose };
    const $ = (sel) => el.querySelector(sel);
    entry.update = ({ title: t, subtitle: s, note } = {}) => {
      if (t != null) {
        entry.title = t;
        $('.popout-title').textContent = t;
        el.setAttribute('aria-label', t);
        if (entry.popped) entry.popped.document.title = `${t} · OSINT OMNI`;
      }
      if (s != null) $('.popout-subtitle').textContent = s;
      if (note !== undefined) {
        $('.popout-note').textContent = note || '';
        $('.popout-note').hidden = !note;
      }
    };
    $('.popout-kind').textContent = kind.toUpperCase();
    entry.update({ title, subtitle });
    $('[data-pp="close"]').addEventListener('click', () => close(entry));
    $('[data-pp="popout"]').addEventListener('click', () => popOut(entry));
    $('[data-pp="dock"]').addEventListener('click', () => dockBack(entry));
    $('[data-pp="min"]').addEventListener('click', () =>
      el.classList.toggle('popout-collapsed'),
    );
    el.addEventListener('pointerdown', () => focus(entry));
    el.addEventListener('keydown', (event) => {
      event.stopPropagation(); // keep globe shortcuts out while typing here
      if (event.key === 'Escape') close(entry);
    });
    makeDraggable(entry, $('.popout-head'));
    entry.handle = {
      key,
      body: $('.popout-body'),
      update: entry.update,
      close: () => close(entry),
      focus: () => focus(entry),
      popOut: () => popOut(entry),
      get poppedOut() {
        return Boolean(entry.popped);
      },
    };
    open.set(key, entry);
    root.appendChild(el);
    place(el);
    focus(entry);
    render?.(entry.handle.body, entry.handle);
    emit();
    return entry.handle;
  }

  return {
    open: openPanel,
    get: (key) => open.get(key)?.handle ?? null,
    keys: () => [...open.keys()],
    closeAll() {
      for (const entry of [...open.values()]) close(entry);
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      for (const entry of [...open.values()]) close(entry);
      listeners.clear();
    },
  };
}
