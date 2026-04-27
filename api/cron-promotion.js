// Vercel Cron — 연차 사용 촉진 알림 (근로기준법 제61조)
// 매일 한국 오전 9시 호출 → 1차(7/1~7/10) / 2차(10/20~10/31) 시기 도래 시 김은주 차장에게 자동 메일
// 설정값(시기·발송 이력)은 settings.json에 기록 → 같은 시기 중복 발송 방지
//
// 강제 트리거: ?force=first 또는 ?force=second 쿼리 (테스트용, ADMIN_KEY 필요)

export const config = { runtime: 'edge' };

import { sendEmail, escapeHtml } from '../lib/email.js';

const GIST_API = 'https://api.github.com/gists';
const SITE_ORIGIN = 'https://eyepop-leave-management.vercel.app';

export default async function handler(req) {
  const url = new URL(req.url);
  const force = url.searchParams.get('force'); // 'first' | 'second' | null

  // Vercel Cron 트리거는 인증 헤더 없이 호출됨. 강제 트리거(force)는 ADMIN_KEY 필요.
  if (force) {
    const adminKey = process.env.ADMIN_KEY;
    if (req.headers.get('x-admin-key') !== adminKey) {
      return json({ error: 'Force trigger requires ADMIN_KEY' }, 401);
    }
  }

  const token = process.env.GIST_TOKEN;
  const gistId = process.env.GIST_ID;
  if (!token || !gistId) return json({ error: 'Server not configured' }, 500);

  let gist;
  try { gist = await loadGist(token, gistId); } catch (err) {
    return json({ error: 'Gist load failed', detail: err.message }, 500);
  }

  const settings = gist.settings || {};
  const adminEmail = settings.adminEmail || 'eunju@eyepopeng.com';

  // 한국 시간 기준 (UTC+9)
  const nowKst = kstNow();
  const year = nowKst.getFullYear();

  // 시기 결정
  let phase = null;
  if (force === 'first' || force === 'second') {
    phase = force;
  } else {
    if (isFirstPromotionPeriod(nowKst)) phase = 'first';
    else if (isSecondPromotionPeriod(nowKst)) phase = 'second';
  }

  if (!phase) {
    return json({ status: 'skip', reason: 'not in promotion period', date: kstDateString(nowKst) });
  }

  // 이미 올해 같은 단계 발송했는지 확인
  const sentKey = phase === 'first' ? `promotion1stSentAt_${year}` : `promotion2ndSentAt_${year}`;
  if (settings[sentKey] && !force) {
    return json({ status: 'skip', reason: 'already sent', sentAt: settings[sentKey] });
  }

  // 미사용 연차 계산
  const employees = gist.employees?.employees || [];
  const requests = gist.requests?.requests || [];
  const summary = computeUnusedSummary(employees, requests, year);

  // 김은주 차장에게 자동 메일
  try {
    const phaseLabel = phase === 'first' ? '1차' : '2차';
    const subject = `[관리자] 연차 사용 촉진 ${phaseLabel} 통지 시기 도래 (${kstDateString(nowKst)})`;
    const html = renderAdminPromotionMail({ phase, year, summary, settings });
    await sendEmail({ to: adminEmail, subject, html });
  } catch (err) {
    return json({ error: '관리자 알림 메일 발송 실패', detail: err.message }, 502);
  }

  // settings에 발송 이력 저장
  settings[sentKey] = nowKst.toISOString();
  settings.updatedAt = nowKst.toISOString();
  try {
    await saveGist(token, gistId, 'settings.json', settings);
  } catch (err) {
    // 메일은 발송됐으나 저장 실패 — 다음 호출 시 중복 발송 가능. 로그만 남김.
    return json({ status: 'sent_but_save_failed', detail: err.message }, 200);
  }

  return json({
    status: 'sent',
    phase,
    year,
    sentTo: adminEmail,
    targetCount: summary.targetCount,
    totalUnused: summary.totalUnused
  });
}

// ──────────── 시기 판정 (한국 시간 기준) ────────────

function kstNow() {
  const utc = new Date();
  return new Date(utc.getTime() + 9 * 3600 * 1000);
}

function kstDateString(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// 1차 촉진 기간: 7/1 ~ 7/10
function isFirstPromotionPeriod(kst) {
  const m = kst.getUTCMonth() + 1; // KST 기준 월
  const d = kst.getUTCDate();
  return m === 7 && d >= 1 && d <= 10;
}

// 2차 통지 기간: 10/20 ~ 10/31
function isSecondPromotionPeriod(kst) {
  const m = kst.getUTCMonth() + 1;
  const d = kst.getUTCDate();
  return m === 10 && d >= 20 && d <= 31;
}

// ──────────── 미사용 연차 집계 ────────────

function computeUnusedSummary(employees, requests, year) {
  // 회계년도 기준 단순 계산
  const items = employees.map(e => {
    const total = calcLegalLeaveFiscalLite(e.hireDate, e.customLeaveDays, year);
    const used = requests
      .filter(r => r.employeeId === e.id &&
        (r.status === 'approved' || r.status === 'auto_approved') &&
        new Date(r.startDate).getFullYear() === year)
      .reduce((s, r) => s + (Number(r.days) || 0), 0);
    return { name: e.name, email: e.email, department: e.department, total, used, remaining: Math.max(0, total - used) };
  });
  // 미사용 5일 이상 직원 = 촉진 대상 (예시 기준)
  const targets = items.filter(x => x.remaining >= 5).sort((a, b) => b.remaining - a.remaining);
  const totalUnused = items.reduce((s, x) => s + x.remaining, 0);
  return { targets, targetCount: targets.length, totalEmployees: employees.length, totalUnused };
}

function calcLegalLeaveFiscalLite(hireDate, customLeaveDays, fiscalYear) {
  if (customLeaveDays != null) return Number(customLeaveDays) || 0;
  if (!hireDate) return 0;
  const hire = new Date(hireDate);
  if (isNaN(hire.getTime())) return 0;
  const hy = hire.getFullYear();
  if (fiscalYear === hy) {
    // 입사 첫 해 — 연말 기준 비례 (간이 계산)
    const monthsThisYear = 12 - hire.getMonth();
    return Math.min(monthsThisYear, 11);
  }
  const ys = fiscalYear - hy;
  let base = 15;
  if (ys >= 3) base += Math.floor((ys - 1) / 2);
  return Math.min(base, 25);
}

// ──────────── 메일 템플릿 ────────────

function renderAdminPromotionMail({ phase, year, summary, settings }) {
  const phaseLabel = phase === 'first' ? '1차' : '2차';
  const deadline = phase === 'first' ? `${year}-07-10까지` : `${year}-10-31까지`;
  const targetRows = summary.targets.slice(0, 20).map(t => `
    <tr>
      <td style="padding:6px 8px; border-bottom:1px solid #eee;">${escapeHtml(t.name)}</td>
      <td style="padding:6px 8px; border-bottom:1px solid #eee;">${escapeHtml(t.department || '-')}</td>
      <td style="padding:6px 8px; border-bottom:1px solid #eee; text-align:right;">${t.total}일</td>
      <td style="padding:6px 8px; border-bottom:1px solid #eee; text-align:right; color:#c97a1a; font-weight:600;">${t.remaining}일</td>
    </tr>`).join('');
  const moreCount = Math.max(0, summary.targetCount - 20);

  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif; line-height:1.7; max-width:680px;">
    <h2 style="border-bottom:2px solid #4a90e2; padding-bottom:8px;">${year}년 연차 사용 촉진 ${phaseLabel} 통지 시기 도래</h2>
    <p>김은주 차장님, 안녕하세요.</p>
    <p>오늘은 <b>${year}년 ${phaseLabel} 연차 사용 촉진</b> 시기가 시작되는 날입니다.<br/>
       근로기준법 제61조에 따라 <b>${deadline}</b> 통지 절차가 완료되어야 합니다.</p>

    <div style="background:#f5f7fa; padding:12px 16px; border-radius:8px; margin:18px 0;">
      <b>📊 미사용 연차 현황</b><br/>
      • 등록 직원: ${summary.totalEmployees}명<br/>
      • 촉진 대상(잔여 5일 이상): <b style="color:#c97a1a;">${summary.targetCount}명</b><br/>
      • 전사 미사용 합계: ${summary.totalUnused}일
    </div>

    <h3 style="font-size:14px; margin:18px 0 6px;">촉진 대상 직원 (상위 ${Math.min(20, summary.targetCount)}명)</h3>
    <table style="border-collapse:collapse; width:100%; font-size:13px;">
      <thead><tr style="background:#f5f7fa;">
        <th style="padding:6px 8px; text-align:left;">이름</th>
        <th style="padding:6px 8px; text-align:left;">부서</th>
        <th style="padding:6px 8px; text-align:right;">총연차</th>
        <th style="padding:6px 8px; text-align:right;">잔여</th>
      </tr></thead>
      <tbody>${targetRows || '<tr><td colspan="4" style="padding:8px; color:#9aa5b4; text-align:center;">대상 직원 없음</td></tr>'}</tbody>
    </table>
    ${moreCount > 0 ? `<p style="color:#666; font-size:12px; margin-top:6px;">외 ${moreCount}명 추가 — 관리자 대시보드에서 전체 확인</p>` : ''}

    <h3 style="font-size:14px; margin:24px 0 6px;">필요 조치</h3>
    <ol style="padding-left:20px; line-height:1.9;">
      <li>SECOM 출퇴근 파일 대조 (계획 vs 실제)</li>
      <li>대상 직원에게 촉진 안내 메일 발송</li>
      <li>회신 결과 정리 및 보관 (3년 보존)</li>
    </ol>

    <p style="margin:18px 0;">
      <a href="${SITE_ORIGIN}/admin.html" style="display:inline-block; padding:10px 20px; background:#4a90e2; color:#fff; text-decoration:none; border-radius:6px; font-weight:bold;">관리자 대시보드 열기</a>
    </p>

    <hr style="border:none; border-top:1px solid #eee; margin:24px 0;"/>
    <p style="font-size:12px; color:#999;">EYEPOP 연차관리 시스템 · 자동 발송 · ${phaseLabel} 통지 ${year} · 회신 불가</p>
  </div>`;
}

// ──────────── Gist 헬퍼 ────────────

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
    headers: { 'Content-Type': 'application/json' }
  });
}
