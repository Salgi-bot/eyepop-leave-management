// HMAC SHA-256 서명 토큰 유틸 (Edge Runtime — Web Crypto API)
// OTP·세션 토큰 발급/검증을 외부 저장소 없이 처리.

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function getKey(secret) {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign', 'verify']
  );
}

export function generateOtp() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1_000_000).padStart(6, '0');
}

export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// payload + secret + 만료(초) → 토큰 문자열
export async function signToken(payload, secret, ttlSec) {
  const fullPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const body = b64url(enc.encode(JSON.stringify(fullPayload)));
  const key = await getKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

// 토큰 검증 → payload 또는 null
export async function verifyToken(token, secret) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const key = await getKey(secret);
  const ok = await crypto.subtle.verify('HMAC', key, b64urlDecode(sig), enc.encode(body));
  if (!ok) return null;
  let payload;
  try {
    payload = JSON.parse(dec.decode(b64urlDecode(body)));
  } catch {
    return null;
  }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
