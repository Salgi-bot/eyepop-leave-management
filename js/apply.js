// apply.js — 직원 연차 신청 폼 (일자별 정밀 입력)

(function () {
  const form = document.getElementById('applyForm');
  const submitBtn = document.getElementById('submitBtn');
  const errorBox = document.getElementById('errorBox');
  const successBox = document.getElementById('successBox');
  const successTitle = document.getElementById('successTitle');
  const successMsg = document.getElementById('successMsg');

  const startEl = document.getElementById('startDate');
  const endEl = document.getElementById('endDate');
  const reasonEl = document.getElementById('reason');
  const entriesSection = document.getElementById('entriesSection');
  const entriesList = document.getElementById('entriesList');
  const totalRow = document.getElementById('totalRow');
  const totalEl = document.getElementById('totalDays');

  const TYPE_DAYS = {
    '연차': 1,
    '3/4차': 0.75,
    '반차': 0.5,
    '오전반차': 0.5,   // 호환: 기존 데이터 인식용
    '오후반차': 0.5,   // 호환: 기존 데이터 인식용
    '반반차': 0.25,
    '없음': 0
  };
  // 시간 입력 필요 타입 (반차·반반차)
  const NEEDS_TIME = new Set(['반차', '반반차']);

  const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

  function formatDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const w = WEEKDAY[d.getDay()];
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    return { label: `${m}/${day} (${w})`, isWeekend };
  }

  // YYYY-MM-DD 문자열 → 로컬 Date (timezone 안전)
  function parseYmd(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function formatYmd(dt) {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // 날짜 변경 시 entries 자동 생성
  function rebuildEntries() {
    if (!startEl.value || !endEl.value) {
      entriesSection.style.display = 'none';
      totalRow.style.display = 'none';
      return;
    }
    const s = parseYmd(startEl.value);
    const e = parseYmd(endEl.value);
    if (isNaN(s) || isNaN(e) || e < s) {
      entriesSection.style.display = 'none';
      totalRow.style.display = 'none';
      return;
    }
    const diffDays = Math.round((e - s) / 86400000) + 1;
    if (diffDays > 30) {
      showError('기간은 최대 30일까지 가능합니다.');
      entriesSection.style.display = 'none';
      return;
    }
    clearError();

    const dates = [];
    let d = new Date(s);
    while (d <= e) {
      dates.push(formatYmd(d));
      d.setDate(d.getDate() + 1);
    }
    renderEntries(dates);
    entriesSection.style.display = 'block';
    totalRow.style.display = 'block';
  }

  function renderEntries(dates) {
    entriesList.innerHTML = dates.map((iso, i) => {
      const { label, isWeekend } = formatDate(iso);
      const defaultType = isWeekend ? '없음' : '연차';
      return `
      <div class="entry-row${isWeekend ? ' weekend' : ''}" data-idx="${i}" data-date="${iso}">
        <span class="entry-date">${label}</span>
        <select class="entry-type">
          <option value="연차" ${defaultType === '연차' ? 'selected' : ''}>연차 (1일)</option>
          <option value="3/4차">3/4차 (0.75일)</option>
          <option value="반차">반차 (0.5일, 4시간 시간 입력)</option>
          <option value="반반차">반반차 (0.25일, 2시간 시간 입력)</option>
          <option value="없음" ${defaultType === '없음' ? 'selected' : ''}>사용 안함 (0일)</option>
        </select>
        <input type="text" class="entry-time" placeholder="09:00~14:00 (오전반차 시 점심 1시간 제외) 또는 14:00~18:00" style="display:none;">
      </div>`;
    }).join('');

    entriesList.querySelectorAll('.entry-row').forEach(row => {
      const select = row.querySelector('.entry-type');
      const time = row.querySelector('.entry-time');
      select.addEventListener('change', () => {
        const needsTime = NEEDS_TIME.has(select.value);
        time.style.display = needsTime ? 'block' : 'none';
        if (!needsTime) time.value = '';
        recalcTotal();
      });
    });

    recalcTotal();
  }

  function recalcTotal() {
    const rows = entriesList.querySelectorAll('.entry-row');
    let total = 0;
    rows.forEach(row => {
      const t = row.querySelector('.entry-type').value;
      total += TYPE_DAYS[t] || 0;
    });
    totalEl.textContent = total;
  }

  function getEntries() {
    const rows = entriesList.querySelectorAll('.entry-row');
    return Array.from(rows)
      .map(row => {
        const type = row.querySelector('.entry-type').value;
        if (type === '없음') return null;
        const timeRange = row.querySelector('.entry-time').value.trim();
        return {
          date: row.dataset.date,
          type,
          days: TYPE_DAYS[type],
          timeRange: NEEDS_TIME.has(type) ? timeRange : null
        };
      })
      .filter(Boolean);
  }

  startEl.addEventListener('change', () => {
    if (startEl.value && (!endEl.value || new Date(endEl.value) < new Date(startEl.value))) {
      endEl.value = startEl.value;
    }
    rebuildEntries();
  });
  endEl.addEventListener('change', rebuildEntries);

  // 기타 선택 시 직접 입력란 표시
  const reasonEtcEl = document.getElementById('reasonEtc');
  reasonEl.addEventListener('change', () => {
    if (reasonEl.value === '기타') {
      reasonEtcEl.style.display = 'block';
      reasonEtcEl.required = true;
    } else {
      reasonEtcEl.style.display = 'none';
      reasonEtcEl.required = false;
      reasonEtcEl.value = '';
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

    const entries = getEntries();
    const totalDays = entries.reduce((s, x) => s + x.days, 0);

    const payload = {
      name: document.getElementById('name').value.trim(),
      email: document.getElementById('email').value.trim(),
      startDate: startEl.value,
      endDate: endEl.value,
      entries,
      days: totalDays,
      reason: reasonEl.value === '기타'
        ? ('기타: ' + (reasonEtcEl.value.trim()))
        : reasonEl.value.trim(),
      verbalReportConfirmed: document.getElementById('verbalReportConfirmed').checked
    };

    if (!payload.name || !payload.email || !payload.startDate || !payload.endDate) {
      showError('필수 항목을 모두 입력하세요.');
      return;
    }
    if (!reasonEl.value) {
      showError('사유를 선택하세요. (필수)');
      reasonEl.focus();
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
      showError('이메일 형식이 올바르지 않습니다.');
      return;
    }
    if (entries.length === 0 || totalDays === 0) {
      showError('최소 1일 이상의 사용 내역을 선택하세요.');
      return;
    }

    // 반차·반반차 시간 검증
    const missingTime = entries.find(e => NEEDS_TIME.has(e.type) && !e.timeRange);
    if (missingTime) {
      const example = missingTime.type === '반차' ? '09:00~14:00 또는 14:00~18:00' : '13:00~15:00';
      showError(`${missingTime.type}(${missingTime.date})는 시간을 입력해 주세요. (예: ${example})`);
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = '제출 중...';

    try {
      const resp = await fetch('/api/submit-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await resp.json();

      if (!resp.ok) {
        let msg = data.error || '신청 처리 중 오류가 발생했습니다.';
        if (data.remaining != null) msg = `${msg} (잔여: ${data.remaining}일)`;
        showError(msg);
        return;
      }

      form.style.display = 'none';
      successTitle.textContent =
        data.requestStatus === 'auto_approved' ? '✅ 연차가 자동 승인되었습니다' : '📩 신청이 접수되었습니다';
      successMsg.textContent =
        `${payload.name}님의 ${payload.startDate} ~ ${payload.endDate} 기간 ${totalDays}일 신청이 ` +
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
