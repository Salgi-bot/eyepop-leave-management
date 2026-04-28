// cancel.js — 메일 [철회] 링크 클릭 → 확인 → 철회 확정
(() => {
  const params = new URLSearchParams(location.search);
  const token = params.get('t');

  if (!token) {
    document.getElementById('invalidView').style.display = 'block';
    return;
  }

  // 토큰 페이로드 디코드 (서명 검증은 서버에서, 표시용)
  // UTF-8 한글 처리: atob() 결과를 TextDecoder로 디코드
  let payload = null;
  try {
    const body = token.split('.')[0];
    const padded = body.replace(/-/g, '+').replace(/_/g, '/').padEnd(body.length + (4 - body.length % 4) % 4, '=');
    const bytes = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
    const json = new TextDecoder('utf-8').decode(bytes);
    payload = JSON.parse(json);
  } catch {}

  if (!payload || payload.scope !== 'cancel') {
    document.getElementById('invalidView').style.display = 'block';
    return;
  }

  // 만료 표시 검사 (서버 검증과 별개로 사전 안내)
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    document.getElementById('invalidView').innerHTML = `
      <div class="cancel-status-icon">⏰</div>
      <h3>철회 링크 만료</h3>
      <p>철회 링크는 신청 후 30일 동안만 유효합니다.</p>
      <p class="hint">김은주 차장(eunju@eyepopeng.com)에게 연락해주세요.</p>
      <p class="back-link"><a href="/">← 메인으로</a></p>
    `;
    document.getElementById('invalidView').style.display = 'block';
    return;
  }

  // 신청 정보 표시
  document.getElementById('reqInfo').innerHTML = `
    <div class="cancel-info-title">아래 신청을 철회하시겠습니까?</div>
    <table class="cancel-info-table">
      <tr><td>기간</td><td><b>${escapeHtml(payload.startDate)} ~ ${escapeHtml(payload.endDate)}</b></td></tr>
      <tr><td>일수</td><td>${payload.days}일</td></tr>
      <tr><td>종류</td><td>${escapeHtml(payload.leaveType || '-')}</td></tr>
    </table>
  `;
  document.getElementById('confirmView').style.display = 'block';

  // 철회 확정
  const confirmBtn = document.getElementById('confirmBtn');
  confirmBtn.addEventListener('click', async () => {
    const reason = document.getElementById('reasonInput').value.trim();
    confirmBtn.disabled = true;
    confirmBtn.textContent = '처리 중...';
    try {
      const r = await fetch('/api/cancel-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, reason })
      });
      const data = await r.json();
      if (!r.ok) {
        const msg = data.error || `HTTP ${r.status}`;
        const detail = data.detail ? ` (${data.detail})` : '';
        throw new Error(msg + detail);
      }
      document.getElementById('confirmView').style.display = 'none';
      document.getElementById('successView').style.display = 'block';
      if (data.message) document.getElementById('successMsg').textContent = data.message;
    } catch (err) {
      showError(err.message);
      confirmBtn.disabled = false;
      confirmBtn.textContent = '철회 확정';
    }
  });

  function showError(msg) {
    const box = document.getElementById('errorBox');
    box.textContent = msg;
    box.style.display = 'block';
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
})();
