// app.js — 공통 유틸리티

window.EYEPOP = window.EYEPOP || {};

EYEPOP.toast = function(msg, type = 'info', duration = 2800) {
  const el = document.getElementById('toast');
  if (!el) { console.log('[toast]', msg); return; }
  el.className = 'toast';
  el.textContent = msg;
  if (type) el.classList.add(type);
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(EYEPOP._toastTimer);
  EYEPOP._toastTimer = setTimeout(() => el.classList.remove('show'), duration);
};

EYEPOP.requireAdminSession = function() {
  try {
    const raw = localStorage.getItem('eyepop-admin-session');
    if (!raw) { location.href = '/admin-login.html'; return false; }
    const s = JSON.parse(raw);
    if (!s.loggedIn) { location.href = '/admin-login.html'; return false; }
    // 8시간 세션 만료
    if (Date.now() - s.loginAt > 8 * 60 * 60 * 1000) {
      localStorage.removeItem('eyepop-admin-session');
      location.href = '/admin-login.html';
      return false;
    }
    return true;
  } catch (e) {
    location.href = '/admin-login.html';
    return false;
  }
};

EYEPOP.logout = function() {
  localStorage.removeItem('eyepop-admin-session');
  location.href = '/';
};

EYEPOP.generateId = function(prefix = 'e') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
};

EYEPOP.escapeHtml = function(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
};
