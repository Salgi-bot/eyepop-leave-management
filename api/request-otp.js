// 직원 본인 인증용 OTP 발송 (이메일)
// 흐름: name+email 검증 → 6자리 OTP 발송 → HMAC 서명 토큰 반환
export const config = { runtime: 'edge' };

import { sendEmail, escapeHtml } from '../lib/email.js';
import { generateOtp, sha256Hex, signToken } from '../lib/otp-token.js';

const GIST_API = 'https://api.github.com/gists';

export default async function handler(req) {
  if (req.method === 'OPTIONS') return cors();
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const ghToken = process.env.GIST_TOKEN;
  const gistId = process.env.GIST_ID;
  const otpSecret = process.env.OTP_SECRET;
  if (!ghToken || !gistId) return json({ error: 'Server not configured (Gist)' }, 500);
  if (!otpSecret) return json({ error: 'Server not configured (OTP_SECRET 미설정)' }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const name = (body?.name || '').trim();
  const email = (body?.email || '').trim().toLowerCase();
  if (!name || !email) return json({ error: '이름과 이메일을 입력하세요.' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: '이메일 형식이 올바르지 않습니다.' }, 400);

  let gist;
  try { gist = await loadGist(ghToken, gistId); }
  catch (err) { return json({ error: 'Gist load failed', detail: err.message }, 500); }

  const employees = gist.employees?.employees || [];
  const employee = employees.find(e => e.email?.toLowerCase() === email);
  if (!employee) return json({ error: '등록되지 않은 직원입니다.' }, 403);
  if (employee.name && employee.name !== name) return json({ error: '이름과 이메일이 일치하지 않습니다.' }, 403);

  const otp = generateOtp();
  const otpHash = await sha256Hex(otp);
  // 5분 유효 토큰 (OTP 자체는 응답에 포함 X — 이메일로만 전달)
  const token = await signToken(
    { email, name: employee.name, otpHash, scope: 'otp', issuedAt: Date.now() },
    otpSecret, 300
  );

  try {
    await sendEmail({
      to: email,
      subject: `[EYEPOP 연차관리] 본인 확인 코드: ${otp}`,
      html: renderOtpMail(employee.name, otp)
    });
  } catch (err) {
    return json({ error: 'OTP 메일 발송 실패', detail: err.message }, 502);
  }

  return json({ ok: true, token, expiresInSec: 300 });
}

function renderOtpMail(name, otp) {
  return `<!DOCTYPE html>
<html><body style="font-family:'Apple SD Gothic Neo',sans-serif; max-width:480px; margin:auto; padding:24px; color:#333;">
  <h2 style="color:#1a4275; margin-top:0;">본인 확인 코드</h2>
  <p>${escapeHtml(name)}님, 연차 신청 조회·철회를 위한 본인 확인 코드입니다.</p>
  <div style="background:#f0f4f9; border-radius:8px; padding:18px; text-align:center; margin:18px 0;">
    <div style="font-size:32px; font-weight:700; letter-spacing:6px; color:#1a4275; font-family:monospace;">${otp}</div>
  </div>
  <p style="font-size:13px; color:#666;">
    · 유효 시간: <b>5분</b><br/>
    · 본인이 요청하지 않았다면 이 메일을 무시하세요.<br/>
    · 코드는 절대 타인에게 공유하지 마세요.
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
