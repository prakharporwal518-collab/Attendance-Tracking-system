/** Small DOM and formatting helpers shared by every view. */

/** Escape text before putting it into an HTML template string. */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export const $ = (selector, scope = document) => scope.querySelector(selector);
export const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

export function toast(message, kind = '') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`.trim();
  node.textContent = message;
  document.getElementById('toasts').append(node);
  setTimeout(() => node.remove(), 4000);
}

/** Today in the browser's timezone, as YYYY-MM-DD. */
export function today() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 10);
}

/** "2026-09-20" -> "20 Sep 2026" */
export function formatDate(value) {
  if (!value) return '—';
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

/** "2026-09-20" -> "20 Sep" */
export function formatShortDate(value) {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}

export function initials(name) {
  return String(name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('') || '?';
}

export const statusBadge = (status) =>
  status ? `<span class="badge ${esc(status)}">${esc(status)}</span>` : '<span class="muted">—</span>';

export const roleBadge = (role) => `<span class="badge role-${esc(role)}">${esc(role)}</span>`;

/** A percentage with a coloured progress bar. `rate` may be null. */
export function rateBar(rate) {
  if (rate === null || rate === undefined) {
    return '<span class="muted small">No sessions yet</span>';
  }
  const tone = rate >= 75 ? '' : rate >= 60 ? 'warn' : 'bad';
  return `
    <div class="rate">
      <div class="bar ${tone}"><span style="width:${Math.max(0, Math.min(100, rate))}%"></span></div>
      <span class="num">${rate.toFixed(1)}%</span>
    </div>`;
}

export function emptyState(message, icon = '📋') {
  return `<div class="empty"><span class="big">${icon}</span>${esc(message)}</div>`;
}

export const loading = () => '<div class="loading">Loading…</div>';

/**
 * Show a modal. `render` returns the inner HTML; `onMount` receives the modal
 * element and a `close` function.
 */
export function openModal({ title, body, footer = '', onMount }) {
  const root = document.getElementById('modal-root');

  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <header><h2>${esc(title)}</h2><button type="button" data-close aria-label="Close">×</button></header>
        <div class="modal-body">${body}</div>
        ${footer ? `<footer>${footer}</footer>` : ''}
      </div>
    </div>`;

  const close = () => {
    root.innerHTML = '';
    document.removeEventListener('keydown', onKey);
  };

  function onKey(event) {
    if (event.key === 'Escape') close();
  }

  document.addEventListener('keydown', onKey);

  root.querySelector('.modal-backdrop').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) close();
  });
  $$('[data-close]', root).forEach((button) => button.addEventListener('click', close));

  const focusable = root.querySelector('input, select, textarea, button:not([data-close])');
  focusable?.focus();

  onMount?.(root.querySelector('.modal'), close);
  return close;
}

/** Ask for confirmation before a destructive action. */
export function confirmAction({ title, message, confirmLabel = 'Delete', onConfirm }) {
  openModal({
    title,
    body: `<p>${esc(message)}</p>`,
    footer: `
      <button class="btn ghost" data-close>Cancel</button>
      <button class="btn danger" data-confirm>${esc(confirmLabel)}</button>`,
    onMount(modal, close) {
      modal.querySelector('[data-confirm]').addEventListener('click', async () => {
        close();
        await onConfirm();
      });
    }
  });
}

/** Read a form into a plain object, trimming string values. */
export function formData(form) {
  const data = {};
  for (const [key, value] of new FormData(form).entries()) {
    data[key] = typeof value === 'string' ? value.trim() : value;
  }
  return data;
}
