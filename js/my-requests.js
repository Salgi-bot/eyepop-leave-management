// my-requests.js — 직원 본인 인증 + 신청 조회·철회
(() => {
  const SESSION_KEY = 'eyepop-my-requests-session';
  const STATUS_LABEL = {
    'pending': '대기',
    'auto_approved': '자동 승인',
    'approved': '승인',
    'rejected': '반려',
    'cancelled': '철회'
  };
  const CANCELLABLE = new Set(['pending', 'auto_approved', 'approved']);

  let otpToken = null;     // request-otp 응답 토큰 (메모리만 — 5분)
  let session = null;      // verify-otp 응답 (sessionToken·이름·요청 목록 — sessionStorage)
  let lastEmail = '';

  // ── 시작 시 세션 복구 시도 ──
  try {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored) session = JSON.parse(stored);
  } catch {}
  if (session?.sessionToken) {
    showRequests();
  }

  // ── Step 1 → 2: 인증 코드 받기 ──
  const requestBtn = document.getElementById('requestOtpBtn');
  requestBtn.addEventListener('click', async () => {
    const name = document.getElementById('authName').value.trim();
    const email = document.getElementById('authEmail').value.trim().toLowerCase();
    if (!name || !email) return showError('이름과 이메일을 모두 입력하세요.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showError('이메일 형식이 올바르지 않습니다.');

    requestBtn.disabled = true;
    requestBtn.textContent = '발송 중...';
    try {
      const r = await api('/api/request-otp', { name, email });
      otpToken = r.token;
      lastEmail = email;
      document.getElementById('otpEmailHint').textContent = email;
      switchStep(2);
      EYEPOP.toast('인증 코드를 메일로 발송했습니다. 메일함을 확인하세요.', 'success', 4000);
      setTimeout(() => document.getElementById('authOtp').focus(), 100);
    } catch (err) {
      showError(err.message);
    } finally {
      requestBtn.disabled = false;
      requestBtn.textContent = '📧 인증 코드 받기';
    }
  });

  // ── 다시 받기 ──
  document.getElementById('resendOtpBtn').addEventListener('click', async () => {
    if (!lastEmail) { switchStep(1); return; }
    const name = document.getElementById('authName').value.trim();
    try {
      const r = await api('/api/request-otp', { name, email: lastEmail });
      otpToken = r.token;
      EYEPOP.toast('새 인증 코드를 발송했습니다.', 'success');
    } catch (err) { showError(err.message); }
  });

  // ── Step 2 → 3: OTP 검증 ──
  const verifyBtn = document.getElementById('verifyOtpBtn');
  verifyBtn.addEventListener('click', async () => {
    const otp = document.getElementById('authOtp').value.trim();
    if (!/^\d{6}$/.test(otp)) return showError('6자리 숫자를 입력하세요.');
    if (!otpToken) return showError('인증 코드를 먼저 요청하세요.');

    verifyBtn.disabled = true;
    verifyBtn.textContent = '확인 중...';
    try {
      const r = await api('/api/verify-otp', { token: otpToken, otp });
      session = {
        sessionToken: r.sessionToken,
        employeeName: r.employeeName,
        requests: r.requests || [],
        savedAt: Date.now()
      };
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
      otpToken = null;
      showRequests();
    } catch (err) {
      showError(err.message);
    } finally {
      verifyBtn.disabled = false;
      verifyBtn.textContent = '확인';
    }
  });

  // Enter 키로 단계 진행
  document.getElementById('authEmail').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') requestBtn.click();
  });
  document.getElementById('authOtp').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') verifyBtn.click();
  });

  // ── 로그아웃 ──
  document.getElementById('logoutBtn').addEventListener('click', () => {
    sessionStorage.removeItem(SESSION_KEY);
    session = null;
    location.reload();
  });

  // ── 신청 목록 표시 ──
  function showRequests() {
    if (!session) { switchStep(1); return; }
    document.getElementById('welcomeMsg').textContent = `${session.employeeName}님 환영합니다.`;
    renderRequests(session.requests);
    document.getElementById('authStep1').style.display = 'none';
    document.getElementById('authStep2').style.display = 'none';
    document.getElementById('requestsView').style.display = 'block';
  }

  function renderRequests(requests) {
    const container = document.getElementById('requestsList');
    if (!requests || requests.length === 0) {
      container.innerHTML = '<p class="empty-msg">신청 내역이 없습니다.</p>';
      return;
    }
    container.innerHTML = requests.map(r => {
      const canCancel = CANCELLABLE.has(r.status);
      const cancelledLine = r.cancelledAt
        ? `<div class="req-cancelled-info">철회: ${escapeHtml(r.cancelledAt.slice(0,16).replace('T',' '))}</div>`
        : '';
      return `
        <div class="request-card status-${escapeHtml(r.status)}" data-id="${escapeHtml(r.id)}">
          <div class="req-head">
            <span class="status-badge status-${escapeHtml(r.status)}">${STATUS_LABEL[r.status] || r.status}</span>
            <span class="req-date">${escapeHtml(r.startDate)} ~ ${escapeHtml(r.endDate)}</span>
          </div>
          <div class="req-body">
            <div class="req-meta"><b>${r.days}일</b> · ${escapeHtml(r.leaveType || '-')}</div>
            <div class="req-reason">사유: ${escapeHtml(r.reason || '-')}</div>
            ${cancelledLine}
          </div>
          ${canCancel ? `<button class="btn-danger btn-small req-cancel-btn" data-id="${escapeHtml(r.id)}">철회</button>` : ''}
        </div>
      `;
    }).join('');

    container.querySelectorAll('.req-cancel-btn').forEach(btn => {
      btn.addEventListener('click', () => openCancelModal(btn.dataset.id));
    });
  }

  // ── 철회 모달 ──
  function openCancelModal(id) {
    const r = session.requests.find(x => x.id === id);
    if (!r) return;
    document.getElementById('cancelInfo').innerHTML = `
      <div class="cancel-info-row"><b>${escapeHtml(r.startDate)} ~ ${escapeHtml(r.endDate)}</b> · ${r.days}일 · ${escapeHtml(r.leaveType || '-')}</div>
      <div class="cancel-info-reason">사유: ${escapeHtml(r.reason || '-')}</div>
    `;
    document.getElementById('cancelTargetId').value = id;
    document.getElementById('cancelReason').value = '';
    document.getElementById('cancelModal').style.display = 'flex';
  }

  document.getElementById('cancelCancelBtn').addEventListener('click', () => {
    document.getElementById('cancelModal').style.display = 'none';
  });

  const confirmBtn = document.getElementById('cancelConfirmBtn');
  confirmBtn.addEventListener('click', async () => {
    const id = document.getElementById('cancelTargetId').value;
    const reason = document.getElementById('cancelReason').value.trim();
    if (!session?.sessionToken) {
      showError('세션이 만료되었습니다. 다시 로그인하세요.');
      sessionStorage.removeItem(SESSION_KEY);
      setTimeout(() => location.reload(), 1500);
      return;
    }
    confirmBtn.disabled = true;
    confirmBtn.textContent = '처리 중...';
    try {
      await api('/api/cancel-request', { sessionToken: session.sessionToken, requestId: id, reason });
      // 로컬 세션 업데이트
      const idx = session.requests.findIndex(x => x.id === id);
      if (idx >= 0) {
        session.requests[idx].status = 'cancelled';
        session.requests[idx].cancelledAt = new Date().toISOString();
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
      }
      renderRequests(session.requests);
      document.getElementById('cancelModal').style.display = 'none';
      EYEPOP.toast('철회 완료. 본인·관리자·팀장에게 메일이 발송되었습니다.', 'success', 5000);
    } catch (err) {
      showError(err.message);
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = '철회 확정';
    }
  });

  // ── 헬퍼 ──
  async function api(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    let data;
    try { data = await r.json(); } catch { data = {}; }
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }

  function switchStep(n) {
    document.getElementById('authStep1').style.display = n === 1 ? 'block' : 'none';
    document.getElementById('authStep2').style.display = n === 2 ? 'block' : 'none';
    document.getElementById('requestsView').style.display = 'none';
  }

  function showError(msg) {
    const box = document.getElementById('errorBox');
    box.textContent = msg;
    box.style.display = 'block';
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => { box.style.display = 'none'; }, 6000);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
})();
