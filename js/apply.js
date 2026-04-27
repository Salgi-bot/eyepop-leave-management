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
    '오전반차': 0.5,
    '오후반차': 0.5,
    '반반차': 0.25,
    '없음': 0
  };

  const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

  function formatDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const w = WEEKDAY[d.getDay()];
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    return { label: `${m}/${day} (${w})`, isWeekend };
  }

  // 날짜 변경 시 entries 자동 생성
  function rebuildEntries() {
    if (!startEl.value || !endEl.value) {
      entriesSection.style.display = 'none';
      totalRow.style.display = 'none';
      return;
    }
    const s = new Date(startEl.value + 'T00:00:00');
    const e = new Date(endEl.value + 'T00:00:00');
    if (isNaN(s) || isNaN(e) || e < s) {
      entriesSection.style.display = 'none';
      totalRow.style.display = 'none';
      return;
    }
    // 최대 30일 제한
    const diffDays = Math.floor((e - s) / 86400000) + 1;
    if (diffDays > 30) {
      showError('기간은 최대 30일까지 가능합니다.');
      entriesSection.style.display = 'none';
      return;
    }
    clearError();

    const dates = [];
    let d = new Date(s);
    while (d <= e) {
      dates.push(d.toISOString().slice(0, 10));
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
          <option value="오전반차">오전반차 (0.5일)</option>
          <option value="오후반차">오후반차 (0.5일)</option>
          <option value="반반차">반반차 (0.25일)</option>
          <option value="없음" ${defaultType === '없음' ? 'selected' : ''}>사용 안함 (0일)</option>
        </select>
        <input type="text" class="entry-time" placeholder="13:00~15:00" style="display:none;">
      </div>`;
    }).join('');

    entriesList.querySelectorAll('.entry-row').forEach(row => {
      const select = row.querySelector('.entry-type');
      const time = row.querySelector('.entry-time');
      select.addEventListener('change', () => {
        time.style.display = select.value === '반반차' ? 'block' : 'none';
        if (select.value !== '반반차') time.value = '';
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
          timeRange: type === '반반차' ? timeRange : null
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

  // 민감정보 단어 경고
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

    const entries = getEntries();
    const totalDays = entries.reduce((s, x) => s + x.days, 0);

    const payload = {
      name: document.getElementById('name').value.trim(),
      email: document.getElementById('email').value.trim(),
      startDate: startEl.value,
      endDate: endEl.value,
      entries,
      days: totalDays,
      reason: reasonEl.value.trim(),
      verbalReportConfirmed: document.getElementById('verbalReportConfirmed').checked
    };

    if (!payload.name || !payload.email || !payload.startDate || !payload.endDate) {
      showError('필수 항목을 모두 입력하세요.');
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

    // 반반차 시간 검증
    const missingTime = entries.find(e => e.type === '반반차' && !e.timeRange);
    if (missingTime) {
      showError(`반반차(${missingTime.date})는 시간을 입력해 주세요. (예: 13:00~15:00)`);
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
