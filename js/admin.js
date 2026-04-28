// admin.js — 관리자 대시보드 메인 로직

(function() {
  // 세션 체크
  if (!EYEPOP.requireAdminSession()) return;

  const state = {
    employees: [],
    requests: [],
    settings: null,
    activeTab: 'employees',
    filter: { search: '', dept: '' }
  };

  // ── 연차 계산 (회계년도 기준, lib/leave-calc.js와 동일 로직) ──
  function calcLegalLeaveFiscal(hireDate, asOf = new Date()) {
    if (!hireDate) return 0;
    const hire = new Date(hireDate);
    if (isNaN(hire.getTime())) return 0;
    const fy = asOf.getFullYear();
    const hy = hire.getFullYear();
    if (fy === hy) {
      const dm = (asOf.getFullYear() - hire.getFullYear()) * 12 +
                 (asOf.getMonth() - hire.getMonth()) -
                 (asOf.getDate() < hire.getDate() ? 1 : 0);
      return Math.max(0, Math.min(dm, 11));
    }
    const ys = fy - hy;
    let base = 15;
    if (ys >= 3) base += Math.floor((ys - 1) / 2);
    return Math.min(base, 25);
  }
  function calcUsedDays(empId, requests, year = new Date().getFullYear()) {
    return requests
      .filter(r => r.employeeId === empId &&
        (r.status === 'approved' || r.status === 'auto_approved') &&
        new Date(r.startDate).getFullYear() === year)
      .reduce((s, r) => s + (Number(r.days) || 0), 0);
  }
  function calcPendingDays(empId, requests, year = new Date().getFullYear()) {
    return requests
      .filter(r => r.employeeId === empId && r.status === 'pending' &&
        new Date(r.startDate).getFullYear() === year)
      .reduce((s, r) => s + (Number(r.days) || 0), 0);
  }
  function calcRemaining(emp, requests, settings) {
    let total;
    // customLeaveDays 우선 (회계년도 도중 도입 / 정년 촉진계약자 등)
    if (emp.customLeaveDays != null && emp.customLeaveDays !== '') {
      total = Number(emp.customLeaveDays) || 0;
    } else {
      const mode = settings?.leaveCalcMode || 'legal_fiscal';
      if (mode === 'legal_fiscal' || mode === 'legal') total = calcLegalLeaveFiscal(emp.hireDate);
      else total = 0;
    }
    const preUsed = Number(emp.customUsedDays) || 0; // 시스템 도입 전 이미 사용한 일수
    const sysUsed = calcUsedDays(emp.id, requests);
    const pending = calcPendingDays(emp.id, requests);
    const used = preUsed + sysUsed;
    return { total, used, preUsed, sysUsed, pending, remaining: Math.max(0, total - used - pending) };
  }

  // ── 탭 전환 ──
  document.querySelectorAll('.sidebar-item').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  function switchTab(tab) {
    state.activeTab = tab;
    document.querySelectorAll('.sidebar-item').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach(p =>
      p.classList.toggle('hidden', p.id !== `tab-${tab}`));
  }

  // ── 로그아웃 ──
  document.getElementById('btnLogout').addEventListener('click', () => {
    if (confirm('로그아웃 하시겠습니까?')) EYEPOP.logout();
  });

  // ── 직원 관리 ──
  const fileExcel = document.getElementById('fileExcel');
  document.getElementById('btnUploadExcel').addEventListener('click', () => fileExcel.click());
  document.getElementById('btnDownloadTemplate').addEventListener('click', downloadTemplate);
  document.getElementById('btnAddEmployee').addEventListener('click', addEmployeeManual);
  document.getElementById('btnResetEmployees').addEventListener('click', resetAllEmployees);
  document.getElementById('searchInput').addEventListener('input', (e) => {
    state.filter.search = e.target.value.trim().toLowerCase();
    renderEmployeeTable();
  });
  document.getElementById('deptFilter').addEventListener('change', (e) => {
    state.filter.dept = e.target.value;
    renderEmployeeTable();
  });

  fileExcel.addEventListener('change', handleExcelUpload);

  function downloadTemplate() {
    const headers = ['이름', '이메일', '부서/팀', '팀장이메일', '임원여부', '입사일 또는 연차일수', '이미 사용한 일수(선반영)'];
    const sample = [
      ['홍길동', 'gildong@hanmail.net', '설계사업본부/1팀', 'leader1@eyepopeng.com', 'N', '2024-03-15', ''],
      ['김영희', 'younghee@eyepopeng.com', '경영지원팀', 'ceo@eyepopeng.com', 'N', '2023-07-01', '3'],
      ['박상무', 'park@eyepopeng.com', '임원', '', 'Y', '15', '0']
    ];
    const ws = XLSX.utils.aoa_to_sheet([headers, ...sample]);
    ws['!cols'] = headers.map(h => ({ wch: h.length < 10 ? 15 : 22 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '직원목록');
    XLSX.writeFile(wb, 'eyepop-직원목록-템플릿.xlsx');
    EYEPOP.toast('템플릿 다운로드 완료', 'success');
  }

  async function handleExcelUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

      // 컬럼명 키워드 매칭 (괄호·여러 변형 허용)
      function pickCol(row, keywords) {
        const k = Object.keys(row).find(key => keywords.some(w => key.includes(w)));
        return k ? String(row[k] || '').trim() : '';
      }
      function pickColRaw(row, keywords) {
        const k = Object.keys(row).find(key => keywords.some(w => key.includes(w)));
        return k ? row[k] : '';
      }
      const parsed = rows.map(r => {
        const name = pickCol(r, ['이름']);
        const email = pickCol(r, ['이메일', '메일']);
        if (!name || !email) return null;

        // 입사일 / 재입사일 (재입사일이 있으면 hireDate로 우선 사용 — A안: 재입사 시 근속 새로 시작)
        const hireRaw = pickColRaw(r, ['입사일']);
        const reHireRaw = pickColRaw(r, ['재입사']);
        const hireDate = normalizeDate(reHireRaw) || normalizeDate(hireRaw);

        // 직접 연차일수가 적힌 경우 (구버전 템플릿 호환)
        const directDaysRaw = pickColRaw(r, ['연차일수']);
        const directDays = (typeof directDaysRaw === 'number' && directDaysRaw < 100)
          ? directDaysRaw
          : (typeof directDaysRaw === 'string' && directDaysRaw && !isNaN(Number(directDaysRaw)))
            ? Number(directDaysRaw)
            : null;

        const execStr = pickCol(r, ['임원']).toUpperCase();
        const usedStr = pickCol(r, ['이미사용', '선반영', '기사용']);
        const usedNum = usedStr && !isNaN(Number(usedStr)) ? Number(usedStr) : null;

        return {
          id: EYEPOP.generateId(),
          name,
          email,
          department: pickCol(r, ['부서']),
          teamLeaderEmail: pickCol(r, ['팀장']),
          isExecutive: execStr === 'Y' || execStr === '예' || execStr === '임원',
          hireDate,
          customLeaveDays: directDays,
          customUsedDays: usedNum
        };
      }).filter(Boolean);

      if (!parsed.length) {
        EYEPOP.toast('유효한 직원 데이터가 없습니다', 'error');
        return;
      }

      // 병합 (이메일 기준)
      const existingByEmail = new Map(state.employees.map(e => [e.email, e]));
      parsed.forEach(p => {
        const existing = existingByEmail.get(p.email);
        if (existing) Object.assign(existing, p, { id: existing.id });
        else state.employees.push(p);
      });

      await saveEmployees();
      EYEPOP.toast(`${parsed.length}명 업로드 완료`, 'success');
      fileExcel.value = '';
      renderEmployeeTable();
    } catch (err) {
      console.error(err);
      EYEPOP.toast('엑셀 파싱 실패: ' + err.message, 'error');
    }
  }

  function addEmployeeManual() {
    const name = prompt('이름:');
    if (!name) return;
    const email = prompt('이메일:');
    if (!email) return;
    const department = prompt('부서/팀:') || '';
    const teamLeaderEmail = prompt('팀장 이메일:') || '';
    const isExec = confirm('임원입니까? (확인=예, 취소=아니오)');
    const hireDate = prompt('입사일 (YYYY-MM-DD) — 비워두면 연차일수 입력:');
    let customLeaveDays = null;
    let hireDateFinal = null;
    if (hireDate && /^\d{4}-\d{2}-\d{2}$/.test(hireDate)) {
      hireDateFinal = hireDate;
    } else {
      const days = prompt('연차일수 (숫자):');
      if (days && !isNaN(Number(days))) customLeaveDays = Number(days);
    }
    state.employees.push({
      id: EYEPOP.generateId(),
      name, email, department, teamLeaderEmail,
      isExecutive: isExec,
      hireDate: hireDateFinal,
      customLeaveDays
    });
    saveEmployees().then(() => renderEmployeeTable());
  }

  async function saveEmployees() {
    const payload = {
      employees: state.employees,
      updatedAt: new Date().toISOString()
    };
    try {
      await EYEPOP.gist.write('employees.json', payload);
    } catch (err) {
      console.error(err);
      EYEPOP.toast('저장 실패: ' + err.message, 'error');
      throw err;
    }
  }

  function deleteEmployee(id) {
    if (!confirm('해당 직원을 삭제하시겠습니까?')) return;
    state.employees = state.employees.filter(e => e.id !== id);
    saveEmployees().then(() => {
      renderEmployeeTable();
      EYEPOP.toast('삭제 완료', 'success');
    });
  }
  window.__deleteEmployee = deleteEmployee;

  // ── 수정 모달 ──
  const editModal = document.getElementById('editModal');
  const editForm = document.getElementById('editForm');

  editModal.addEventListener('click', (e) => {
    if (e.target.dataset.close === '1') closeEditModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !editModal.classList.contains('hidden')) closeEditModal();
  });

  function openEditModal(emp) {
    document.getElementById('edit-id').value = emp.id;
    document.getElementById('edit-name').value = emp.name || '';
    document.getElementById('edit-email').value = emp.email || '';
    document.getElementById('edit-department').value = emp.department || '';
    document.getElementById('edit-teamLeaderEmail').value = emp.teamLeaderEmail || '';
    document.getElementById('edit-isExecutive').checked = !!emp.isExecutive;
    document.getElementById('edit-hireDate').value = emp.hireDate || '';
    document.getElementById('edit-customLeaveDays').value = emp.customLeaveDays != null ? emp.customLeaveDays : '';
    document.getElementById('edit-customUsedDays').value = emp.customUsedDays != null ? emp.customUsedDays : '';
    editModal.classList.remove('hidden');
  }

  function closeEditModal() {
    editModal.classList.add('hidden');
  }

  function editEmployee(id) {
    const emp = state.employees.find(e => e.id === id);
    if (!emp) return;
    openEditModal(emp);
  }
  window.__editEmployee = editEmployee;

  editForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('edit-id').value;
    const emp = state.employees.find(x => x.id === id);
    if (!emp) { closeEditModal(); return; }

    const hireDateValue = document.getElementById('edit-hireDate').value || null;
    const customDaysValue = document.getElementById('edit-customLeaveDays').value;
    const customUsedValue = document.getElementById('edit-customUsedDays').value;

    Object.assign(emp, {
      name: document.getElementById('edit-name').value.trim(),
      email: document.getElementById('edit-email').value.trim(),
      department: document.getElementById('edit-department').value.trim(),
      teamLeaderEmail: document.getElementById('edit-teamLeaderEmail').value.trim(),
      isExecutive: document.getElementById('edit-isExecutive').checked,
      hireDate: hireDateValue,
      customLeaveDays: customDaysValue !== '' ? Number(customDaysValue) : null,
      customUsedDays: customUsedValue !== '' ? Number(customUsedValue) : null
    });

    try {
      await saveEmployees();
      renderEmployeeTable();
      closeEditModal();
      EYEPOP.toast('수정 완료', 'success');
    } catch (err) {
      EYEPOP.toast('저장 실패: ' + err.message, 'error');
    }
  });

  function renderEmployeeTable() {
    const wrap = document.getElementById('employeeTableWrap');
    if (!state.employees.length) {
      wrap.innerHTML = '<div class="empty-state">직원 데이터가 없습니다. 엑셀을 업로드해주세요.</div>';
      updateDeptFilter();
      return;
    }
    const f = state.filter;
    const filtered = state.employees.filter(emp => {
      if (f.dept && emp.department !== f.dept) return false;
      if (f.search) {
        const hay = `${emp.name} ${emp.email} ${emp.department}`.toLowerCase();
        if (!hay.includes(f.search)) return false;
      }
      return true;
    });

    const rows = filtered.map(e => {
      const leave = calcRemaining(e, state.requests, state.settings);
      return `
      <tr>
        <td>${EYEPOP.escapeHtml(e.name)}
          ${e.isExecutive ? '<span class="badge badge-exec">임원</span>' : '<span class="badge badge-staff">직원</span>'}
        </td>
        <td>${EYEPOP.escapeHtml(e.email)}</td>
        <td>${EYEPOP.escapeHtml(e.department)}</td>
        <td>${EYEPOP.escapeHtml(e.teamLeaderEmail)}</td>
        <td>${e.hireDate ? EYEPOP.escapeHtml(e.hireDate) : (e.customLeaveDays != null ? `${e.customLeaveDays}일` : '-')}</td>
        <td style="text-align:center; font-weight:600;">${leave.total}일</td>
        <td style="text-align:center; color:#c97a1a;">${leave.used}일</td>
        <td style="text-align:center; color:#2e7d4f; font-weight:600;">${leave.remaining}일</td>
        <td>
          <button class="btn-secondary btn-sm" onclick="__editEmployee('${e.id}')">수정</button>
          <button class="btn-danger btn-sm" onclick="__deleteEmployee('${e.id}')">삭제</button>
        </td>
      </tr>
    `;}).join('');

    wrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>이름</th>
            <th>이메일</th>
            <th>부서/팀</th>
            <th>팀장 이메일</th>
            <th>입사일/연차</th>
            <th>총연차</th>
            <th>사용</th>
            <th>잔여</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="9" class="empty-state">검색 결과 없음</td></tr>'}</tbody>
      </table>
      <div style="margin-top:10px; font-size:12px; color: var(--gray-400);">
        총 ${state.employees.length}명 / 표시 ${filtered.length}명 · 회계년도 ${new Date().getFullYear()} 기준
      </div>
    `;
    updateDeptFilter();
  }

  async function resetAllEmployees() {
    if (state.employees.length === 0) {
      EYEPOP.toast('초기화할 직원 데이터가 없습니다', 'warning');
      return;
    }
    const count = state.employees.length;
    if (!confirm(`⚠️ 등록된 직원 ${count}명을 모두 삭제합니다.\n이 작업은 되돌릴 수 없습니다.\n\n계속하시겠습니까?`)) return;
    if (!confirm(`정말 ${count}명 전원 삭제하시겠습니까?\n신청 내역은 유지됩니다.`)) return;
    state.employees = [];
    try {
      await saveEmployees();
      renderEmployeeTable();
      EYEPOP.toast(`${count}명 전원 삭제 완료`, 'success');
    } catch (err) {
      EYEPOP.toast('초기화 실패: ' + err.message, 'error');
    }
  }

  function updateDeptFilter() {
    const select = document.getElementById('deptFilter');
    const current = select.value;
    const depts = [...new Set(state.employees.map(e => e.department).filter(Boolean))].sort();
    select.innerHTML = '<option value="">전체 부서</option>' +
      depts.map(d => `<option value="${EYEPOP.escapeHtml(d)}" ${d === current ? 'selected' : ''}>${EYEPOP.escapeHtml(d)}</option>`).join('');
  }

  // ── 설정 ──
  document.querySelectorAll('.toggle-group').forEach(group => {
    group.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  });

  document.getElementById('btnSaveSettings').addEventListener('click', saveSettings);

  function readSettingsFromForm() {
    const getActiveToggle = (id) => {
      const active = document.querySelector(`#${id} button.active`);
      return active ? active.dataset.value : null;
    };
    return {
      objectionPeriodDays: parseInt(document.getElementById('objectionPeriod').value, 10) || 3,
      approvalMode: getActiveToggle('approvalToggle') || 'auto',
      leaveCalcMode: getActiveToggle('leaveCalcToggle') || 'legal',
      emailSender: document.getElementById('emailSender').value.trim(),
      adminEmail: document.getElementById('adminEmail').value.trim(),
      vicePresidentEmail: document.getElementById('vicePresidentEmail').value.trim(),
      updatedAt: new Date().toISOString()
    };
  }

  function applySettingsToForm(s) {
    document.getElementById('objectionPeriod').value = s.objectionPeriodDays ?? 3;
    document.getElementById('emailSender').value = s.emailSender || '';
    document.getElementById('adminEmail').value = s.adminEmail || '';
    document.getElementById('vicePresidentEmail').value = s.vicePresidentEmail || '';
    setToggle('approvalToggle', s.approvalMode || 'auto');
    setToggle('leaveCalcToggle', s.leaveCalcMode || 'legal');
  }

  function setToggle(id, value) {
    const group = document.getElementById(id);
    if (!group) return;
    group.querySelectorAll('button').forEach(b =>
      b.classList.toggle('active', b.dataset.value === value));
  }

  async function saveSettings() {
    const s = readSettingsFromForm();
    try {
      await EYEPOP.gist.write('settings.json', s);
      state.settings = s;
      EYEPOP.toast('설정 저장 완료', 'success');
    } catch (err) {
      console.error(err);
      EYEPOP.toast('저장 실패: ' + err.message, 'error');
    }
  }

  // ── 신청내역 ──
  state.reqFilter = { status: '', search: '' };

  document.getElementById('reqStatusFilter').addEventListener('change', e => {
    state.reqFilter.status = e.target.value;
    renderRequestTable();
  });
  document.getElementById('reqSearch').addEventListener('input', e => {
    state.reqFilter.search = e.target.value.trim().toLowerCase();
    renderRequestTable();
  });
  document.getElementById('btnReloadRequests').addEventListener('click', async () => {
    await loadAll();
    EYEPOP.toast('새로고침 완료', 'success');
  });

  const STATUS_LABEL = {
    pending: '<span class="badge" style="background:#fff7e6; color:#c97a1a;">대기</span>',
    approved: '<span class="badge" style="background:#e6f4eb; color:#2e7d4f;">승인</span>',
    auto_approved: '<span class="badge" style="background:#e6f4eb; color:#2e7d4f;">자동승인</span>',
    rejected: '<span class="badge" style="background:#fde8e8; color:#b93a3a;">반려</span>'
  };

  function renderRequestTable() {
    const wrap = document.getElementById('requestTableWrap');
    if (!state.requests.length) {
      wrap.innerHTML = '<div class="empty-state">신청 내역이 없습니다.</div>';
      return;
    }
    const f = state.reqFilter;
    const filtered = state.requests
      .slice()
      .sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || ''))
      .filter(r => {
        if (f.status && r.status !== f.status) return false;
        if (f.search) {
          const hay = `${r.employeeName} ${r.startDate} ${r.endDate} ${r.department || ''}`.toLowerCase();
          if (!hay.includes(f.search)) return false;
        }
        return true;
      });

    const rows = filtered.map(r => {
      const periodLabel = r.startDate === r.endDate ? r.startDate : `${r.startDate} ~ ${r.endDate}`;
      const confirmLabel = r.confirmedAt
        ? `<span title="${EYEPOP.escapeHtml(r.confirmedAt)}" style="color:#2e7d4f;">✓ 수신확인</span>`
        : '<span style="color:#9aa5b4;">미확인</span>';
      const actionBtns = (r.status === 'pending')
        ? `<button class="btn-primary btn-sm" onclick="__approveRequest('${r.id}')">승인</button>
           <button class="btn-danger btn-sm" onclick="__rejectRequest('${r.id}')">반려</button>`
        : (r.status === 'rejected'
            ? `<span style="font-size:11px; color:#b93a3a;" title="${EYEPOP.escapeHtml(r.rejectReason || '')}">사유 보기</span>`
            : '');
      return `
        <tr data-id="${r.id}">
          <td>${EYEPOP.escapeHtml(r.employeeName)}<br><small style="color:#9aa5b4;">${EYEPOP.escapeHtml(r.department || '')}</small></td>
          <td>${EYEPOP.escapeHtml(periodLabel)}</td>
          <td style="text-align:center; font-weight:600;">${r.days}일</td>
          <td>${EYEPOP.escapeHtml(r.leaveType || '-')}</td>
          <td>${STATUS_LABEL[r.status] || r.status}</td>
          <td>${confirmLabel}</td>
          <td>${actionBtns}</td>
        </tr>`;
    }).join('');

    wrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>신청자</th>
            <th>기간</th>
            <th>일수</th>
            <th>종류</th>
            <th>상태</th>
            <th>수신확인</th>
            <th>액션</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="7" class="empty-state">검색 결과 없음</td></tr>'}</tbody>
      </table>
      <div style="margin-top:10px; font-size:12px; color: var(--gray-400);">
        총 ${state.requests.length}건 / 표시 ${filtered.length}건
      </div>
    `;
  }

  async function approveRequest(id) {
    const r = state.requests.find(x => x.id === id);
    if (!r) return;
    if (!confirm(`${r.employeeName}님 ${r.startDate}~${r.endDate} (${r.days}일) 연차를 승인하시겠습니까?\n\n신청자에게 승인 알림 메일이 발송됩니다.`)) return;
    try {
      const adminKey = localStorage.getItem('eyepop-admin-key');
      const resp = await fetch('/api/approve-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
        body: JSON.stringify({ requestId: id })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      EYEPOP.toast('승인 완료', 'success');
      await loadAll();
    } catch (err) {
      EYEPOP.toast('승인 실패: ' + err.message, 'error', 5000);
    }
  }
  window.__approveRequest = approveRequest;

  async function rejectRequest(id) {
    const r = state.requests.find(x => x.id === id);
    if (!r) return;
    const reason = prompt(`${r.employeeName}님 ${r.startDate}~${r.endDate} 신청을 반려합니다.\n\n반려 사유를 입력하세요:`, '');
    if (!reason || !reason.trim()) {
      EYEPOP.toast('반려 사유 필수', 'warning');
      return;
    }
    try {
      const adminKey = localStorage.getItem('eyepop-admin-key');
      const resp = await fetch('/api/reject-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
        body: JSON.stringify({ requestId: id, reason: reason.trim() })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      EYEPOP.toast('반려 완료', 'success');
      await loadAll();
    } catch (err) {
      EYEPOP.toast('반려 실패: ' + err.message, 'error', 5000);
    }
  }
  window.__rejectRequest = rejectRequest;

  // ── 사용 촉진 (블록 E) ──
  state.promoSelected = new Set();

  document.getElementById('btnReloadPromo').addEventListener('click', () => loadAll());
  document.getElementById('btnSendPromoSelected').addEventListener('click', () => sendPromotion('selected'));
  document.getElementById('btnSendPromoAll').addEventListener('click', () => sendPromotion('all'));
  document.getElementById('promoPhase').addEventListener('change', (e) => {
    document.getElementById('promoSecondAssignWrap').classList.toggle('hidden', e.target.value !== 'second');
  });

  function getPromoTargets() {
    return state.employees
      .map(e => ({ emp: e, leave: calcRemaining(e, state.requests, state.settings) }))
      .filter(x => x.leave.remaining >= 5)
      .sort((a, b) => b.leave.remaining - a.leave.remaining);
  }

  function renderPromotion() {
    const wrap = document.getElementById('promoTargetTableWrap');
    const targets = getPromoTargets();
    if (targets.length === 0) {
      wrap.innerHTML = '<div class="empty-state">촉진 대상자 없음 (잔여 5일 이상 직원 없음)</div>';
    } else {
      const rows = targets.map(({ emp, leave }) => `
        <tr>
          <td><input type="checkbox" class="promo-check" value="${emp.id}"
              ${state.promoSelected.has(emp.id) ? 'checked' : ''}></td>
          <td>${EYEPOP.escapeHtml(emp.name)}</td>
          <td>${EYEPOP.escapeHtml(emp.department || '-')}</td>
          <td>${EYEPOP.escapeHtml(emp.email)}</td>
          <td style="text-align:right;">${leave.total}일</td>
          <td style="text-align:right;">${leave.used}일</td>
          <td style="text-align:right; color:#c97a1a; font-weight:600;">${leave.remaining}일</td>
        </tr>
      `).join('');
      wrap.innerHTML = `
        <table>
          <thead><tr>
            <th><input type="checkbox" id="promoCheckAll"></th>
            <th>이름</th><th>부서</th><th>이메일</th>
            <th style="text-align:right;">총연차</th>
            <th style="text-align:right;">사용</th>
            <th style="text-align:right;">잔여</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `;
      document.getElementById('promoCheckAll').addEventListener('change', (e) => {
        document.querySelectorAll('.promo-check').forEach(c => {
          c.checked = e.target.checked;
          if (e.target.checked) state.promoSelected.add(c.value);
          else state.promoSelected.delete(c.value);
        });
      });
      document.querySelectorAll('.promo-check').forEach(c => {
        c.addEventListener('change', (e) => {
          if (e.target.checked) state.promoSelected.add(e.target.value);
          else state.promoSelected.delete(e.target.value);
        });
      });
    }

    // 발송 이력
    const logWrap = document.getElementById('promoLogWrap');
    const promoLog = state.settings?.promotionLog || {};
    const year = new Date().getFullYear();
    const entries = [];
    for (const phase of ['first', 'second']) {
      const arr = promoLog[`${year}-${phase}`] || [];
      for (const x of arr) entries.push({ ...x, phase });
    }
    entries.sort((a, b) => (b.sentAt || '').localeCompare(a.sentAt || ''));
    if (entries.length === 0) {
      logWrap.innerHTML = '<div class="empty-state">발송 이력 없음</div>';
    } else {
      const logRows = entries.slice(0, 50).map(x => `
        <tr>
          <td>${(x.sentAt || '').slice(0, 19).replace('T', ' ')}</td>
          <td><span class="badge ${x.phase === 'first' ? 'badge-staff' : 'badge-exec'}">${x.phase === 'first' ? '1차' : '2차'}</span></td>
          <td>${EYEPOP.escapeHtml(x.employeeName || '-')}</td>
          <td>${EYEPOP.escapeHtml(x.email || '-')}</td>
          <td style="text-align:right;">${x.remaining || 0}일</td>
          <td>${EYEPOP.escapeHtml(x.assignedPeriod || '-')}</td>
        </tr>
      `).join('');
      logWrap.innerHTML = `
        <table>
          <thead><tr>
            <th>발송일시</th><th>단계</th><th>이름</th><th>이메일</th>
            <th style="text-align:right;">잔여</th><th>지정 시기</th>
          </tr></thead>
          <tbody>${logRows}</tbody>
        </table>
        ${entries.length > 50 ? `<p style="font-size:12px; color:#999; margin-top:6px;">최근 50건만 표시 (전체 ${entries.length}건)</p>` : ''}
      `;
    }
  }

  async function sendPromotion(scope) {
    const phase = document.getElementById('promoPhase').value;
    const targets = getPromoTargets();
    let ids;
    if (scope === 'all') {
      ids = targets.map(x => x.emp.id);
    } else {
      ids = [...state.promoSelected];
    }
    if (ids.length === 0) {
      EYEPOP.toast(scope === 'all' ? '대상자 없음' : '직원을 선택하세요', 'warning');
      return;
    }
    let assignedPeriod = null;
    if (phase === 'second') {
      assignedPeriod = document.getElementById('promoAssignedPeriod').value.trim();
      if (!assignedPeriod) {
        EYEPOP.toast('2차 통지는 회사 지정 사용 시기를 입력하세요', 'warning');
        return;
      }
    }
    const phaseLabel = phase === 'first' ? '1차 통지' : '2차 통지';
    if (!confirm(`${ids.length}명에게 ${phaseLabel} 메일을 발송합니다.\n\n근로기준법 제61조에 따른 법정 통지이며 3년간 보존됩니다.\n계속하시겠습니까?`)) return;
    try {
      const adminKey = localStorage.getItem('eyepop-admin-key');
      const resp = await fetch('/api/send-promotion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
        body: JSON.stringify({ phase, employeeIds: ids, assignedPeriod })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      EYEPOP.toast(`발송 완료 ${data.sentCount}건${data.errorCount ? ` (실패 ${data.errorCount}건)` : ''}`, 'success');
      state.promoSelected.clear();
      await loadAll();
    } catch (err) {
      EYEPOP.toast('발송 실패: ' + err.message, 'error', 5000);
    }
  }

  // ── 출퇴근 대조 (블록 D) ──
  // byMonth: { 'YYYY-MM': { uploadedAt, rowCount, rows: [...] } } — Gist에 누적 저장
  state.attendance = { byMonth: {}, rows: [], compared: [], filter: 'all' };

  const fileAttendance = document.getElementById('fileAttendance');
  document.getElementById('btnUploadAttendance').addEventListener('click', () => fileAttendance.click());
  fileAttendance.addEventListener('change', handleAttendanceUpload);
  document.getElementById('btnClearAttendance').addEventListener('click', clearAttendance);
  document.getElementById('btnDownloadAttendance').addEventListener('click', downloadAttendanceResult);
  document.getElementById('attFilter').addEventListener('change', (e) => {
    state.attendance.filter = e.target.value;
    renderAttendance();
  });

  async function handleAttendanceUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const arr = XLSX.utils.sheet_to_json(ws, { defval: '', header: 1 });
      if (arr.length < 2) {
        EYEPOP.toast('데이터 행이 없습니다', 'error');
        return;
      }
      const header = arr[0].map(h => String(h).replace(/^'|'$/g, '').trim());
      const idx = {
        date: header.findIndex(h => h.includes('근무일자')),
        name: header.findIndex(h => h.includes('이름')),
        org2: header.findIndex(h => h.includes('조직2')),
        startTime: header.findIndex(h => h.includes('출근시간')),
        endTime: header.findIndex(h => h.includes('퇴근시간')),
        startJudge: header.findIndex(h => h.includes('출근판정')),
        endJudge: header.findIndex(h => h.includes('퇴근판정')),
        actualWork: header.findIndex(h => h.includes('실제근무시간')),
        outside: header.findIndex(h => h.includes('외출여부'))
      };
      if (idx.date < 0 || idx.name < 0) {
        EYEPOP.toast('SECOM 엑셀 형식이 아닙니다 (근무일자/이름 컬럼 누락)', 'error');
        return;
      }
      const rows = [];
      for (let i = 1; i < arr.length; i++) {
        const r = arr[i];
        if (!r || r.length === 0) continue;
        const cleanCell = (v) => String(v ?? '').replace(/^'|'$/g, '').trim();
        const dateRaw = cleanCell(r[idx.date]);
        const name = cleanCell(r[idx.name]);
        if (!dateRaw || !name) continue;
        rows.push({
          date: normalizeDate(dateRaw),
          name,
          org: idx.org2 >= 0 ? cleanCell(r[idx.org2]) : '',
          startTime: idx.startTime >= 0 ? cleanCell(r[idx.startTime]) : '',
          endTime: idx.endTime >= 0 ? cleanCell(r[idx.endTime]) : '',
          startJudge: idx.startJudge >= 0 ? cleanCell(r[idx.startJudge]) : '',
          endJudge: idx.endJudge >= 0 ? cleanCell(r[idx.endJudge]) : '',
          actualWork: idx.actualWork >= 0 ? cleanCell(r[idx.actualWork]) : '',
          outside: idx.outside >= 0 ? cleanCell(r[idx.outside]) : ''
        });
      }
      // 월별 그룹핑 → byMonth 갱신 (같은 월은 덮어쓰기, A안)
      const newByMonth = {};
      for (const row of rows) {
        const m = (row.date || '').slice(0, 7);
        if (!m) continue;
        (newByMonth[m] ||= []).push(row);
      }
      const monthsAffected = Object.keys(newByMonth).sort();
      const now = new Date().toISOString();
      for (const m of monthsAffected) {
        state.attendance.byMonth[m] = {
          uploadedAt: now,
          rowCount: newByMonth[m].length,
          rows: newByMonth[m]
        };
      }

      // 13개월 초과 자동 정리 (오늘 기준 직전 12개월 + 현재월 보존)
      const removedMonths = pruneOldMonths(state.attendance.byMonth);
      if (removedMonths.length > 0) {
        EYEPOP.toast(`오래된 ${removedMonths.length}개월 자동 정리 (${removedMonths.join(', ')})`, 'success', 4000);
      }

      // Gist 누적 저장
      try {
        await EYEPOP.gist.write('attendance.json', {
          months: state.attendance.byMonth,
          updatedAt: now
        });
        EYEPOP.toast(`${rows.length}행 저장 완료 (${monthsAffected.join(', ')})`, 'success');
      } catch (saveErr) {
        EYEPOP.toast('서버 저장 실패: ' + saveErr.message, 'error', 5000);
      }

      // 모든 월 합쳐서 화면 갱신
      state.attendance.rows = Object.values(state.attendance.byMonth).flatMap(v => v.rows || []);
      compareAttendance();
      renderAttendance();
      fileAttendance.value = '';
    } catch (err) {
      console.error(err);
      EYEPOP.toast('엑셀 파싱 실패: ' + err.message, 'error');
    }
  }

  // 다양한 입력(엑셀 시리얼·Date 객체·문자열) → "YYYY-MM-DD"
  function normalizeDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return null;
      const y = v.getFullYear();
      const m = String(v.getMonth() + 1).padStart(2, '0');
      const d = String(v.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    if (typeof v === 'number') {
      if (v < 1 || v > 100000) return null;
      const dc = (typeof XLSX !== 'undefined' && XLSX.SSF) ? XLSX.SSF.parse_date_code(v) : null;
      if (!dc) return null;
      return `${dc.y}-${String(dc.m).padStart(2,'0')}-${String(dc.d).padStart(2,'0')}`;
    }
    const s = String(v).trim();
    const m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
    return null;
  }

  function compareAttendance() {
    const rows = state.attendance.rows;
    if (rows.length === 0) {
      state.attendance.compared = [];
      return;
    }
    // SECOM 데이터에서 날짜 범위 추출
    const dates = [...new Set(rows.map(r => r.date))].sort();
    const employees = state.employees;
    const requests = state.requests;

    // SECOM (날짜+이름) 인덱스
    const secomIdx = new Map();
    rows.forEach(r => secomIdx.set(`${r.date}|${r.name}`, r));

    // 신청 (날짜+이름) 인덱스 — entries 기반
    const reqIdx = new Map();
    requests.forEach(req => {
      if (req.status === 'rejected') return;
      const empName = req.employeeName;
      const entries = req.entries || [];
      if (entries.length > 0) {
        entries.forEach(e => {
          if (e.type === '없음') return;
          const k = `${e.date}|${empName}`;
          if (!reqIdx.has(k)) reqIdx.set(k, []);
          reqIdx.get(k).push({ ...e, status: req.status, reqId: req.id });
        });
      } else {
        // 구버전 (entries 없으면 날짜 범위 펼치기)
        const start = new Date(req.startDate);
        const end = new Date(req.endDate);
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          const dt = d.toISOString().slice(0, 10);
          const k = `${dt}|${empName}`;
          if (!reqIdx.has(k)) reqIdx.set(k, []);
          reqIdx.get(k).push({ date: dt, type: req.leaveType || '연차', days: 1, status: req.status, reqId: req.id });
        }
      }
    });

    const compared = [];
    for (const dt of dates) {
      // 평일만 (주말 제외) — Date 객체로 요일 판정
      const dayObj = new Date(dt + 'T00:00:00');
      const wd = dayObj.getDay();
      if (wd === 0 || wd === 6) continue;

      for (const emp of employees) {
        if (emp.name === '김홍정') continue; // 김홍정 부사장은 SECOM 미적용 (그 외 임원은 포함)
        const secom = secomIdx.get(`${dt}|${emp.name}`);
        const reqEntries = reqIdx.get(`${dt}|${emp.name}`) || [];
        const reqType = reqEntries.length > 0 ? reqEntries.map(x => x.type).join('+') : null;
        const reqStatus = reqEntries.length > 0 ? reqEntries[0].status : null;
        const totalReqDays = reqEntries.reduce((s, x) => s + (Number(x.days) || 0), 0);

        let verdict, level;
        if (secom && reqEntries.length === 0) {
          verdict = '정상 (출근)'; level = 'ok';
        } else if (!secom && reqEntries.length === 0) {
          verdict = '⚠ 미신청 결근'; level = 'anomaly';
        } else if (!secom && reqEntries.length > 0) {
          if (reqStatus === 'pending') { verdict = '🟡 신청 대기 (결근)'; level = 'warn'; }
          else { verdict = '정상 (연차)'; level = 'ok'; }
        } else if (secom && reqEntries.length > 0) {
          // 출근 + 연차 신청 동시 → 반차/반반차/3/4차는 정상, 종일 연차면 이상
          if (totalReqDays >= 1) { verdict = '⚠ 신청 후 출근'; level = 'anomaly'; }
          else {
            // 반차류 — 실제 근무시간으로 추정 검증
            const wh = parseHHMM(secom.actualWork);
            const expectedAbsent = totalReqDays * 8; // 8시간 = 1일
            const expectedWork = 8 - expectedAbsent;
            // 실제 근무가 예상 + 1.5시간 초과 시 의심
            if (wh > expectedWork + 1.5) { verdict = `⚠ 반차 시간 의심 (${secom.actualWork} 근무, ${reqType})`; level = 'anomaly'; }
            else { verdict = `정상 (${reqType})`; level = 'ok'; }
          }
        }

        compared.push({
          date: dt, name: emp.name, dept: emp.department || '',
          startTime: secom?.startTime || '', endTime: secom?.endTime || '',
          startJudge: secom?.startJudge || '', actualWork: secom?.actualWork || '',
          reqType: reqType || '', reqStatus: reqStatus || '', reqDays: totalReqDays,
          verdict, level
        });
      }
    }
    state.attendance.compared = compared;
  }

  // 13개월 초과 월 키 삭제 (오늘 기준 직전 12개월 + 현재월 보존)
  function pruneOldMonths(byMonth) {
    const now = new Date();
    const cutoff = new Date(now.getFullYear(), now.getMonth() - 12, 1);
    const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}`;
    const removed = [];
    for (const m of Object.keys(byMonth)) {
      if (m < cutoffKey) {
        delete byMonth[m];
        removed.push(m);
      }
    }
    return removed.sort();
  }

  function parseHHMM(s) {
    if (!s) return 0;
    const m = String(s).match(/(\d+):(\d+)/);
    if (!m) return 0;
    return Number(m[1]) + Number(m[2]) / 60;
  }

  function renderAttendance() {
    const wrap = document.getElementById('attTableWrap');
    const summary = document.getElementById('attSummary');
    const compared = state.attendance.compared;
    if (compared.length === 0) {
      wrap.innerHTML = '<div class="empty-state">SECOM 엑셀을 업로드해주세요.</div>';
      summary.innerHTML = '';
      return;
    }
    const counts = compared.reduce((acc, c) => {
      acc[c.level] = (acc[c.level] || 0) + 1;
      return acc;
    }, {});
    summary.innerHTML = `
      <div style="display:flex; gap:16px; flex-wrap:wrap; font-size:13px;">
        <span>전체: <b>${compared.length}건</b></span>
        <span style="color:#2e7d4f;">정상: ${counts.ok || 0}건</span>
        <span style="color:#c97a1a;">대기: ${counts.warn || 0}건</span>
        <span style="color:#b93a3a; font-weight:600;">이상: ${counts.anomaly || 0}건</span>
      </div>`;

    let filtered = compared;
    if (state.attendance.filter === 'anomaly') filtered = compared.filter(c => c.level === 'anomaly');
    else if (state.attendance.filter === 'normal') filtered = compared.filter(c => c.level === 'ok');

    const rows = filtered.map(c => {
      const bg = c.level === 'anomaly' ? 'background:#fef2f2;'
        : c.level === 'warn' ? 'background:#fef9ec;'
        : '';
      return `
      <tr style="${bg}">
        <td>${EYEPOP.escapeHtml(c.date)}</td>
        <td>${EYEPOP.escapeHtml(c.name)}</td>
        <td>${EYEPOP.escapeHtml(c.dept)}</td>
        <td>${EYEPOP.escapeHtml(c.startTime.slice(11) || '-')}</td>
        <td>${EYEPOP.escapeHtml(c.endTime.slice(11) || '-')}</td>
        <td>${EYEPOP.escapeHtml(c.actualWork || '-')}</td>
        <td>${EYEPOP.escapeHtml(c.reqType || '-')}</td>
        <td style="font-weight:${c.level === 'anomaly' ? '700' : '400'}; color:${c.level === 'anomaly' ? '#b93a3a' : c.level === 'warn' ? '#c97a1a' : '#2e7d4f'};">${EYEPOP.escapeHtml(c.verdict)}</td>
      </tr>`;
    }).join('');

    wrap.innerHTML = `
      <table>
        <thead><tr>
          <th>날짜</th><th>이름</th><th>부서</th>
          <th>출근</th><th>퇴근</th><th>실근무</th>
          <th>연차 신청</th><th>판정</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${filtered.length === 0 ? '<div class="empty-state">필터 조건에 해당하는 행 없음</div>' : ''}`;
  }

  function clearAttendance() {
    if (state.attendance.rows.length === 0) return;
    if (!confirm('현재 화면만 비웁니다 (서버 누적 데이터는 유지).\n새로고침하면 서버 데이터로 다시 표시됩니다.\n계속하시겠습니까?')) return;
    state.attendance.rows = [];
    state.attendance.compared = [];
    state.attendance.filter = 'all';
    document.getElementById('attFilter').value = 'all';
    renderAttendance();
    EYEPOP.toast('화면 초기화 완료 (서버 데이터 유지)', 'success');
  }

  function downloadAttendanceResult() {
    const compared = state.attendance.compared;
    if (compared.length === 0) {
      EYEPOP.toast('대조 결과가 없습니다', 'warning');
      return;
    }
    const headers = ['날짜', '이름', '부서', '출근시간', '퇴근시간', '실근무', '연차신청', '신청상태', '판정'];
    const aoa = [headers, ...compared.map(c => [
      c.date, c.name, c.dept, c.startTime, c.endTime, c.actualWork,
      c.reqType, c.reqStatus, c.verdict
    ])];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = headers.map(h => ({ wch: h.length < 8 ? 12 : 18 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '출퇴근대조');
    const ymd = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `eyepop-출퇴근대조-${ymd}.xlsx`);
  }

  // ── 초기 로드 ──
  async function loadAll() {
    try {
      const data = await EYEPOP.gist.readAll();
      const files = data.files || {};
      state.employees = (files['employees.json']?.employees) || [];
      state.requests = (files['requests.json']?.requests) || [];
      state.settings = files['settings.json'] || {};

      // SECOM 출퇴근 누적 데이터 복원 (월별)
      const att = files['attendance.json'];
      if (att && att.months) {
        state.attendance.byMonth = att.months;
        state.attendance.rows = Object.values(att.months).flatMap(v => v.rows || []);
      }

      applySettingsToForm(state.settings);
      renderEmployeeTable();
      renderRequestTable();
      renderPromotion();
      if (state.attendance.rows.length > 0) {
        compareAttendance();
        renderAttendance();
      }
    } catch (err) {
      console.error(err);
      EYEPOP.toast('데이터 로드 실패: ' + err.message, 'error', 5000);
    }
  }

  loadAll();
})();
