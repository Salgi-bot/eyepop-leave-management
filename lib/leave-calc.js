// 근로기준법 제60조 기준 법정 연차 계산

export function calcLegalLeave(hireDate, asOf = new Date()) {
  if (!hireDate) return 0;
  const hire = new Date(hireDate);
  if (isNaN(hire.getTime())) return 0;

  const diffMonths =
    (asOf.getFullYear() - hire.getFullYear()) * 12 +
    (asOf.getMonth() - hire.getMonth()) -
    (asOf.getDate() < hire.getDate() ? 1 : 0);
  const years = Math.floor(diffMonths / 12);

  // 1년 미만: 월 1일 발생 (최대 11일)
  if (years < 1) return Math.max(0, Math.min(diffMonths, 11));

  // 1~2년차: 15일
  // 3년 이상: 15 + floor((years-1)/2) (최대 25일)
  let base = 15;
  if (years >= 3) base += Math.floor((years - 1) / 2);
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
  const mode = settings?.leaveCalcMode || 'legal';
  const total =
    mode === 'legal'
      ? calcLegalLeave(employee.hireDate)
      : Number(employee.customLeaveDays) || 0;
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
