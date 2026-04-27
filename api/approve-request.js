// Vercel Edge Function — 연차 신청 승인 처리 (관리자 전용)
export const config = { runtime: 'edge' };

import { sendEmail, escapeHtml } from '../lib/email.js';

const GIST_API = 'https://api.github.com/gists';

export default async function handler(req) {
  if (req.method === 'OPTIONS') return cors();
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const adminKey = process.env.ADMIN_KEY;
  if (req.headers.get('x-admin-key') !== adminKey) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const token = process.env.GIST_TOKEN;
  const gistId = process.env.GIST_ID;
  if (!token || !gistId) return json({ error: 'Server not configured' }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { requestId, approvedBy = 'admin' } = body;
  if (!requestId) return json({ error: 'requestId required' }, 400);

  let gist;
  try { gist = await loadGist(token, gistId); } catch (err) {
    return json({ error: 'Gist load failed', detail: err.message }, 500);
  }

  const requestsData = gist.requests || { requests: [] };
  const idx = requestsData.requests.findIndex(r => r.id === requestId);
  if (idx === -1) return json({ error: 'Request not found' }, 404);

  const reqItem = requestsData.requests[idx];
  if (reqItem.status === 'approved' || reqItem.status === 'auto_approved') {
    return json({ error: '이미 승인된 신청입니다.' }, 409);
  }
  if (reqItem.status === 'rejected') {
    return json({ error: '반려된 신청은 승인할 수 없습니다.' }, 409);
  }

  const now = new Date().toISOString();
  reqItem.status = 'approved';
  reqItem.approvedAt = now;
  reqItem.approvedBy = approvedBy;
  requestsData.updatedAt = now;

  // 신청자에게 승인 알림 메일
  try {
    const subject = `[연차 승인] ${reqItem.startDate}~${reqItem.endDate} (${reqItem.days}일) 승인 알림`;
    const html = renderApproveMail(reqItem);
    const r = await sendEmail({ to: reqItem.employeeEmail, subject, html });
    reqItem.emailsSent = reqItem.emailsSent || [];
    reqItem.emailsSent.push({ to: reqItem.employeeEmail, role: 'approve', sentAt: r.sentAt, messageId: r.messageId });
  } catch (err) {
    return json({ error: '승인 메일 발송 실패', detail: err.message }, 502);
  }

  try {
    await saveGist(token, gistId, 'requests.json', requestsData);
  } catch (err) {
    return json({ error: 'Gist 저장 실패', detail: err.message }, 500);
  }

  return json({ status: 'ok', requestId, approvedAt: now });
}

function renderApproveMail(req) {
  const entries = req.entries || [];
  const rows = entries.map(e => {
    const time = e.timeRange ? ` (${escapeHtml(e.timeRange)})` : '';
    return `<tr><td style="padding:4px 8px; border-bottom:1px solid #eee;">${escapeHtml(e.date)}</td><td style="padding:4px 8px; border-bottom:1px solid #eee;">${escapeHtml(e.type)}${time}</td><td style="padding:4px 8px; border-bottom:1px solid #eee; text-align:right;">${e.days}일</td></tr>`;
  }).join('');
  const entriesTable = entries.length
    ? `<table style="border-collapse:collapse; width:100%; margin-top:6px; font-size:13px;">
      <thead><tr style="background:#f5f7fa;"><th style="padding:6px 8px; text-align:left;">날짜</th><th style="padding:6px 8px; text-align:left;">종류</th><th style="padding:6px 8px; text-align:right;">일수</th></tr></thead>
      <tbody>${rows}</tbody></table>` : '';
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif; line-height:1.7; max-width:640px;">
    <h2 style="border-bottom:2px solid #2e7d4f; color:#2e7d4f; padding-bottom:8px;">${escapeHtml(req.employeeName)}님, 연차가 승인되었습니다 ✅</h2>
    <p>경영기획실에서 ${escapeHtml(req.startDate)} ~ ${escapeHtml(req.endDate)} (총 ${req.days}일) 연차 신청을 <b>승인</b>하였습니다.</p>
    <h3 style="margin:18px 0 6px; font-size:14px;">일자별 사용 내역</h3>
    ${entriesTable}
    <hr style="border:none; border-top:1px solid #eee; margin:24px 0;"/>
    <p style="font-size:12px; color:#999;">EYEPOP 연차관리 시스템 · 자동 발송 · 회신 불가</p>
  </div>`;
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
