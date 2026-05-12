// Vercel Edge Function — 수신확인 토큰 처리
export const config = { runtime: 'edge' };

const GIST_API = 'https://api.github.com/gists';

export default async function handler(req) {
  const url = new URL(req.url);
  const token = url.searchParams.get('t');

  if (!token) return htmlPage(400, '잘못된 요청', '토큰이 누락되었습니다.');

  const ghToken = process.env.GIST_TOKEN;
  const gistId = process.env.GIST_ID;
  if (!ghToken || !gistId) return htmlPage(500, '서버 설정 오류', 'Gist 환경변수가 누락되었습니다.');

  let gist;
  try {
    gist = await loadGist(ghToken, gistId);
  } catch (err) {
    return htmlPage(500, 'Gist 로드 실패', err.message);
  }

  const requestsData = gist.requests || { requests: [] };
  const confirmLog = gist['confirm-log'] || { confirmations: [] };

  const idx = requestsData.requests.findIndex(r => r.confirmToken === token);
  if (idx === -1) {
    return htmlPage(404, '링크가 유효하지 않습니다', '이미 폐기되었거나 잘못된 링크입니다.');
  }

  const reqItem = requestsData.requests[idx];
  const now = new Date();

  if (new Date(reqItem.confirmTokenExpiresAt) < now) {
    return htmlPage(410, '링크가 만료되었습니다', '발송일로부터 30일이 지났습니다.<br/>경영기획실 김은주 차장에게 알려주세요.');
  }

  if (reqItem.confirmedAt) {
    return htmlPage(200, '이미 확인 완료',
      `${escapeHtml(reqItem.employeeName)}님, 이 신청은 이미 ${formatKst(reqItem.confirmedAt)} 기준으로 수신 확인되었습니다.`);
  }

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const userAgent = req.headers.get('user-agent') || '';

  reqItem.confirmedAt = now.toISOString();
  reqItem.confirmedIp = ip;

  confirmLog.confirmations = confirmLog.confirmations || [];
  confirmLog.confirmations.push({
    requestId: reqItem.id,
    token,
    confirmedAt: now.toISOString(),
    ip,
    userAgent
  });
  confirmLog.updatedAt = now.toISOString();
  requestsData.updatedAt = now.toISOString();

  try {
    // 한 번의 PATCH로 두 파일 동시 업데이트 (atomic, 409 충돌 회피)
    await saveGistMultiple(ghToken, gistId, {
      'requests.json': requestsData,
      'confirm-log.json': confirmLog
    });
  } catch (err) {
    return htmlPage(500, '저장 실패', err.message);
  }

  return htmlPage(200, '수신 확인 완료',
    `<b>${escapeHtml(reqItem.employeeName)}</b>님, ${formatKst(now.toISOString())} 기준으로 회사에 도달 사실이 기록되었습니다.<br/><br/>
    기간: ${escapeHtml(reqItem.startDate)} ~ ${escapeHtml(reqItem.endDate)} (${reqItem.days}일)<br/><br/>
    감사합니다.`,
    '✅');
}

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

async function saveGistMultiple(token, gistId, filesMap) {
  const files = {};
  for (const [name, content] of Object.entries(filesMap)) {
    files[name] = { content: JSON.stringify(content, null, 2) };
  }
  const resp = await fetch(`${GIST_API}/${gistId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'eyepop-leave-management'
    },
    body: JSON.stringify({ files })
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gist update ${resp.status}: ${text}`);
  }
}

function formatKst(iso) {
  // Vercel 서버 UTC 기준 동작 → KST(UTC+9)로 변환해 표시
  const d = new Date(iso);
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const yy = kst.getUTCFullYear();
  const mm = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(kst.getUTCDate()).padStart(2, '0');
  const hh = String(kst.getUTCHours()).padStart(2, '0');
  const mi = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${yy}-${mm}-${dd} ${hh}:${mi}`;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function htmlPage(status, title, body, icon = '') {
  const ok = status >= 200 && status < 300;
  const accent = ok ? '#27ae60' : status === 410 ? '#e67e22' : '#e74c3c';
  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — EYEPOP 연차관리</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', sans-serif; background: #f5f7fa; margin: 0; padding: 40px 16px; }
    .card { max-width: 480px; margin: 0 auto; background: #fff; padding: 40px 32px; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.06); text-align: center; }
    .icon { font-size: 56px; margin-bottom: 16px; }
    h1 { color: ${accent}; font-size: 22px; margin: 8px 0 16px; }
    p { color: #444; line-height: 1.7; font-size: 15px; }
    .footer { color: #999; font-size: 12px; margin-top: 32px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${body}</p>
    <p class="footer">EYEPOP 연차관리 시스템</p>
  </div>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}
