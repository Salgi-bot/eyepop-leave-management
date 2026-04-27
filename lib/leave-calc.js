// 근로기준법 제60조 기준 법정 연차 계산
// 입사일 기준 (개별 근속) — 입사한 날부터 1년 단위
export function calcLegalLeave(hireDate, asOf = new Date()) {
  if (!hireDate) return 0;
  const hire = new Date(hireDate);
  if (isNaN(hire.getTime())) return 0;

  const diffMonths =
    (asOf.getFullYear() - hire.getFullYear()) * 12 +
    (asOf.getMonth() - hire.getMonth()) -
    (asOf.getDate() < hire.getDate() ? 1 : 0);
  const years = Math.floor(diffMonths / 12);

  if (years < 1) return Math.max(0, Math.min(diffMonths, 11));
  let base = 15;
  if (years >= 3) base += Math.floor((years - 1) / 2);
  return Math.min(base, 25);
}

// 회계년도 기준 (1/1 일괄 부여) — 사내 통일 관리에 적합
// 입사 첫 해는 비례 (입사일~연말 사이 발생한 월 수만큼, 최대 11일)
// 입사 다음 해 1/1부터 15일 일괄 부여, 3년차부터 2년마다 +1, 최대 25일
export function calcLegalLeaveFiscal(hireDate, asOf = new Date()) {
  if (!hireDate) return 0;
  const hire = new Date(hireDate);
  if (isNaN(hire.getTime())) return 0;

  const fiscalYear = asOf.getFullYear();
  const hireYear = hire.getFullYear();

  // 입사한 해 (회계년도 첫 해): 입사일~연말 사이 월 수 비례 (최대 11일)
  if (fiscalYear === hireYear) {
    const diffMonths =
      (asOf.getFullYear() - hire.getFullYear()) * 12 +
      (asOf.getMonth() - hire.getMonth()) -
      (asOf.getDate() < hire.getDate() ? 1 : 0);
    return Math.max(0, Math.min(diffMonths, 11));
  }

  // 입사 다음 해 이후: 회계 근속년차 = fiscalYear - hireYear
  const yearsServed = fiscalYear - hireYear;
  let base = 15;
  if (yearsServed >= 3) base += Math.floor((yearsServed - 1) / 2);
  return Math.min(base, 25);
}

export function calcUsedDays(employeeId, requests, year = new Date().getFullYear()) {
  return requests
    .filter(
      r =>
        r.employeeId === employeeId &&
        (r.status === 'approved' || r.status === 'auto_approved') &&
        new Date(r.startDate).getFullYear() === year
    )
    .reduce((sum, r) => sum + (Number(r.days) || 0), 0);
}

export function calcRemaining(employee, requests, settings) {
  const mode = settings?.leaveCalcMode || 'legal_fiscal';
  let total;
  if (mode === 'legal') total = calcLegalLeave(employee.hireDate);
  else if (mode === 'legal_fiscal') total = calcLegalLeaveFiscal(employee.hireDate);
  else total = Number(employee.customLeaveDays) || 0;
  // 입사일 없고 customLeaveDays 있으면 그것 우선 사용 (수동 등록 직원)
  if (!total && employee.customLeaveDays != null) total = Number(employee.customLeaveDays);
  const used = calcUsedDays(employee.id, requests);
  return { total, used, remaining: Math.max(0, total - used) };
}

export function diffDaysInclusive(startDate, endDate) {
  const s = new Date(startDate);
  const e = new Date(endDate);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return 0;
  const ms = e.getTime() - s.getTime();
  return Math.floor(ms / 86400000) + 1;
}
