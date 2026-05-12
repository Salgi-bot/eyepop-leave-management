// Vercel Edge Function — SECOM 출퇴근 대조 결과 메일 자동 발송
// 호출 시점: admin.html 출퇴근 탭에서 엑셀 업로드 → renderAttendance() 직후
// 발송 대상: To = settings.adminEmail (노경희 실장), Cc = settings.senderEmail (김은주 차장, 있을 때만)
// 중복 발송 방지: settings.attendanceReportHistory[].month 매칭 시 409 (force === true면 통과)

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
  const { month, compared, excelBase64, force } = body;

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return json({ error: 'month는 YYYY-MM 형식 필수' }, 400);
  }
  if (!Array.isArray(compared)) {
    return json({ error: 'compared 배열 필수' }, 400);
  }

  let gist;
  try { gist = await loadGist(ghToken, gistId); } catch (err) {
    return json({ error: 'Gist load failed', detail: err.message }, 500);
  }

  const settings = gist.settings || {};
  const adminEmail = settings.adminEmail || 'eunju@eyepopeng.com';
  const senderEmail = settings.senderEmail || '';
  const history = Array.isArray(settings.attendanceReportHistory) ? settings.attendanceReportHistory : [];

  // 중복 발송 체크 (force === false일 때만)
  const prior = history.find(h => h && h.month === month);
  if (prior && !force) {
    return json({
      error: 'already sent',
      sentAt: prior.sentAt,
      anomalyCount: prior.anomalyCount,
      recipient: prior.recipient
    }, 409);
  }

  // 집계
  const counts = compared.reduce((acc, c) => {
    acc[c.level] = (acc[c.level] || 0) + 1;
    return acc;
  }, {});
  const anomalies = compared.filter(c => c.level === 'anomaly');
  const anomalyCount = anomalies.length;

  // 제목
  const [yy, mm] = month.split('-');
  const subjectTail = anomalyCount === 0 ? '(이상 없음)' : `(이상 ${anomalyCount}건)`;
  const subject = `[EYEPOP 연차관리] ${yy}년 ${Number(mm)}월 SECOM 출퇴근 대조 결과 ${subjectTail}`;

  // 본문
  const html = renderReport({ month, compared, counts, anomalies });

  // 첨부 (base64 그대로 전달)
  const attachments = [];
  if (excelBase64 && typeof excelBase64 === 'string') {
    attachments.push({
      filename: `eyepop-출퇴근대조-${month}.xlsx`,
      content: excelBase64
    });
  }

  // Cc 구성
  const ccList = [];
  if (senderEmail && senderEmail.toLowerCase() !== adminEmail.toLowerCase()) {
    ccList.push(senderEmail);
  }

  // 발송
  let mailResult;
  try {
    const sendOpts = {
      to: adminEmail,
      subject,
      html,
      replyTo: senderEmail || adminEmail
    };
    if (ccList.length > 0) sendOpts.cc = ccList;
    if (attachments.length > 0) sendOpts.attachments = attachments;
    mailResult = await sendEmail(sendOpts);
  } catch (err) {
    return json({ error: '메일 발송 실패', detail: err.message }, 502);
  }

  // 이력 기록
  const newHistory = history.slice();
  newHistory.push({
    month,
    sentAt: mailResult.sentAt,
    anomalyCount,
    recipient: adminEmail,
    cc: ccList,
    messageId: mailResult.messageId,
    forced: !!force
  });
  // 최근 24개월만 보관 (이력 비대 방지)
  const trimmed = newHistory.slice(-24);

  const newSettings = { ...settings, attendanceReportHistory: trimmed };

  try {
    await saveGist(ghToken, gistId, 'settings.json', newSettings);
  } catch (err) {
    // 메일은 이미 발송됐으므로 200 반환하되 detail 포함
    return json({
      status: 'sent_but_history_save_failed',
      sentAt: mailResult.sentAt,
      anomalyCount,
      historyError: err.message
    }, 200);
  }

  return json({
    status: 'ok',
    month,
    sentAt: mailResult.sentAt,
    anomalyCount,
    recipient: adminEmail,
    cc: ccList
  });
}

// ──────────── 메일 본문 ────────────

function renderReport({ month, compared, counts, anomalies }) {
  const [yy, mm] = month.split('-');
  const monthLabel = `${yy}년 ${Number(mm)}월`;
  const lastDay = new Date(Number(yy), Number(mm), 0).getDate();
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const checkAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

  const anomalyRows = anomalies.map(c => `
    <tr style="background:#fef2f2;">
      <td style="padding:6px 10px; border:1px solid #e0e6ee;">${escapeHtml(c.date)}</td>
      <td style="padding:6px 10px; border:1px solid #e0e6ee;">${escapeHtml(c.name)}</td>
      <td style="padding:6px 10px; border:1px solid #e0e6ee;">${escapeHtml(c.dept || '-')}</td>
      <td style="padding:6px 10px; border:1px solid #e0e6ee;">${escapeHtml((c.startTime || '').slice(11) || '-')}</td>
      <td style="padding:6px 10px; border:1px solid #e0e6ee;">${escapeHtml((c.endTime || '').slice(11) || '-')}</td>
      <td style="padding:6px 10px; border:1px solid #e0e6ee;">${escapeHtml(c.actualWorkDisplay || c.actualWork || '-')}</td>
      <td style="padding:6px 10px; border:1px solid #e0e6ee;">${escapeHtml(c.reqType || '-')}</td>
      <td style="padding:6px 10px; border:1px solid #e0e6ee; color:#b93a3a; font-weight:600;">${escapeHtml(c.verdict || '-')}</td>
    </tr>
  `).join('');

  const anomalySection = anomalies.length === 0 ? `
    <h3 style="font-size:14px; margin:18px 0 6px;">✅ 이상치 상세</h3>
    <p style="background:#eaf6ef; border-left:3px solid #2e7d4f; padding:10px 14px; border-radius:4px;">
      이상치가 없습니다. 추가 확인이 필요한 항목 없음.
    </p>
  ` : `
    <h3 style="font-size:14px; margin:18px 0 6px;">🔴 이상치 상세 (${anomalies.length}건)</h3>
    <table style="border-collapse:collapse; font-size:13px; width:100%;">
      <thead><tr>
        <th style="padding:8px; background:#fbe9e9; border:1px solid #e0e6ee;">날짜</th>
        <th style="padding:8px; background:#fbe9e9; border:1px solid #e0e6ee;">이름</th>
        <th style="padding:8px; background:#fbe9e9; border:1px solid #e0e6ee;">부서</th>
        <th style="padding:8px; background:#fbe9e9; border:1px solid #e0e6ee;">출근</th>
        <th style="padding:8px; background:#fbe9e9; border:1px solid #e0e6ee;">퇴근</th>
        <th style="padding:8px; background:#fbe9e9; border:1px solid #e0e6ee;">실근무</th>
        <th style="padding:8px; background:#fbe9e9; border:1px solid #e0e6ee;">연차신청</th>
        <th style="padding:8px; background:#fbe9e9; border:1px solid #e0e6ee;">판정</th>
      </tr></thead>
      <tbody>${anomalyRows}</tbody>
    </table>
  `;

  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif; line-height:1.7; max-width:760px;">
    <h2 style="border-bottom:2px solid #1a73e8; color:#1a73e8; padding-bottom:8px;">SECOM 출퇴근 대조 결과</h2>
    <ul style="padding-left:18px; margin:8px 0 16px;">
      <li>대조 기간: ${monthLabel} 1일 ~ ${Number(mm)}월 ${lastDay}일</li>
      <li>대조 시각: ${checkAt}</li>
      <li>업로드 담당: 김은주 차장</li>
    </ul>

    <h3 style="font-size:14px; margin:18px 0 6px;">📊 종합 요약</h3>
    <table style="border-collapse:collapse; font-size:13px;">
      <thead><tr>
        <th style="padding:8px 14px; background:#eef3f9; border:1px solid #e0e6ee;">구분</th>
        <th style="padding:8px 14px; background:#eef3f9; border:1px solid #e0e6ee;">건수</th>
      </tr></thead>
      <tbody>
        <tr><td style="padding:6px 14px; border:1px solid #e0e6ee;">전체</td><td style="padding:6px 14px; border:1px solid #e0e6ee; text-align:right; font-weight:600;">${compared.length}건</td></tr>
        <tr><td style="padding:6px 14px; border:1px solid #e0e6ee; color:#2e7d4f;">정상</td><td style="padding:6px 14px; border:1px solid #e0e6ee; text-align:right;">${counts.ok || 0}건</td></tr>
        <tr><td style="padding:6px 14px; border:1px solid #e0e6ee; color:#1a73e8;">늦은 퇴근</td><td style="padding:6px 14px; border:1px solid #e0e6ee; text-align:right;">${counts.late || 0}건</td></tr>
        <tr><td style="padding:6px 14px; border:1px solid #e0e6ee; color:#c97a1a;">대기</td><td style="padding:6px 14px; border:1px solid #e0e6ee; text-align:right;">${counts.warn || 0}건</td></tr>
        <tr><td style="padding:6px 14px; border:1px solid #e0e6ee; color:#b93a3a; font-weight:600;">이상</td><td style="padding:6px 14px; border:1px solid #e0e6ee; text-align:right; font-weight:600;">${counts.anomaly || 0}건</td></tr>
      </tbody>
    </table>

    ${anomalySection}

    <h3 style="font-size:14px; margin:18px 0 6px;">📎 첨부 파일</h3>
    <p>eyepop-출퇴근대조-${month}.xlsx (대조 결과 전체)</p>

    <h3 style="font-size:14px; margin:18px 0 6px;">✅ 처리 안내</h3>
    <ol style="padding-left:20px;">
      <li>김은주 차장: 해당 직원에게 사유 확인</li>
      <li>노경희 실장: 결재 후 대표이사 구두 보고</li>
      <li>수정 사항 발생 시: 김홍정 부사장 슬랙으로 결재서 전달 → Claude 시스템 자동 수정</li>
    </ol>

    <hr style="border:none; border-top:1px solid #eee; margin:24px 0;"/>
    <p style="font-size:12px; color:#999;">
      본 메일은 EYEPOP 연차관리시스템에서 SECOM 엑셀 업로드 완료 시점에 자동 발송된 메일입니다.
    </p>
  </div>`;
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
