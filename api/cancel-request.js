// 직원 본인 신청 철회 (세션 토큰 인증 필요)
// 철회 시 직원 To, 김은주 차장 + 팀장 CC 메일 자동 발송
export const config = { runtime: 'edge' };

import { sendEmail, escapeHtml } from '../lib/email.js';
import { verifyToken } from '../lib/otp-token.js';

const GIST_API = 'https://api.github.com/gists';

export default async function handler(req) {
  if (req.method === 'OPTIONS') return cors();
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const ghToken = process.env.GIST_TOKEN;
  const gistId = process.env.GIST_ID;
  const otpSecret = process.env.OTP_SECRET;
  if (!ghToken || !gistId) return json({ error: 'Server not configured (Gist)' }, 500);
  if (!otpSecret) return json({ error: 'Server not configured (OTP_SECRET)' }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const cancelToken = body?.token;
  const cancelReason = (body?.reason || '').trim();
  if (!cancelToken) return json({ error: 'token 필수' }, 400);

  const payload = await verifyToken(cancelToken, otpSecret);
  if (!payload) return json({ error: '철회 링크가 만료되었거나 유효하지 않습니다. 김은주 차장에게 연락해주세요.' }, 401);
  if (payload.scope !== 'cancel') return json({ error: '잘못된 토큰 종류' }, 401);
  const requestId = payload.requestId;
  if (!requestId) return json({ error: '토큰에 신청 ID가 없습니다.' }, 400);

  let gist;
  try { gist = await loadGist(ghToken, gistId); }
  catch (err) { return json({ error: 'Gist load failed', detail: err.message }, 500); }

  const requestsData = gist.requests || { requests: [] };
  const settings = gist.settings || {};
  const reqItem = requestsData.requests.find(r => r.id === requestId);
  if (!reqItem) return json({ error: '신청을 찾을 수 없습니다.' }, 404);

  // 본인 소유 검증 (토큰 발급 시 이메일과 신청 이메일 일치)
  if (reqItem.employeeEmail?.toLowerCase() !== (payload.email || '').toLowerCase()) {
    return json({ error: '본인 신청만 철회 가능합니다.' }, 403);
  }

  // 이미 철회·반려된 건은 철회 불가
  if (['cancelled', 'rejected'].includes(reqItem.status)) {
    return json({ error: `이미 ${reqItem.status === 'cancelled' ? '철회' : '반려'}된 신청입니다.` }, 400);
  }

  const now = new Date().toISOString();
  const prevStatus = reqItem.status;
  reqItem.status = 'cancelled';
  reqItem.cancelledAt = now;
  reqItem.cancelledBy = 'employee';
  reqItem.cancelReason = cancelReason || '직원 본인 철회';
  reqItem.previousStatus = prevStatus;
  requestsData.updatedAt = now;

  // 메일 발송: 직원 To, 김은주 + 팀장 CC
  const adminEmail = settings.adminEmail || 'eunju@eyepopeng.com';
  const ccList = [adminEmail];
  if (!reqItem.isExecutive && reqItem.teamLeaderEmail) ccList.push(reqItem.teamLeaderEmail);

  try {
    const subject = `[연차 철회] ${reqItem.employeeName} ${reqItem.startDate}~${reqItem.endDate} (${reqItem.days}일)`;
    const html = renderCancelMail(reqItem, prevStatus);
    const r = await sendEmail({
      to: reqItem.employeeEmail,
      cc: ccList.join(', '),
      subject, html
    });
    reqItem.emailsSent = reqItem.emailsSent || [];
    reqItem.emailsSent.push({
      to: reqItem.employeeEmail, cc: ccList,
      role: 'cancel', sentAt: r.sentAt, messageId: r.messageId
    });
  } catch (err) {
    return json({ error: '철회 메일 발송 실패', detail: err.message }, 502);
  }

  try { await saveGist(ghToken, gistId, 'requests.json', requestsData); }
  catch (err) { return json({ error: 'Gist save failed', detail: err.message }, 500); }

  return json({ ok: true, message: '철회가 완료되었습니다. 본인·관리자·팀장에게 메일이 발송되었습니다.' });
}

function renderCancelMail(req, prevStatus) {
  const statusLabel = prevStatus === 'auto_approved' || prevStatus === 'approved' ? '승인' : '대기';
  return `<!DOCTYPE html>
<html><body style="font-family:'Apple SD Gothic Neo',sans-serif; max-width:560px; margin:auto; padding:24px; color:#333;">
  <h2 style="color:#b93a3a; margin-top:0;">📋 연차 신청 철회</h2>
  <p><b>${escapeHtml(req.employeeName)}</b>님이 직접 본인 신청을 철회하셨습니다.</p>

  <table style="width:100%; border-collapse:collapse; margin:16px 0; font-size:14px;">
    <tr><td style="padding:8px; background:#f5f7fa; width:120px;">기간</td><td style="padding:8px;">${escapeHtml(req.startDate)} ~ ${escapeHtml(req.endDate)}</td></tr>
    <tr><td style="padding:8px; background:#f5f7fa;">일수</td><td style="padding:8px;">${req.days}일</td></tr>
    <tr><td style="padding:8px; background:#f5f7fa;">종류</td><td style="padding:8px;">${escapeHtml(req.leaveType || '-')}</td></tr>
    <tr><td style="padding:8px; background:#f5f7fa;">사유</td><td style="padding:8px;">${escapeHtml(req.reason || '-')}</td></tr>
    <tr><td style="padding:8px; background:#f5f7fa;">철회 전 상태</td><td style="padding:8px;">${statusLabel}</td></tr>
    <tr><td style="padding:8px; background:#fef2f2;">철회 사유</td><td style="padding:8px; color:#b93a3a;">${escapeHtml(req.cancelReason)}</td></tr>
    <tr><td style="padding:8px; background:#f5f7fa;">철회 시각</td><td style="padding:8px;">${escapeHtml(req.cancelledAt)}</td></tr>
  </table>

  <p style="background:#f0f4f9; padding:12px; border-radius:6px; font-size:13px;">
    · 잔여 연차에 자동 반영됩니다.<br/>
    · 다시 신청하시려면 <a href="${process.env.SITE_ORIGIN || 'https://leave.eyepopeng.com'}">leave.eyepopeng.com</a>에서 새로 신청하세요.
  </p>

  <hr style="border:none; border-top:1px solid #eee; margin:24px 0;"/>
  <p style="font-size:12px; color:#999;">EYEPOP Engineering · 연차관리 시스템</p>
</body></html>`;
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
    status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

function cors() {
  return new Response(null, {
    status: 204,
    headers: { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
  });
}
