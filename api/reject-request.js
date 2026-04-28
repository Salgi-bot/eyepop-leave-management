// Vercel Edge Function — 연차 신청 반려 처리 (관리자 전용)
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
  const { requestId, reason } = body;
  if (!requestId) return json({ error: 'requestId required' }, 400);
  if (!reason || !reason.trim()) return json({ error: '반려 사유 필수' }, 400);

  let gist;
  try { gist = await loadGist(token, gistId); } catch (err) {
    return json({ error: 'Gist load failed', detail: err.message }, 500);
  }

  const requestsData = gist.requests || { requests: [] };
  const idx = requestsData.requests.findIndex(r => r.id === requestId);
  if (idx === -1) return json({ error: 'Request not found' }, 404);

  const reqItem = requestsData.requests[idx];
  if (reqItem.status === 'rejected') {
    return json({ error: '이미 반려된 신청입니다.' }, 409);
  }
  if (reqItem.status === 'approved' || reqItem.status === 'auto_approved') {
    return json({ error: '승인된 신청은 반려할 수 없습니다. 별도 취소 처리 필요.' }, 409);
  }

  const now = new Date().toISOString();
  reqItem.status = 'rejected';
  reqItem.rejectedAt = now;
  reqItem.rejectReason = reason.trim();
  requestsData.updatedAt = now;

  try {
    const settings = gist.settings || {};
    const adminEmail = settings.adminEmail || 'eunju@eyepopeng.com';
    const ccList = [adminEmail];
    if (!reqItem.isExecutive && reqItem.teamLeaderEmail) ccList.push(reqItem.teamLeaderEmail);
    const subject = `[연차 반려] ${reqItem.employeeName} ${reqItem.startDate}~${reqItem.endDate} 신청 반려 안내`;
    const html = renderRejectMail(reqItem);
    const r = await sendEmail({ to: reqItem.employeeEmail, cc: ccList.join(', '), subject, html });
    reqItem.emailsSent = reqItem.emailsSent || [];
    reqItem.emailsSent.push({ to: reqItem.employeeEmail, cc: ccList, role: 'reject', sentAt: r.sentAt, messageId: r.messageId });
  } catch (err) {
    return json({ error: '반려 메일 발송 실패', detail: err.message }, 502);
  }

  try {
    await saveGist(token, gistId, 'requests.json', requestsData);
  } catch (err) {
    return json({ error: 'Gist 저장 실패', detail: err.message }, 500);
  }

  return json({ status: 'ok', requestId, rejectedAt: now });
}

function renderRejectMail(req) {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif; line-height:1.7; max-width:640px;">
    <h2 style="border-bottom:2px solid #b93a3a; color:#b93a3a; padding-bottom:8px;">${escapeHtml(req.employeeName)}님, 연차 신청이 반려되었습니다</h2>
    <p>${escapeHtml(req.startDate)} ~ ${escapeHtml(req.endDate)} (${req.days}일) 연차 신청이 다음 사유로 반려되었습니다.</p>
    <div style="background:#fef2f2; border-left:3px solid #b93a3a; padding:12px 16px; margin:16px 0; border-radius:6px;">
      <b>반려 사유</b><br/>
      ${escapeHtml(req.rejectReason)}
    </div>
    <p style="font-size:13px; color:#666;">문의는 경영기획실 김은주 차장에게 연락 주세요.</p>
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
