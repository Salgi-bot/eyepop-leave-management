// apply.js — 직원 연차 신청 폼 제출

(function () {
  const form = document.getElementById('applyForm');
  const submitBtn = document.getElementById('submitBtn');
  const errorBox = document.getElementById('errorBox');
  const successBox = document.getElementById('successBox');
  const successTitle = document.getElementById('successTitle');
  const successMsg = document.getElementById('successMsg');

  const startEl = document.getElementById('startDate');
  const endEl = document.getElementById('endDate');
  const daysEl = document.getElementById('days');
  const typeEl = document.getElementById('leaveType');
  const reasonEl = document.getElementById('reason');

  // 과거 날짜도 신청 가능 (부득이 후신청). min 제한 없음.

  // 일수 자동 계산
  function recalcDays() {
    const t = typeEl.value;
    if (t === '오전반차' || t === '오후반차') {
      daysEl.value = 0.5;
      // 반차는 단일 일자 → endDate를 startDate와 동일하게
      if (startEl.value) endEl.value = startEl.value;
      return;
    }
    if (!startEl.value || !endEl.value) return;
    const s = new Date(startEl.value);
    const e = new Date(endEl.value);
    if (isNaN(s) || isNaN(e) || e < s) {
      daysEl.value = '';
      return;
    }
    const diff = Math.floor((e - s) / 86400000) + 1;
    daysEl.value = diff;
  }

  startEl.addEventListener('change', () => {
    if (startEl.value && (!endEl.value || new Date(endEl.value) < new Date(startEl.value))) {
      endEl.value = startEl.value;
    }
    recalcDays();
  });
  endEl.addEventListener('change', recalcDays);
  typeEl.addEventListener('change', recalcDays);

  // 민감정보 단어 경고 (사전 안내)
  const SENSITIVE = ['병원', '진단', '수술', '치료', '암', '우울', '정신', '약', '입원'];
  reasonEl.addEventListener('blur', () => {
    const v = reasonEl.value || '';
    const hit = SENSITIVE.find(w => v.includes(w));
    if (hit) {
      EYEPOP.toast(`⚠️ 민감정보 단어 감지("${hit}") — 일반적 표현 권장`, 'warning', 4000);
    }
  });

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.style.display = 'block';
    errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function clearError() {
    errorBox.textContent = '';
    errorBox.style.display = 'none';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();

    const payload = {
      name: document.getElementById('name').value.trim(),
      email: document.getElementById('email').value.trim(),
      startDate: startEl.value,
      endDate: endEl.value,
      days: Number(daysEl.value),
      leaveType: typeEl.value,
      reason: reasonEl.value.trim(),
      verbalReportConfirmed: document.getElementById('verbalReportConfirmed').checked
    };

    // 클라이언트 검증
    if (!payload.name || !payload.email || !payload.startDate || !payload.endDate) {
      showError('필수 항목을 모두 입력하세요.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
      showError('이메일 형식이 올바르지 않습니다.');
      return;
    }
    if (!payload.days || payload.days <= 0) {
      showError('사용 일수가 올바르지 않습니다.');
      return;
    }
    if (new Date(payload.endDate) < new Date(payload.startDate)) {
      showError('종료일은 시작일 이후여야 합니다.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = '제출 중...';

    try {
      const resp = await fetch('/.netlify/functions/submit-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await resp.json();

      if (!resp.ok) {
        showError(data.error || '신청 처리 중 오류가 발생했습니다.');
        if (data.remaining != null) {
          showError(`${data.error} (잔여: ${data.remaining}일)`);
        }
        return;
      }

      // 성공
      form.style.display = 'none';
      successTitle.textContent =
        data.requestStatus === 'auto_approved' ? '✅ 연차가 자동 승인되었습니다' : '📩 신청이 접수되었습니다';
      successMsg.textContent =
        `${payload.name}님의 ${payload.startDate} ~ ${payload.endDate} (${payload.days}일) 신청이 ` +
        (data.requestStatus === 'auto_approved' ? '승인 처리되었습니다.' : '관리자 승인 대기 중입니다.') +
        ` 신청 후 잔여 ${data.remainingAfter}일.`;
      successBox.style.display = 'block';
      successBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
      EYEPOP.toast('신청 완료', 'success');
    } catch (err) {
      showError('네트워크 오류: ' + err.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '신청 제출';
    }
  });
})();
