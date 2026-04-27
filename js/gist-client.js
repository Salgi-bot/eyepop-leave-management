// gist-client.js — Netlify Functions 호출 래퍼
// 관리자 키는 /admin-key 엔드포인트 또는 관리자가 직접 localStorage에 입력
// (Phase A: 간단히 localStorage에 저장된 키를 헤더로 전송)

window.EYEPOP = window.EYEPOP || {};

EYEPOP.gist = (function() {
  const API = '/.netlify/functions';

  function getAdminKey() {
    const k = localStorage.getItem('eyepop-admin-key');
    if (!k) {
      // 세션 만료 또는 키 손실 → 로그인 페이지로 리다이렉트
      location.href = '/admin-login.html';
      return null;
    }
    return k;
  }

  async function call(endpoint, payload) {
    const key = getAdminKey();
    if (!key) throw new Error('ADMIN_KEY not provided');

    const resp = await fetch(`${API}/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': key
      },
      body: JSON.stringify(payload || {})
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text }; }

    if (!resp.ok) {
      if (resp.status === 401) {
        localStorage.removeItem('eyepop-admin-key');
      }
      throw new Error(data.error || `HTTP ${resp.status}`);
    }
    return data;
  }

  return {
    read: (file) => call('gist-proxy', { action: 'read', file }),
    write: (file, content) => call('gist-proxy', { action: 'write', file, content }),
    readAll: () => call('gist-proxy', { action: 'read' }),
    resetAdminKey: () => localStorage.removeItem('eyepop-admin-key')
  };
})();
