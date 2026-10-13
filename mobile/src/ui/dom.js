/** Minimal DOM helper: h('div.class', {attrs}, ...children). */
export function h(tag, attrs = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

export function toast(message, ms = 3200) {
  const el = h('div.toast', { role: 'status', text: message });
  document.body.append(el);
  setTimeout(() => el.classList.add('gone'), ms);
  setTimeout(() => el.remove(), ms + 400);
}

export function sheet(title, body, { onClose } = {}) {
  const close = () => {
    wrap.remove();
    onClose?.();
  };
  const wrap = h(
    'div.sheet-backdrop',
    { onclick: (e) => e.target === wrap && close() },
    h(
      'section.sheet',
      { role: 'dialog', 'aria-label': title },
      h('header.sheet-head', {}, h('h2', { text: title }), h('button.icon', { 'aria-label': 'Close', onclick: close, text: '✕' })),
      h('div.sheet-body', {}, body),
    ),
  );
  document.body.append(wrap);
  return { close, el: wrap };
}
