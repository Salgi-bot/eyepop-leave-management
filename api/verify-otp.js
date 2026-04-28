// OTP 검증 → 세션 토큰 발급 + 본인 신청 목록 반환
export const config = { runtime: 'edge' };

import { sha256Hex, signToken, verifyToken } from '../lib/otp-token.js';

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

  const otpToken = body?.token;
  const otp = (body?.otp || '').trim();
  if (!otpToken || !otp) return json({ error: 'token, otp 필수' }, 400);
  if (!/^\d{6}$/.test(otp)) return json({ error: 'OTP는 6자리 숫자입니다.' }, 400);

  const payload = await verifyToken(otpToken, otpSecret);
  if (!payload) return json({ error: 'OTP가 만료되었거나 유효하지 않습니다. 다시 요청해주세요.' }, 401);
  if (payload.scope !== 'otp') return json({ error: '잘못된 토큰 종류' }, 401);

  const submittedHash = await sha256Hex(otp);
  if (submittedHash !== payload.otpHash) return json({ error: 'OTP가 일치하지 않습니다.' }, 401);

  // 본인 신청 목록 조회
  let gist;
  try { gist = await loadGist(ghToken, gistId); }
  catch (err) { return json({ error: 'Gist load failed', detail: err.message }, 500); }

  const requests = gist.requests?.requests || [];
  const myRequests = requests
    .filter(r => r.employeeEmail?.toLowerCase() === payload.email)
    .map(r => ({
      id: r.id,
      startDate: r.startDate,
      endDate: r.endDate,
      days: r.days,
      leaveType: r.leaveType,
      reason: r.reason,
      status: r.status,
      submittedAt: r.submittedAt,
      approvedAt: r.approvedAt,
      cancelledAt: r.cancelledAt || null
    }))
    .sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || ''));

  // 세션 토큰 (10분 유효, 철회 API용)
  const sessionToken = await signToken(
    { email: payload.email, name: payload.name, scope: 'my-requests' },
    otpSecret, 600
  );

  return json({
    ok: true,
    sessionToken,
    expiresInSec: 600,
    employeeName: payload.name,
    requests: myRequests
  });
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
