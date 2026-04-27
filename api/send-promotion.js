// Vercel Edge Function — 연차 사용 촉진 메일 발송 (관리자 전용)
// 근로기준법 제61조 1차/2차 통지서 발송
// 1차: 직원에게 사용 시기 지정 회신 요구 (10일 내)
// 2차: 회사가 사용 시기 지정해서 통지

export const config = { runtime: 'edge' };

import { sendEmail, escapeHtml } from '../lib/email.js';
import { calcRemaining } from '../lib/leave-calc.js';

const GIST_API = 'https://api.github.com/gists';

export default async function handler(req) {
  if (req.method === 'OPTIONS') return cors();
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const adminKey = process.env.ADMIN_KEY;
  if (req.headers.get('x-admin-key') !== adminKey) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const ghToken = process.env.GIST_TOKEN;
  const gistId = process.env.GIST_ID;
  if (!ghToken || !gistId) return json({ error: 'Server not configured' }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { phase, employeeIds, assignedPeriod } = body;
  if (phase !== 'first' && phase !== 'second') {
    return json({ error: 'phase는 first 또는 second' }, 400);
  }
  if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
    return json({ error: 'employeeIds 배열 필수' }, 400);
  }
  if (phase === 'second' && (!assignedPeriod || !assignedPeriod.trim())) {
    return json({ error: '2차 통지는 assignedPeriod (사용 시기) 필수' }, 400);
  }

  let gist;
  try { gist = await loadGist(ghToken, gistId); } catch (err) {
    return json({ error: 'Gist load failed', detail: err.message }, 500);
  }

  const employees = gist.employees?.employees || [];
  const requests = gist.requests?.requests || [];
  const settings = gist.settings || {};
  const senderName = settings.senderName || '김은주 차장';
  const senderEmail = settings.adminEmail || 'eunju@eyepopeng.com';
  const year = new Date().getFullYear();
  const deadline = `${year}-12-31`;

  const results = [];
  for (const empId of employeeIds) {
    const emp = employees.find(e => e.id === empId);
    if (!emp) {
      results.push({ employeeId: empId, status: 'error', error: '직원 정보 없음' });
      continue;
    }
    const leave = calcRemaining(emp, requests, settings);
    const subject = phase === 'first'
      ? `[연차 사용 시기 지정 요청] ${emp.name}님 ${year}년 1차 촉진 통지 (근로기준법 제61조)`
      : `[연차 사용 시기 통지] ${emp.name}님 ${year}년 2차 촉진 통지 (근로기준법 제61조)`;
    const html = phase === 'first'
      ? renderFirstNotice({ emp, leave, year, deadline, senderName, senderEmail })
      : renderSecondNotice({ emp, leave, year, deadline, senderName, senderEmail, assignedPeriod });
    try {
      const r = await sendEmail({
        to: emp.email,
        subject,
        html,
        replyTo: senderEmail
      });
      results.push({
        employeeId: empId,
        employeeName: emp.name,
        email: emp.email,
        status: 'sent',
        messageId: r.messageId,
        sentAt: r.sentAt,
        remaining: leave.remaining
      });
    } catch (err) {
      results.push({
        employeeId: empId,
        employeeName: emp.name,
        email: emp.email,
        status: 'error',
        error: err.message
      });
    }
  }

  // 발송 이력을 settings.promotionLog에 저장
  const logKey = `${year}-${phase}`;
  settings.promotionLog = settings.promotionLog || {};
  settings.promotionLog[logKey] = settings.promotionLog[logKey] || [];
  for (const r of results) {
    if (r.status === 'sent') {
      settings.promotionLog[logKey].push({
        employeeId: r.employeeId,
        employeeName: r.employeeName,
        email: r.email,
        sentAt: r.sentAt,
        messageId: r.messageId,
        remaining: r.remaining,
        assignedPeriod: phase === 'second' ? assignedPeriod : undefined
      });
    }
  }
  settings.updatedAt = new Date().toISOString();

  try {
    await saveGist(ghToken, gistId, 'settings.json', settings);
  } catch (err) {
    return json({ status: 'sent_but_save_failed', detail: err.message, results }, 200);
  }

  const sentCount = results.filter(r => r.status === 'sent').length;
  const errorCount = results.filter(r => r.status === 'error').length;
  return json({ status: 'ok', phase, sentCount, errorCount, results });
}

// ──────────── 1차 통지 메일 ────────────
function renderFirstNotice({ emp, leave, year, deadline, senderName, senderEmail }) {
  const responseDeadline = addDays(new Date(), 10);
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif; line-height:1.7; max-width:680px; color:#222;">
    <h2 style="border-bottom:2px solid #4a90e2; padding-bottom:8px;">${year}년 연차 사용 시기 지정 요청 (1차 통지)</h2>
    <p>${escapeHtml(emp.name)}${emp.department ? ` · ${escapeHtml(emp.department)}` : ''} 귀하</p>

    <p>「근로기준법 제61조(연차 유급휴가의 사용 촉진)」 및 같은 법 시행령 제33조에 따라
       귀하의 ${year}년도 미사용 연차 휴가에 대한 사용 시기 지정을 요청드립니다.</p>

    <div style="background:#f5f7fa; padding:14px 18px; border-radius:8px; margin:18px 0;">
      <b>📊 ${year}년 연차 사용 현황</b><br/>
      • 발생 연차: <b>${leave.total}일</b><br/>
      • 사용 연차: ${leave.used}일<br/>
      • 신청 대기: ${leave.pending || 0}일<br/>
      • 미사용 연차: <b style="color:#c97a1a;">${leave.remaining}일</b>
    </div>

    <h3 style="font-size:15px; color:#b93a3a; margin:22px 0 8px;">📌 회신 요청 사항</h3>
    <ul style="line-height:1.9;">
      <li>본 통지를 받으신 날로부터 <b>10일 이내</b> (~ ${ymd(responseDeadline)})
          미사용 연차의 <b>사용 시기를 지정</b>하여 회신해주시기 바랍니다.</li>
      <li>회신은 본 메일에 답장(Reply) 형식으로 ${escapeHtml(senderName)}(${escapeHtml(senderEmail)})에게 보내주십시오.</li>
      <li>사용 기한: <b>${deadline}까지</b></li>
    </ul>

    <div style="background:#fef9ec; border-left:3px solid #c97a1a; padding:12px 16px; margin:18px 0; border-radius:6px;">
      <b>⚠ 미회신 시 안내</b><br/>
      10일 이내 회신이 없을 경우 「근로기준법 시행령 제33조」에 따라
      <b>2차 통지(사용 만료 2개월 전)</b>를 통해 회사가 사용 시기를 지정·통지하게 되며,
      그 경우에도 사용하지 않으면 미사용 연차 보상 의무가 면제됩니다.
    </div>

    <h3 style="font-size:15px; margin:22px 0 8px;">📝 회신 양식 (예시)</h3>
    <div style="background:#fafbfc; border:1px solid #e0e4ea; padding:14px 18px; border-radius:6px; font-family:monospace; font-size:13px; line-height:1.9;">
      성명: ${escapeHtml(emp.name)}<br/>
      부서: ${escapeHtml(emp.department || '-')}<br/>
      미사용 연차: ${leave.remaining}일<br/>
      사용 시기 지정:<br/>
      &nbsp;&nbsp;1) ${year}-MM-DD ~ ${year}-MM-DD (X일)<br/>
      &nbsp;&nbsp;2) ${year}-MM-DD ~ ${year}-MM-DD (X일)<br/>
      &nbsp;&nbsp;... (총 ${leave.remaining}일)
    </div>

    <p style="margin:24px 0 6px;">
      <a href="https://eyepop-leave-management.vercel.app/apply.html" style="display:inline-block; padding:10px 20px; background:#4a90e2; color:#fff; text-decoration:none; border-radius:6px; font-weight:bold;">연차 신청 시스템 열기</a>
    </p>
    <p style="font-size:12px; color:#666;">시스템에 직접 신청하시면 회신을 대신할 수 있습니다.</p>

    <hr style="border:none; border-top:1px solid #eee; margin:24px 0;"/>
    <p style="font-size:13px; color:#444;">
      EYEPOP ENG · 경영기획실 ${escapeHtml(senderName)}<br/>
      ${escapeHtml(senderEmail)}
    </p>
    <p style="font-size:11px; color:#999;">본 통지는 근로기준법 제61조에 따른 법정 통지로, 3년간 보존됩니다.</p>
  </div>`;
}

// ──────────── 2차 통지 메일 ────────────
function renderSecondNotice({ emp, leave, year, deadline, senderName, senderEmail, assignedPeriod }) {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif; line-height:1.7; max-width:680px; color:#222;">
    <h2 style="border-bottom:2px solid #b93a3a; color:#b93a3a; padding-bottom:8px;">${year}년 연차 사용 시기 통지 (2차 통지)</h2>
    <p>${escapeHtml(emp.name)}${emp.department ? ` · ${escapeHtml(emp.department)}` : ''} 귀하</p>

    <p>「근로기준법 제61조(연차 유급휴가의 사용 촉진)」 및 같은 법 시행령 제33조에 따라
       회사가 ${year}년 ${escapeHtml(emp.name)}님의 미사용 연차 사용 시기를 다음과 같이 지정하여 통지합니다.</p>

    <div style="background:#fef2f2; border-left:3px solid #b93a3a; padding:14px 18px; margin:18px 0; border-radius:6px;">
      <b>📅 회사 지정 사용 시기</b><br/>
      ${escapeHtml(assignedPeriod)}
    </div>

    <div style="background:#f5f7fa; padding:14px 18px; border-radius:8px; margin:18px 0;">
      <b>📊 ${year}년 연차 사용 현황</b><br/>
      • 발생 연차: ${leave.total}일<br/>
      • 사용 연차: ${leave.used}일<br/>
      • 미사용 연차: <b style="color:#c97a1a;">${leave.remaining}일</b><br/>
      • 사용 기한: <b>${deadline}까지</b>
    </div>

    <p>본 통지는 1차 통지에 대한 회신 부재로 발송된 법정 통지이며,
       지정된 시기에 사용하지 않으실 경우 「근로기준법 제61조」에 따라
       <b>미사용 연차에 대한 회사의 보상(수당) 지급 의무가 면제</b>됩니다.</p>

    <p>지정 시기 변경이 필요하신 경우 즉시 ${escapeHtml(senderName)}(${escapeHtml(senderEmail)})에게 협의 요청해주십시오.</p>

    <p style="margin:24px 0 6px;">
      <a href="https://eyepop-leave-management.vercel.app/apply.html" style="display:inline-block; padding:10px 20px; background:#4a90e2; color:#fff; text-decoration:none; border-radius:6px; font-weight:bold;">연차 신청 시스템 열기</a>
    </p>

    <hr style="border:none; border-top:1px solid #eee; margin:24px 0;"/>
    <p style="font-size:13px; color:#444;">
      EYEPOP ENG · 경영기획실 ${escapeHtml(senderName)}<br/>
      ${escapeHtml(senderEmail)}
    </p>
    <p style="font-size:11px; color:#999;">본 통지는 근로기준법 제61조에 따른 법정 통지로, 3년간 보존됩니다.</p>
  </div>`;
}

// ──────────── 헬퍼 ────────────
function addDays(d, n) {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
}
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

async function loadGist(token, gistId) {
  const resp = await fetch(`${GIST_API}/${gistId}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'eyepop-leave-management' }
  });
  if (!resp.ok) throw new Error(`Gist fetch ${resp.status}`);
  const data = await resp.json();
  const out = {};
  for (const [name, f] of Object.entries(data.files || {})) {
    const key = name.replace(/\.json$/, '');
    try { out[key] = JSON.parse(f.content); } catch { out[key] = null; }
  }
  return out;
}

async function saveGist(token, gistId, file, content) {
  const resp = await fetch(`${GIST_API}/${gistId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'eyepop-leave-management' },
    body: JSON.stringify({ files: { [file]: { content: JSON.stringify(content, null, 2) } } })
  });
  if (!resp.ok) throw new Error(`Gist update ${resp.status}: ${await resp.text()}`);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
function cors() {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, x-admin-key' } });
}
