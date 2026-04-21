// admin.js — 관리자 대시보드 메인 로직

(function() {
  // 세션 체크
  if (!EYEPOP.requireAdminSession()) return;

  const state = {
    employees: [],
    settings: null,
    activeTab: 'employees',
    filter: { search: '', dept: '' }
  };

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
    const headers = ['이름', '이메일', '부서/팀', '팀장이메일', '임원여부', '입사일 또는 연차일수'];
    const sample = [
      ['홍길동', 'gildong@hanmail.net', '설계사업본부/1팀', 'leader1@eyepopeng.com', 'N', '2024-03-15'],
      ['김영희', 'younghee@eyepopeng.com', '경영지원팀', 'ceo@eyepopeng.com', 'N', '2023-07-01'],
      ['박상무', 'park@eyepopeng.com', '임원', '', 'Y', '15']
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

      const parsed = rows.map(r => {
        const name = String(r['이름'] || '').trim();
        const email = String(r['이메일'] || '').trim();
        if (!name || !email) return null;
        const hireOrDays = String(r['입사일 또는 연차일수'] || '').trim();
        const isDate = /^\d{4}-\d{2}-\d{2}$/.test(hireOrDays);
        return {
          id: EYEPOP.generateId(),
          name,
          email,
          department: String(r['부서/팀'] || '').trim(),
          teamLeaderEmail: String(r['팀장이메일'] || '').trim(),
          isExecutive: String(r['임원여부'] || '').trim().toUpperCase() === 'Y',
          hireDate: isDate ? hireOrDays : null,
          customLeaveDays: (!isDate && hireOrDays) ? Number(hireOrDays) || null : null
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

    const rows = filtered.map(e => `
      <tr>
        <td>${EYEPOP.escapeHtml(e.name)}
          ${e.isExecutive ? '<span class="badge badge-exec">임원</span>' : '<span class="badge badge-staff">직원</span>'}
        </td>
        <td>${EYEPOP.escapeHtml(e.email)}</td>
        <td>${EYEPOP.escapeHtml(e.department)}</td>
        <td>${EYEPOP.escapeHtml(e.teamLeaderEmail)}</td>
        <td>${e.hireDate ? EYEPOP.escapeHtml(e.hireDate) : (e.customLeaveDays != null ? `${e.customLeaveDays}일` : '-')}</td>
        <td>
          <button class="btn-danger btn-sm" onclick="__deleteEmployee('${e.id}')">삭제</button>
        </td>
      </tr>
    `).join('');

    wrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>이름</th>
            <th>이메일</th>
            <th>부서/팀</th>
            <th>팀장 이메일</th>
            <th>입사일/연차</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="6" class="empty-state">검색 결과 없음</td></tr>'}</tbody>
      </table>
      <div style="margin-top:10px; font-size:12px; color: var(--gray-400);">
        총 ${state.employees.length}명 / 표시 ${filtered.length}명
      </div>
    `;
    updateDeptFilter();
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

  // ── 초기 로드 ──
  async function loadAll() {
    try {
      const data = await EYEPOP.gist.readAll();
      const files = data.files || {};
      state.employees = (files['employees.json']?.employees) || [];
      state.settings = files['settings.json'] || {};
      applySettingsToForm(state.settings);
      renderEmployeeTable();
    } catch (err) {
      console.error(err);
      EYEPOP.toast('데이터 로드 실패: ' + err.message, 'error', 5000);
    }
  }

  loadAll();
})();
