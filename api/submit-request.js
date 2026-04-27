// Vercel Edge Function — 연차 신청 접수
export const config = { runtime: 'edge' };

import { sendEmail, escapeHtml } from '../lib/email.js';
import { calcRemaining } from '../lib/leave-calc.js';

const GIST_API = 'https://api.github.com/gists';

export default async function handler(req) {
  if (req.method === 'OPTIONS') return cors();
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const token = process.env.GIST_TOKEN;
  const gistId = process.env.GIST_ID;
  if (!token || !gistId) {
    return json({ error: 'Server not configured (GIST_TOKEN/GIST_ID)' }, 500);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { name, email, startDate, endDate, days, entries, leaveType, reason, verbalReportConfirmed } = body;
  if (!reason || reason.trim().length < 2) {
    return json({ error: '사유는 필수 입력입니다. (2자 이상)' }, 400);
  }

  if (!name || !email || !startDate || !endDate) {
    return json({ error: 'name, email, startDate, endDate are required' }, 400);
  }
  if (new Date(endDate) < new Date(startDate)) {
    return json({ error: 'endDate must be >= startDate' }, 400);
  }

  // entries 검증 + 서버에서 days 재계산 (클라이언트 신뢰 X)
  const TYPE_DAYS = { '연차': 1, '3/4차': 0.75, '오전반차': 0.5, '오후반차': 0.5, '반반차': 0.25 };
  if (!Array.isArray(entries) || entries.length === 0) {
    return json({ error: 'entries 배열이 비어 있습니다.' }, 400);
  }
  for (const ent of entries) {
    if (!ent.date || !ent.type) {
      return json({ error: 'entries[].date / type 필수' }, 400);
    }
    if (!(ent.type in TYPE_DAYS)) {
      return json({ error: `유효하지 않은 종류: ${ent.type}` }, 400);
    }
    if (ent.type === '반반차' && !ent.timeRange) {
      return json({ error: `반반차(${ent.date})는 시간 입력 필수` }, 400);
    }
  }
  const computedDays = entries.reduce((s, e) => s + TYPE_DAYS[e.type], 0);
  if (computedDays <= 0 || computedDays > 30) {
    return json({ error: '합산 일수는 0 < days <= 30' }, 400);
  }

  let gist;
  try {
    gist = await loadGist(token, gistId);
  } catch (err) {
    return json({ error: 'Gist load failed', detail: err.message }, 500);
  }

  const employees = gist.employees?.employees || [];
  const settings = gist.settings || {};
  const requestsData = gist.requests || { requests: [] };

  const employee = employees.find(e => e.email?.toLowerCase() === email.toLowerCase());
  if (!employee) {
    return json({ error: '등록되지 않은 직원입니다. 관리자에게 문의하세요.' }, 403);
  }
  if (employee.name && employee.name !== name) {
    return json({ error: '이름과 이메일이 일치하지 않습니다.' }, 403);
  }

  const leaveInfo = calcRemaining(employee, requestsData.requests, settings);
  if (computedDays > leaveInfo.remaining) {
    return json({
      error: `잔여 연차(${leaveInfo.remaining}일)보다 많이 신청할 수 없습니다.`,
      remaining: leaveInfo.remaining
    }, 400);
  }

  // Web Crypto API로 토큰 생성 (Edge runtime — Node crypto 미지원)
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const confirmToken = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  const validityDays = Number(settings.confirmTokenValidityDays) || 30;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + validityDays * 86400 * 1000);

  const reqId = `req-${formatYmd(now)}-${String(requestsData.requests.length + 1).padStart(3, '0')}`;
  const approvalMode = settings.approvalMode || 'manual';
  const status = approvalMode === 'auto' ? 'auto_approved' : 'pending';

  // 종류 라벨 (혼합 여부 판단)
  const uniqueTypes = [...new Set(entries.map(e => e.type))];
  const summaryType = uniqueTypes.length === 1 ? uniqueTypes[0] : '혼합';

  const newRequest = {
    id: reqId,
    employeeId: employee.id,
    employeeName: employee.name,
    employeeEmail: employee.email,
    department: employee.department || '',
    teamLeaderEmail: employee.teamLeaderEmail || '',
    isExecutive: !!employee.isExecutive,
    leaveType: summaryType,
    entries,
    startDate,
    endDate,
    days: computedDays,
    reason: reason || '',
    verbalReportConfirmed: !!verbalReportConfirmed,
    submittedAt: now.toISOString(),
    status,
    approvalMode,
    approvedAt: status === 'auto_approved' ? now.toISOString() : null,
    approvedBy: status === 'auto_approved' ? 'system' : null,
    rejectedAt: null,
    rejectReason: null,
    confirmToken,
    confirmTokenExpiresAt: expiresAt.toISOString(),
    confirmedAt: null,
    confirmedIp: null,
    emailsSent: []
  };

  // 이메일 발송: 모든 신청 → 김은주 차장(adminEmail). 일반팀원은 팀장 CC.
  const adminEmail = settings.adminEmail || 'eunju@eyepopeng.com';
  const siteOrigin = process.env.SITE_ORIGIN || 'https://eyepop-leave-management.vercel.app';
  const confirmUrl = `${siteOrigin}/api/confirm-token?t=${confirmToken}`;

  const emailResults = [];
  try {
    const adminTo = adminEmail;
    const adminCc = !employee.isExecutive ? employee.teamLeaderEmail : null;

    const adminSubject = `[연차 ${status === 'auto_approved' ? '자동승인' : '신청'}] ${employee.name} ${startDate}~${endDate} (${computedDays}일)`;
    const adminHtml = renderAdminMail({ employee, newRequest, leaveInfo });
    const r1 = await sendEmail({ to: adminTo, cc: adminCc || undefined, subject: adminSubject, html: adminHtml });
    emailResults.push({ to: adminTo, role: 'admin', sentAt: r1.sentAt, messageId: r1.messageId });
    if (adminCc) emailResults.push({ to: adminCc, role: 'cc', sentAt: r1.sentAt });

    const empSubject =
      status === 'auto_approved'
        ? `[연차 승인] ${startDate}~${endDate} 승인 알림`
        : `[연차 접수] ${startDate}~${endDate} 신청이 접수되었습니다`;
    const empHtml = renderEmployeeMail({ employee, newRequest, leaveInfo, confirmUrl, status });
    const r2 = await sendEmail({ to: employee.email, subject: empSubject, html: empHtml });
    emailResults.push({ to: employee.email, role: 'confirm', sentAt: r2.sentAt, messageId: r2.messageId });
  } catch (err) {
    return json({ error: '이메일 발송 실패', detail: err.message }, 502);
  }

  newRequest.emailsSent = emailResults;
  requestsData.requests.push(newRequest);
  requestsData.updatedAt = now.toISOString();

  try {
    await saveGist(token, gistId, 'requests.json', requestsData);
  } catch (err) {
    return json({ error: 'Gist 저장 실패', detail: err.message }, 500);
  }

  return json({
    status: 'ok',
    requestId: reqId,
    requestStatus: status,
    remainingAfter: leaveInfo.remaining - Number(days),
    emails: emailResults.map(e => ({ to: e.to, role: e.role }))
  });
}

// ────────────────── 헬퍼 ──────────────────

async function loadGist(token, gistId) {
  const resp = await fetch(`${GIST_API}/${gistId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'eyepop-leave-management'
    }
  });
  if (!resp.ok) throw new Error(`Gist fetch ${resp.status}`);
  const data = await resp.json();
  const out = {};
  for (const [name, f] of Object.entries(data.files || {})) {
    const key = name.replace(/\.json$/, '');
    try {
      out[key] = JSON.parse(f.content);
    } catch {
      out[key] = null;
    }
  }
  return out;
}

async function saveGist(token, gistId, file, content) {
  const resp = await fetch(`${GIST_API}/${gistId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'eyepop-leave-management'
    },
    body: JSON.stringify({
      files: { [file]: { content: JSON.stringify(content, null, 2) } }
    })
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gist update ${resp.status}: ${text}`);
  }
}

function formatYmd(d) {
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

function renderEntriesTable(entries) {
  if (!entries || !entries.length) return '';
  const rows = entries.map(e => {
    const time = e.timeRange ? ` <span style="color:#777; font-size:12px;">(${escapeHtml(e.timeRange)})</span>` : '';
    return `<tr><td style="padding:4px 8px; border-bottom:1px solid #eee;">${escapeHtml(e.date)}</td><td style="padding:4px 8px; border-bottom:1px solid #eee;">${escapeHtml(e.type)}${time}</td><td style="padding:4px 8px; border-bottom:1px solid #eee; text-align:right;">${e.days}일</td></tr>`;
  }).join('');
  return `<table style="border-collapse:collapse; width:100%; margin-top:6px; font-size:13px;">
    <thead><tr style="background:#f5f7fa;"><th style="padding:6px 8px; text-align:left;">날짜</th><th style="padding:6px 8px; text-align:left;">종류</th><th style="padding:6px 8px; text-align:right;">일수</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderAdminMail({ employee, newRequest, leaveInfo }) {
  const { startDate, endDate, days, leaveType, entries, reason, status, verbalReportConfirmed } = newRequest;
  const statusLabel = status === 'auto_approved' ? '자동 승인됨' : '승인 대기';
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif; line-height:1.6; max-width:640px;">
    <h2 style="border-bottom:2px solid #4a90e2; padding-bottom:8px;">연차 신청 ${statusLabel}</h2>
    <table style="border-collapse:collapse; width:100%;">
      <tr><td style="padding:6px; background:#f5f7fa; width:120px;">신청자</td><td style="padding:6px;">${escapeHtml(employee.name)} (${escapeHtml(employee.department || '-')})</td></tr>
      <tr><td style="padding:6px; background:#f5f7fa;">기간</td><td style="padding:6px;">${escapeHtml(startDate)} ~ ${escapeHtml(endDate)} <b>총 ${days}일</b></td></tr>
      <tr><td style="padding:6px; background:#f5f7fa;">종류</td><td style="padding:6px;">${escapeHtml(leaveType)}</td></tr>
      <tr><td style="padding:6px; background:#f5f7fa;">사유</td><td style="padding:6px;">${escapeHtml(reason) || '-'}</td></tr>
      <tr><td style="padding:6px; background:#f5f7fa;">팀장 구두보고</td><td style="padding:6px;">${verbalReportConfirmed ? '✅ 확인' : '⚠️ 미확인'}</td></tr>
      <tr><td style="padding:6px; background:#f5f7fa;">잔여 (사용/총)</td><td style="padding:6px;">${leaveInfo.remaining}일 (${leaveInfo.used}/${leaveInfo.total})</td></tr>
    </table>
    <h3 style="margin:18px 0 6px; font-size:14px;">일자별 사용 내역</h3>
    ${renderEntriesTable(entries)}
  </div>`;
}

function renderEmployeeMail({ employee, newRequest, leaveInfo, confirmUrl, status }) {
  const { startDate, endDate, days, entries } = newRequest;
  const statusMsg =
    status === 'auto_approved'
      ? '연차 신청이 자동으로 <b>승인</b>되었습니다.'
      : '연차 신청이 <b>접수</b>되었습니다. 관리자 승인 후 안내 메일을 다시 보내드립니다.';
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif; line-height:1.7; max-width:640px;">
    <h2 style="border-bottom:2px solid #4a90e2; padding-bottom:8px;">${escapeHtml(employee.name)}님</h2>
    <p>${statusMsg}</p>
    <table style="border-collapse:collapse; margin:12px 0;">
      <tr><td style="padding:6px;">기간</td><td style="padding:6px; font-weight:bold;">${escapeHtml(startDate)} ~ ${escapeHtml(endDate)} 총 ${days}일</td></tr>
      <tr><td style="padding:6px;">사용 후 잔여</td><td style="padding:6px;">${leaveInfo.remaining - days}일</td></tr>
    </table>
    ${renderEntriesTable(entries)}
    <p style="margin:24px 0;">
      <a href="${confirmUrl}" style="display:inline-block; padding:12px 24px; background:#4a90e2; color:#fff; text-decoration:none; border-radius:6px; font-weight:bold;">📩 수신 확인하기</a>
    </p>
    <p style="font-size:13px; color:#666;">
      위 버튼을 1회 클릭해 주세요. 회사에 도달 사실이 기록됩니다.<br/>
      유효기간: 30일.
    </p>
    <hr style="border:none; border-top:1px solid #eee; margin:24px 0;"/>
    <p style="font-size:12px; color:#999;">EYEPOP 연차관리 시스템 · 자동 발송 · 회신 불가</p>
  </div>`;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

function cors() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
