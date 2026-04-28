// Vercel Edge Function — 관리자 액션 통합 처리 (삭제·수정·승인취소)
// 모든 액션 직원 To, 관리자(김은주) + 팀장 CC 메일 발송
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

  const ghToken = process.env.GIST_TOKEN;
  const gistId = process.env.GIST_ID;
  if (!ghToken || !gistId) return json({ error: 'Server not configured' }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { action, requestId, changes } = body;

  if (!['delete', 'edit', 'revert'].includes(action)) {
    return json({ error: 'action은 delete | edit | revert' }, 400);
  }
  if (!requestId) return json({ error: 'requestId required' }, 400);

  let gist;
  try { gist = await loadGist(ghToken, gistId); } catch (err) {
    return json({ error: 'Gist load failed', detail: err.message }, 500);
  }

  const requestsData = gist.requests || { requests: [] };
  const settings = gist.settings || {};
  const adminEmail = settings.adminEmail || 'eunju@eyepopeng.com';

  const idx = requestsData.requests.findIndex(r => r.id === requestId);
  if (idx === -1) return json({ error: 'Request not found' }, 404);
  const reqItem = requestsData.requests[idx];

  // 액션별 처리 + 메일 본문
  let subject, html, savedItem;
  const before = JSON.parse(JSON.stringify(reqItem));

  if (action === 'delete') {
    requestsData.requests.splice(idx, 1);
    savedItem = before;
    subject = `[연차 신청 삭제] ${reqItem.employeeName} ${reqItem.startDate}~${reqItem.endDate}`;
    html = renderDeleteMail(reqItem);
  } else if (action === 'revert') {
    if (reqItem.status !== 'approved' && reqItem.status !== 'auto_approved') {
      return json({ error: '승인된 신청만 취소 가능' }, 409);
    }
    reqItem.status = 'pending';
    reqItem.approvedAt = null;
    reqItem.approvedBy = null;
    savedItem = reqItem;
    subject = `[연차 승인 취소] ${reqItem.employeeName} ${reqItem.startDate}~${reqItem.endDate}`;
    html = renderRevertMail(reqItem);
  } else if (action === 'edit') {
    const allowed = ['reason', 'leaveType', 'status', 'rejectReason'];
    const applied = {};
    for (const k of allowed) {
      if (changes && Object.prototype.hasOwnProperty.call(changes, k)) {
        applied[k] = changes[k];
        reqItem[k] = changes[k];
      }
    }
    // 상태 변경 시 부속 필드 자동 보정
    if (applied.status === 'approved' || applied.status === 'auto_approved') {
      if (!reqItem.approvedAt) reqItem.approvedAt = new Date().toISOString();
      if (!reqItem.approvedBy) reqItem.approvedBy = 'admin-edit';
    } else if (applied.status === 'pending') {
      reqItem.approvedAt = null;
      reqItem.approvedBy = null;
    } else if (applied.status === 'rejected') {
      if (!reqItem.rejectedAt) reqItem.rejectedAt = new Date().toISOString();
    }
    savedItem = reqItem;
    subject = `[연차 신청 수정] ${reqItem.employeeName} ${reqItem.startDate}~${reqItem.endDate}`;
    html = renderEditMail(before, reqItem, applied);
  }

  requestsData.updatedAt = new Date().toISOString();

  // 메일 수신자: 직원 To, 김은주 + 팀장 CC (To와 중복 제거)
  const empEmail = (savedItem.employeeEmail || '').toLowerCase();
  const ccSet = new Set();
  if (adminEmail && adminEmail.toLowerCase() !== empEmail) ccSet.add(adminEmail);
  if (!savedItem.isExecutive && savedItem.teamLeaderEmail
      && savedItem.teamLeaderEmail.toLowerCase() !== empEmail) {
    ccSet.add(savedItem.teamLeaderEmail);
  }
  const ccList = Array.from(ccSet);

  let mailResult;
  try {
    const sendOpts = {
      to: savedItem.employeeEmail,
      subject,
      html,
      replyTo: adminEmail
    };
    if (ccList.length > 0) sendOpts.cc = ccList.join(', ');
    mailResult = await sendEmail(sendOpts);
  } catch (err) {
    return json({ error: '메일 발송 실패', detail: err.message }, 502);
  }

  // 삭제가 아니면 신청 객체에 발송 이력 기록
  if (action !== 'delete' && reqItem) {
    reqItem.emailsSent = reqItem.emailsSent || [];
    reqItem.emailsSent.push({
      to: savedItem.employeeEmail,
      cc: ccList,
      role: `admin-${action}`,
      sentAt: mailResult.sentAt,
      messageId: mailResult.messageId
    });
  }

  try {
    await saveGist(ghToken, gistId, 'requests.json', requestsData);
  } catch (err) {
    return json({ error: 'Gist 저장 실패', detail: err.message }, 500);
  }

  return json({ status: 'ok', action, requestId, ccList, sentAt: mailResult.sentAt });
}

// ──────────── 메일 템플릿 ────────────

function renderDeleteMail(req) {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif; line-height:1.7; max-width:640px;">
    <h2 style="border-bottom:2px solid #b93a3a; color:#b93a3a; padding-bottom:8px;">연차 신청이 삭제되었습니다</h2>
    <p>${escapeHtml(req.employeeName)}님,</p>
    <p>아래 연차 신청이 관리자에 의해 <b>삭제</b>되었습니다.</p>
    <table style="border-collapse:collapse; margin:12px 0; font-size:13px;">
      <tr><td style="padding:6px; background:#f5f7fa; width:120px;">기간</td><td style="padding:6px;">${escapeHtml(req.startDate)} ~ ${escapeHtml(req.endDate)} (${req.days}일)</td></tr>
      <tr><td style="padding:6px; background:#f5f7fa;">종류</td><td style="padding:6px;">${escapeHtml(req.leaveType || '-')}</td></tr>
      <tr><td style="padding:6px; background:#f5f7fa;">기존 상태</td><td style="padding:6px;">${statusLabel(req.status)}</td></tr>
      <tr><td style="padding:6px; background:#f5f7fa;">사유</td><td style="padding:6px;">${escapeHtml(req.reason || '-')}</td></tr>
    </table>
    <p style="background:#fef2f2; border-left:3px solid #b93a3a; padding:10px 14px; border-radius:4px;">
      재신청이 필요한 경우 시스템에서 다시 신청해주세요.<br/>
      문의는 경영기획실 김은주 차장에게 연락 주세요.
    </p>
    <hr style="border:none; border-top:1px solid #eee; margin:24px 0;"/>
    <p style="font-size:12px; color:#999;">EYEPOP 연차관리 시스템 · 자동 발송 · 회신 불가</p>
  </div>`;
}

function renderRevertMail(req) {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif; line-height:1.7; max-width:640px;">
    <h2 style="border-bottom:2px solid #c97a1a; color:#c97a1a; padding-bottom:8px;">연차 승인이 취소되었습니다</h2>
    <p>${escapeHtml(req.employeeName)}님,</p>
    <p>아래 연차 신청의 <b>승인이 취소</b>되어 다시 <b>대기 상태</b>로 복귀되었습니다.</p>
    <table style="border-collapse:collapse; margin:12px 0; font-size:13px;">
      <tr><td style="padding:6px; background:#f5f7fa; width:120px;">기간</td><td style="padding:6px;">${escapeHtml(req.startDate)} ~ ${escapeHtml(req.endDate)} (${req.days}일)</td></tr>
      <tr><td style="padding:6px; background:#f5f7fa;">종류</td><td style="padding:6px;">${escapeHtml(req.leaveType || '-')}</td></tr>
      <tr><td style="padding:6px; background:#f5f7fa;">현재 상태</td><td style="padding:6px;"><b style="color:#c97a1a;">대기 (재검토 필요)</b></td></tr>
    </table>
    <p style="background:#fff7e6; border-left:3px solid #c97a1a; padding:10px 14px; border-radius:4px;">
      관리자가 재검토 후 다시 처리할 예정입니다.<br/>
      문의는 경영기획실 김은주 차장에게 연락 주세요.
    </p>
    <hr style="border:none; border-top:1px solid #eee; margin:24px 0;"/>
    <p style="font-size:12px; color:#999;">EYEPOP 연차관리 시스템 · 자동 발송 · 회신 불가</p>
  </div>`;
}

function renderEditMail(before, after, applied) {
  const changeRows = Object.keys(applied).map(k => {
    const labelMap = { reason: '사유', leaveType: '종류', status: '상태', rejectReason: '반려 사유' };
    const beforeVal = k === 'status' ? statusLabel(before[k]) : (before[k] || '-');
    const afterVal = k === 'status' ? statusLabel(after[k]) : (after[k] || '-');
    return `<tr>
      <td style="padding:6px 10px; background:#f5f7fa; border:1px solid #e0e6ee;">${labelMap[k] || k}</td>
      <td style="padding:6px 10px; border:1px solid #e0e6ee; color:#999; text-decoration:line-through;">${escapeHtml(String(beforeVal))}</td>
      <td style="padding:6px 10px; border:1px solid #e0e6ee; color:#1a73e8; font-weight:600;">${escapeHtml(String(afterVal))}</td>
    </tr>`;
  }).join('');
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif; line-height:1.7; max-width:640px;">
    <h2 style="border-bottom:2px solid #1a73e8; color:#1a73e8; padding-bottom:8px;">연차 신청이 수정되었습니다</h2>
    <p>${escapeHtml(after.employeeName)}님,</p>
    <p>아래 연차 신청 정보가 관리자에 의해 <b>수정</b>되었습니다.</p>
    <table style="border-collapse:collapse; margin:12px 0; font-size:13px; width:100%;">
      <tr><td style="padding:6px; background:#f5f7fa; width:120px;">기간</td><td style="padding:6px;">${escapeHtml(after.startDate)} ~ ${escapeHtml(after.endDate)} (${after.days}일)</td></tr>
    </table>
    <h3 style="font-size:14px; margin:18px 0 6px;">📝 변경 내역</h3>
    <table style="border-collapse:collapse; font-size:13px; width:100%;">
      <thead><tr>
        <th style="padding:8px; background:#eef3f9; border:1px solid #e0e6ee;">항목</th>
        <th style="padding:8px; background:#eef3f9; border:1px solid #e0e6ee;">변경 전</th>
        <th style="padding:8px; background:#eef3f9; border:1px solid #e0e6ee;">변경 후</th>
      </tr></thead>
      <tbody>${changeRows}</tbody>
    </table>
    <p style="background:#e8f0fb; border-left:3px solid #1a73e8; padding:10px 14px; border-radius:4px; margin-top:16px;">
      변경 사항이 잘못되었거나 이의가 있으시면 즉시 경영기획실 김은주 차장에게 연락 주세요.
    </p>
    <hr style="border:none; border-top:1px solid #eee; margin:24px 0;"/>
    <p style="font-size:12px; color:#999;">EYEPOP 연차관리 시스템 · 자동 발송 · 회신 불가</p>
  </div>`;
}

function statusLabel(s) {
  return ({ pending: '대기', approved: '승인', auto_approved: '자동승인', rejected: '반려' }[s]) || s;
}

// ──────────── 헬퍼 ────────────

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
  return new Response(null, {
    status: 204,
    headers: { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, x-admin-key' }
  });
}
