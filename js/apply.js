// apply.js — 직원 연차 신청 폼 (일자별 정밀 입력 + 시간 자동계산 + 사전검증)

(function () {
  const form = document.getElementById('applyForm');
  const submitBtn = document.getElementById('submitBtn');
  const errorBox = document.getElementById('errorBox');
  const successBox = document.getElementById('successBox');
  const successTitle = document.getElementById('successTitle');
  const successMsg = document.getElementById('successMsg');

  const nameEl = document.getElementById('name');
  const emailEl = document.getElementById('email');
  const startEl = document.getElementById('startDate');
  const endEl = document.getElementById('endDate');
  const reasonEl = document.getElementById('reason');
  const reasonEtcEl = document.getElementById('reasonEtc');
  const verbalEl = document.getElementById('verbalReportConfirmed');
  const entriesSection = document.getElementById('entriesSection');
  const entriesList = document.getElementById('entriesList');
  const totalRow = document.getElementById('totalRow');
  const totalEl = document.getElementById('totalDays');

  // ─────────── 상수 ───────────
  const LUNCH_START_MIN = 11 * 60 + 45;   // 705
  const LUNCH_END_MIN   = 12 * 60 + 45;   // 765
  const LUNCH_MIN       = 60;
  const WORK_START_MIN  = 9 * 60;         // 540  (09:00)
  const WORK_END_MIN    = 18 * 60;        // 1080 (18:00)

  const TYPE_DAYS = {
    '연차': 1,
    '3/4차': 0.75,
    '반차': 0.5,
    '오전반차': 0.5,   // 호환: 기존 데이터 인식용
    '오후반차': 0.5,   // 호환: 기존 데이터 인식용
    '반반차': 0.25,
    '없음': 0
  };
  // 휴가별 실근무 시간(분)
  const TYPE_WORK_MIN = {
    '3/4차': 360,
    '반차': 240,
    '반반차': 120
  };
  // 시간 입력 필요 타입
  const NEEDS_TIME = new Set(['3/4차', '반차', '반반차']);

  const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

  // ─────────── 시간 유틸 ───────────
  function hhmmToMin(s) {
    if (!s) return null;
    const m = String(s).match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]), mm = Number(m[2]);
    if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
    return h * 60 + mm;
  }
  function minToHHMM(min) {
    const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(min)));
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }
  // 점심 겹침(분) 계산
  function lunchOverlap(startMin, endMin) {
    return Math.max(0, Math.min(endMin, LUNCH_END_MIN) - Math.max(startMin, LUNCH_START_MIN));
  }
  // 종료시각 자동 계산: 시작 + 실근무 + 점심 겹침 보정 (수렴 반복)
  function calcEndMin(startMin, workMin) {
    let end = startMin + workMin;
    for (let i = 0; i < 3; i++) {
      const overlap = lunchOverlap(startMin, end);
      const newEnd = startMin + workMin + overlap;
      if (newEnd === end) break;
      end = newEnd;
    }
    return end;
  }
  // 실근무 시간(분) = 전체 - 점심겹침
  function actualWorkMin(startMin, endMin) {
    return Math.max(0, endMin - startMin - lunchOverlap(startMin, endMin));
  }

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

  // ─────────── 사전검증(dryRun) 상태 ───────────
  const dryRunCache = new Map();   // key: `${name}|${email}` → { status, error?, employee? }
  let dryRunStatus = { state: 'idle', message: '' }; // idle | pending | ok | fail
  let dryRunTimer = null;
  let dryRunSeq = 0;

  function dryRunKey() {
    return `${nameEl.value.trim()}|${emailEl.value.trim().toLowerCase()}`;
  }

  async function runDryRun() {
    const name = nameEl.value.trim();
    const email = emailEl.value.trim();
    if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      dryRunStatus = { state: 'idle', message: '' };
      renderFieldStatus();
      updateSubmitState();
      return;
    }
    const key = dryRunKey();
    if (dryRunCache.has(key)) {
      const cached = dryRunCache.get(key);
      dryRunStatus = cached;
      renderFieldStatus();
      updateSubmitState();
      return;
    }
    const mySeq = ++dryRunSeq;
    dryRunStatus = { state: 'pending', message: '확인 중...' };
    renderFieldStatus();
    updateSubmitState();

    try {
      const resp = await fetch('/api/submit-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true, name, email })
      });
      const data = await resp.json();
      if (mySeq !== dryRunSeq) return; // 최신 요청만 반영
      if (resp.ok) {
        const result = { state: 'ok', message: '', employee: { id: data.employeeId, name: data.name, department: data.department } };
        dryRunCache.set(key, result);
        dryRunStatus = result;
      } else {
        // 메시지 분기
        let userMsg = data.error || '직원 정보 확인 실패';
        if (resp.status === 403 && /등록되지 않은/.test(data.error || '')) {
          userMsg = `회사 등록 이메일과 다릅니다. 입력하신 이메일: ${email}. 관리자(김은주 차장)에게 문의하세요.`;
        } else if (resp.status === 403 && /이름과 이메일이 일치하지/.test(data.error || '')) {
          userMsg = '이메일은 등록되어 있지만 이름이 다릅니다. 회사 등록 이름(공백·받침 포함)으로 정확히 입력하세요.';
        }
        const result = { state: 'fail', message: userMsg, httpStatus: resp.status };
        dryRunCache.set(key, result);
        dryRunStatus = result;
      }
    } catch (err) {
      if (mySeq !== dryRunSeq) return;
      // 네트워크 오류는 캐시하지 않음 (재시도 가능)
      dryRunStatus = { state: 'fail', message: '네트워크 오류: ' + err.message };
    } finally {
      renderFieldStatus();
      updateSubmitState();
    }
  }

  function scheduleDryRun() {
    if (dryRunTimer) clearTimeout(dryRunTimer);
    dryRunTimer = setTimeout(runDryRun, 500);
  }

  // ─────────── 필드 상태 아이콘 ───────────
  function setFieldIcon(el, state) {
    // state: 'ok' | 'fail' | 'idle'
    el.classList.remove('field-ok', 'field-fail');
    if (state === 'ok') el.classList.add('field-ok');
    else if (state === 'fail') el.classList.add('field-fail');
  }
  function renderFieldStatus() {
    const name = nameEl.value.trim();
    const email = emailEl.value.trim();
    const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!name) setFieldIcon(nameEl, 'idle');
    if (!email) setFieldIcon(emailEl, 'idle');

    if (name && email && emailValid) {
      if (dryRunStatus.state === 'ok') {
        setFieldIcon(nameEl, 'ok');
        setFieldIcon(emailEl, 'ok');
      } else if (dryRunStatus.state === 'fail') {
        setFieldIcon(nameEl, 'fail');
        setFieldIcon(emailEl, 'fail');
      } else {
        setFieldIcon(nameEl, 'idle');
        setFieldIcon(emailEl, 'idle');
      }
    } else if (email && !emailValid) {
      setFieldIcon(emailEl, 'fail');
    }

    // dryRun 메시지 표시
    const dryMsgBox = document.getElementById('dryRunMsg');
    if (dryMsgBox) {
      if (dryRunStatus.state === 'ok' && dryRunStatus.employee) {
        dryMsgBox.className = 'dryrun-msg dryrun-ok';
        dryMsgBox.textContent = `✓ ${dryRunStatus.employee.name} (${dryRunStatus.employee.department || '부서 미지정'}) 확인 완료`;
        dryMsgBox.style.display = 'block';
      } else if (dryRunStatus.state === 'fail') {
        dryMsgBox.className = 'dryrun-msg dryrun-fail';
        dryMsgBox.textContent = '❌ ' + dryRunStatus.message;
        dryMsgBox.style.display = 'block';
      } else if (dryRunStatus.state === 'pending') {
        dryMsgBox.className = 'dryrun-msg dryrun-pending';
        dryMsgBox.textContent = '직원 정보 확인 중...';
        dryMsgBox.style.display = 'block';
      } else {
        dryMsgBox.style.display = 'none';
      }
    }
  }

  // ─────────── entries 자동 생성 ───────────
  function rebuildEntries() {
    if (!startEl.value || !endEl.value) {
      entriesSection.style.display = 'none';
      totalRow.style.display = 'none';
      updateSubmitState();
      return;
    }
    const s = parseYmd(startEl.value);
    const e = parseYmd(endEl.value);
    if (isNaN(s) || isNaN(e) || e < s) {
      entriesSection.style.display = 'none';
      totalRow.style.display = 'none';
      updateSubmitState();
      return;
    }
    const diffDays = Math.round((e - s) / 86400000) + 1;
    if (diffDays > 30) {
      showError('기간은 최대 30일까지 가능합니다.');
      entriesSection.style.display = 'none';
      updateSubmitState();
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
    updateSubmitState();
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
          <option value="3/4차">3/4차 (0.75일, 6시간)</option>
          <option value="반차">반차 (0.5일, 4시간)</option>
          <option value="반반차">반반차 (0.25일, 2시간)</option>
          <option value="없음" ${defaultType === '없음' ? 'selected' : ''}>사용 안함 (0일)</option>
        </select>
        <div class="entry-time-wrap" style="display:none;">
          <input type="time" class="entry-time-start" step="300" placeholder="시작">
          <span class="entry-time-sep">~</span>
          <input type="text" class="entry-time-end" readonly tabindex="-1" placeholder="종료(자동)">
        </div>
        <div class="entry-error" style="display:none;"></div>
      </div>`;
    }).join('');

    entriesList.querySelectorAll('.entry-row').forEach(row => {
      const select = row.querySelector('.entry-type');
      const wrap = row.querySelector('.entry-time-wrap');
      const startInput = row.querySelector('.entry-time-start');
      const endInput = row.querySelector('.entry-time-end');

      select.addEventListener('change', () => {
        const needsTime = NEEDS_TIME.has(select.value);
        wrap.style.display = needsTime ? 'flex' : 'none';
        if (!needsTime) {
          startInput.value = '';
          endInput.value = '';
          clearEntryError(row);
        } else if (startInput.value) {
          // 타입 변경 시 시작시각 유지 후 종료 재계산
          recalcEntryEnd(row);
        }
        recalcTotal();
        validateEntries();
        updateSubmitState();
      });
      startInput.addEventListener('input', () => {
        recalcEntryEnd(row);
        validateEntries();
        updateSubmitState();
      });
      startInput.addEventListener('blur', () => {
        recalcEntryEnd(row);
        validateEntries();
        updateSubmitState();
      });
    });

    recalcTotal();
    validateEntries();
  }

  function recalcEntryEnd(row) {
    const type = row.querySelector('.entry-type').value;
    const startInput = row.querySelector('.entry-time-start');
    const endInput = row.querySelector('.entry-time-end');
    const workMin = TYPE_WORK_MIN[type];
    if (!workMin) {
      endInput.value = '';
      return;
    }
    const startMin = hhmmToMin(startInput.value);
    if (startMin == null) {
      endInput.value = '';
      return;
    }
    const endMin = calcEndMin(startMin, workMin);
    endInput.value = minToHHMM(endMin);
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

  function setEntryError(row, msg) {
    const box = row.querySelector('.entry-error');
    box.textContent = msg;
    box.style.display = 'block';
    row.classList.add('entry-row-error');
  }
  function clearEntryError(row) {
    const box = row.querySelector('.entry-error');
    box.textContent = '';
    box.style.display = 'none';
    row.classList.remove('entry-row-error');
  }

  // D-1 시간-휴가 정합성 검증
  function validateEntries() {
    if (!entriesList) return true;
    let allValid = true;
    entriesList.querySelectorAll('.entry-row').forEach(row => {
      const type = row.querySelector('.entry-type').value;
      if (!NEEDS_TIME.has(type)) {
        clearEntryError(row);
        return;
      }
      const startInput = row.querySelector('.entry-time-start');
      const endInput = row.querySelector('.entry-time-end');
      const startMin = hhmmToMin(startInput.value);
      const endMin = hhmmToMin(endInput.value);
      if (startMin == null) {
        setEntryError(row, '시작시각을 입력하세요.');
        allValid = false;
        return;
      }
      if (endMin == null) {
        setEntryError(row, '종료시각이 계산되지 않았습니다.');
        allValid = false;
        return;
      }
      const expectedWorkMin = TYPE_WORK_MIN[type];
      const actualMin = actualWorkMin(startMin, endMin);
      // 정합성: 실근무 시간이 휴가 기준과 일치해야 함
      if (actualMin !== expectedWorkMin) {
        const expH = expectedWorkMin / 60;
        const curH = (actualMin / 60).toFixed(2).replace(/\.00$/, '');
        setEntryError(row, `${type}는 ${expH}시간이어야 합니다 (현재 ${curH}시간).`);
        allValid = false;
        return;
      }
      // 근무시간 범위 초과 (09:00 이전 시작 또는 18:00 이후 종료) → D-1 오류
      if (startMin < WORK_START_MIN) {
        setEntryError(row, '시작시각은 09:00 이후여야 합니다.');
        allValid = false;
        return;
      }
      if (endMin > WORK_END_MIN) {
        setEntryError(row, '종료시각은 18:00 이전이어야 합니다.');
        allValid = false;
        return;
      }
      clearEntryError(row);
    });
    return allValid;
  }

  function getEntries() {
    const rows = entriesList.querySelectorAll('.entry-row');
    return Array.from(rows)
      .map(row => {
        const type = row.querySelector('.entry-type').value;
        if (type === '없음') return null;
        let timeRange = null;
        if (NEEDS_TIME.has(type)) {
          const s = row.querySelector('.entry-time-start').value.trim();
          const e = row.querySelector('.entry-time-end').value.trim();
          if (s && e) timeRange = `${s}~${e}`;
        }
        return {
          date: row.dataset.date,
          type,
          days: TYPE_DAYS[type],
          timeRange: NEEDS_TIME.has(type) ? timeRange : null
        };
      })
      .filter(Boolean);
  }

  // ─────────── 제출 버튼 활성/비활성 + 미충족 항목 수집 ───────────
  function collectUnmetReasons() {
    const reasons = [];
    const name = nameEl.value.trim();
    const email = emailEl.value.trim();
    if (!name) reasons.push('이름 미입력');
    if (!email) reasons.push('이메일 미입력');
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) reasons.push('이메일 형식 오류');
    if (!startEl.value) reasons.push('시작일 미선택');
    if (!endEl.value) reasons.push('종료일 미선택');
    if (!reasonEl.value) reasons.push('사유 미선택');
    else if (reasonEl.value === '기타' && !reasonEtcEl.value.trim()) reasons.push('기타 상세 미입력');

    // entries 검증
    const entries = (entriesList && entriesList.children.length > 0) ? getEntries() : [];
    const totalDays = entries.reduce((s, x) => s + x.days, 0);
    if (entries.length === 0 || totalDays === 0) reasons.push('사용 내역 미선택');

    // 시간 입력 필요한데 빈칸
    if (entriesList) {
      let timeMissing = false;
      let timeInvalid = false;
      entriesList.querySelectorAll('.entry-row').forEach(row => {
        const type = row.querySelector('.entry-type').value;
        if (NEEDS_TIME.has(type)) {
          const s = row.querySelector('.entry-time-start').value.trim();
          const e = row.querySelector('.entry-time-end').value.trim();
          if (!s || !e) timeMissing = true;
          if (row.classList.contains('entry-row-error')) timeInvalid = true;
        }
      });
      if (timeMissing) reasons.push('시간 입력 미완료');
      if (timeInvalid) reasons.push('시간-휴가 정합성 불일치');
    }

    // dryRun
    if (name && email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (dryRunStatus.state === 'pending') reasons.push('직원 정보 확인 중');
      else if (dryRunStatus.state === 'fail') reasons.push('직원 정보 검증 실패');
      else if (dryRunStatus.state !== 'ok') reasons.push('직원 정보 미확인');
    }

    return reasons;
  }

  function updateSubmitState() {
    const reasons = collectUnmetReasons();
    if (reasons.length === 0) {
      submitBtn.classList.remove('btn-disabled');
      submitBtn.removeAttribute('data-tooltip');
    } else {
      submitBtn.classList.add('btn-disabled');
      submitBtn.setAttribute('data-tooltip', '❌ ' + reasons.join(', '));
    }
    // disabled 속성은 사용하지 않음 — disabled 버튼은 click 이벤트가 발생하지 않아
    // 모바일에서 비활성 탭 시 스크롤·토스트 UX가 동작하지 않음. 클래스만으로 시각화.
  }

  // 이벤트 바인딩
  startEl.addEventListener('change', () => {
    if (startEl.value && (!endEl.value || new Date(endEl.value) < new Date(startEl.value))) {
      endEl.value = startEl.value;
    }
    rebuildEntries();
  });
  endEl.addEventListener('change', rebuildEntries);

  reasonEl.addEventListener('change', () => {
    if (reasonEl.value === '기타') {
      reasonEtcEl.style.display = 'block';
      reasonEtcEl.required = true;
    } else {
      reasonEtcEl.style.display = 'none';
      reasonEtcEl.required = false;
      reasonEtcEl.value = '';
    }
    updateSubmitState();
  });
  reasonEtcEl.addEventListener('input', updateSubmitState);

  // 이름·이메일 → dryRun 디바운스
  nameEl.addEventListener('input', () => {
    dryRunStatus = { state: 'idle', message: '' };
    renderFieldStatus();
    updateSubmitState();
    scheduleDryRun();
  });
  nameEl.addEventListener('blur', () => { scheduleDryRun(); });
  emailEl.addEventListener('input', () => {
    dryRunStatus = { state: 'idle', message: '' };
    renderFieldStatus();
    updateSubmitState();
    scheduleDryRun();
  });
  emailEl.addEventListener('blur', () => { scheduleDryRun(); });

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.style.display = 'block';
    errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function clearError() {
    errorBox.textContent = '';
    errorBox.style.display = 'none';
  }

  // 모바일: 비활성 상태에서 버튼 탭 → 첫 오류 필드로 스크롤+포커스
  submitBtn.addEventListener('click', (e) => {
    if (submitBtn.classList.contains('btn-disabled')) {
      e.preventDefault();
      const reasons = collectUnmetReasons();
      if (reasons.length > 0) {
        // 첫 오류 필드 매핑
        let target = null;
        if (reasons.includes('이름 미입력')) target = nameEl;
        else if (reasons.includes('이메일 미입력') || reasons.includes('이메일 형식 오류')) target = emailEl;
        else if (reasons.includes('시작일 미선택')) target = startEl;
        else if (reasons.includes('종료일 미선택')) target = endEl;
        else if (reasons.includes('사용 내역 미선택') || reasons.includes('시간 입력 미완료') || reasons.includes('시간-휴가 정합성 불일치')) target = entriesList;
        else if (reasons.includes('사유 미선택') || reasons.includes('기타 상세 미입력')) target = reasonEl;

        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          if (target.focus) target.focus();
        }
        if (window.EYEPOP && EYEPOP.toast) EYEPOP.toast('❌ ' + reasons[0], 'error');
      }
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();

    const reasons = collectUnmetReasons();
    if (reasons.length > 0) {
      showError('다음 항목을 확인하세요: ' + reasons.join(', '));
      return;
    }

    const entries = getEntries();
    const totalDays = entries.reduce((s, x) => s + x.days, 0);

    const payload = {
      name: nameEl.value.trim(),
      email: emailEl.value.trim(),
      startDate: startEl.value,
      endDate: endEl.value,
      entries,
      days: totalDays,
      reason: reasonEl.value === '기타'
        ? ('기타: ' + (reasonEtcEl.value.trim()))
        : reasonEl.value.trim(),
      verbalReportConfirmed: verbalEl.checked
    };

    submitBtn.classList.add('btn-disabled');
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
        if (resp.status === 403 && /등록되지 않은/.test(data.error || '')) {
          msg = `회사 등록 이메일과 다릅니다. 입력하신 이메일: ${payload.email}. 관리자(김은주 차장)에게 문의하세요.`;
        } else if (resp.status === 403 && /이름과 이메일이 일치하지/.test(data.error || '')) {
          msg = '이메일은 등록되어 있지만 이름이 다릅니다. 회사 등록 이름(공백·받침 포함)으로 정확히 입력하세요.';
        } else if (data.remaining != null) {
          msg = `${msg} (잔여: ${data.remaining}일)`;
        }
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
      if (window.EYEPOP && EYEPOP.toast) EYEPOP.toast('신청 완료', 'success');
    } catch (err) {
      showError('네트워크 오류: ' + err.message);
    } finally {
      submitBtn.textContent = '신청 제출';
      updateSubmitState();
    }
  });

  // 초기 버튼 상태
  updateSubmitState();
})();
