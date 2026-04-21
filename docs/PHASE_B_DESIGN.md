# Phase B 설계 문서

**작성일**: 2026-04-21
**적용 범위**: 연차관리 앱 Phase B (이메일 발송·수신확인·승인 흐름·잔여연차)
**선행 조건**: Phase A 완료 (GitHub 레포·Netlify Functions·Gist 구조)
**착수 시점**: 2026-04-23 이후 (Netlify 크레딧 리셋 + Resend 인증 완료 후)

---

## 1. 개요

Phase A에서 구축한 스캐폴드 위에 **연차 신청·승인 본연의 업무 흐름**을 구현한다.
Phase B 범위:

- 연차 신청 폼 (직원용)
- 이메일 자동 발송 (Resend 연동)
- 수신확인 토큰 시스템
- 잔여연차 자동 계산
- 승인 처리 (자동·수동 토글)
- 관리자 대시보드 신청내역 탭

Phase C~E는 별도 계획 (승인 이메일 템플릿·오프라인 팝업·하네스 연동).

---

## 2. 아키텍처

```
┌─────────────┐          ┌─────────────────────┐
│ 직원 브라우저│ ──신청──▶│ Netlify Static Host │
└─────────────┘          │ (HTML/JS)           │
       ▲                 └──────────┬──────────┘
       │ 수신확인 클릭              │ fetch
       │                            ▼
┌──────┴──────┐          ┌─────────────────────┐
│ Hanmail     │◀──발송───│ Netlify Functions   │
│ (직원 메일)  │          │ - email-send        │
└─────────────┘          │ - gist-proxy        │
                         │ - confirm-token     │
                         │ - calc-leave        │
                         └──────────┬──────────┘
                                    │
                         ┌──────────▼──────────┐
                         │ Resend API (미국)    │─→ Hanmail(국내)
                         └──────────────────────┘
                         ┌──────────────────────┐
                         │ GitHub Gist (Secret) │
                         │ - employees.json     │
                         │ - requests.json      │
                         │ - settings.json      │
                         │ - confirm-log.json   │
                         └──────────────────────┘
```

---

## 3. 데이터 모델

### 3.1 `requests.json` (신청 내역)

```json
{
  "requests": [
    {
      "id": "req-20260505-001",
      "employeeId": "e001",
      "employeeName": "홍길동",
      "employeeEmail": "gildong@hanmail.net",
      "department": "설계사업본부/1팀",
      "teamLeaderEmail": "leader1@eyepopeng.com",
      "isExecutive": false,
      "leaveType": "연차",
      "startDate": "2026-05-20",
      "endDate": "2026-05-22",
      "days": 3,
      "reason": "개인 사유",
      "verbalReportConfirmed": true,
      "submittedAt": "2026-05-05T09:30:00+09:00",
      "status": "pending",
      "approvalMode": "manual",
      "approvedAt": null,
      "approvedBy": null,
      "rejectedAt": null,
      "confirmToken": "a1b2c3d4e5f6...",
      "confirmTokenExpiresAt": "2026-06-05T09:30:00+09:00",
      "confirmedAt": null,
      "confirmedIp": null,
      "emailsSent": [
        {"to": "eunju@eyepopeng.com", "role": "admin", "sentAt": "2026-05-05T09:30:05+09:00"},
        {"to": "leader1@eyepopeng.com", "role": "cc", "sentAt": "2026-05-05T09:30:05+09:00"},
        {"to": "gildong@hanmail.net", "role": "confirm", "sentAt": "2026-05-05T09:30:05+09:00"}
      ]
    }
  ],
  "updatedAt": "2026-05-05T09:30:00+09:00"
}
```

### 3.2 `confirm-log.json` (수신확인 로그)

```json
{
  "confirmations": [
    {
      "requestId": "req-20260505-001",
      "token": "a1b2c3d4...",
      "confirmedAt": "2026-05-05T10:15:22+09:00",
      "ip": "203.241.X.X",
      "userAgent": "Mozilla/5.0 (iPhone...)"
    }
  ]
}
```

### 3.3 `settings.json` 확장

Phase A 기본 + Phase B에서 추가:
```json
{
  "objectionPeriodDays": 3,
  "approvalMode": "manual",
  "leaveCalcMode": "legal",
  "emailSender": "noreply@eyepopeng.com",
  "adminEmail": "eunju@eyepopeng.com",
  "vicePresidentEmail": "gunbon21@gmail.com",
  "confirmTokenValidityDays": 30,
  "legalLeaveTable": {
    "under1Year": "month",
    "year1to3": 15,
    "perYearAfter": 1,
    "max": 25
  }
}
```

---

## 4. 이메일 발송 흐름

### 4.1 신청 시 분기 규칙

| 신청자 구분 | TO | CC | 본문 차이 |
|---|---|---|---|
| 일반 팀원 (isExecutive=false) | `adminEmail` (김은주) | `teamLeaderEmail` (팀장) | "팀장 구두 보고 확인" 표기 |
| 팀장/임원 (isExecutive=true) | `adminEmail` (김은주) | (없음) | "임원 신청" 표기 |
| 부사장 본인 (email=`vicePresidentEmail`) | `vicePresidentEmail` (본인) | (없음) | "부사장 자기 신청" |

### 4.2 승인 이메일 (수신확인 토큰 포함)

수신: 신청자 본인
제목: `[연차 승인] {startDate}~{endDate} 승인 알림`
본문:
```
안녕하세요, {이름} 님.

2026년 5월 20일~22일 연차 신청이 승인되었습니다.
잔여 연차: {remaining}일

아래 '수신 확인' 버튼을 1회 클릭해 주세요.
(유효기간: 1개월. 클릭 시 회사에 도달 사실이 기록됩니다)

[수신 확인하기]
→ https://eyepop-leave-management.netlify.app/confirm?t=a1b2c3...

※ 확인 버튼 클릭이 어려운 경우 경영기획실 김은주 차장에게 알려주세요.

연차관리 시스템
```

### 4.3 Resend 호출 (Netlify Functions: `email-send.js`)

```js
// Pseudo-code
exports.handler = async (event) => {
  const { to, cc, subject, html, role } = JSON.parse(event.body);
  const RESEND_KEY = process.env.RESEND_API_KEY;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: "연차관리 <noreply@eyepopeng.com>",
      to: [to],
      cc: cc ? [cc] : undefined,
      subject,
      html
    })
  });

  const data = await response.json();
  return {
    statusCode: 200,
    body: JSON.stringify({ messageId: data.id, sentAt: new Date().toISOString() })
  };
};
```

---

## 5. 수신확인 토큰 시스템

### 5.1 토큰 생성 (신청 시)

```js
const crypto = require("crypto");
const token = crypto.randomBytes(32).toString("hex"); // 64자
const expiresAt = Date.now() + 30 * 86400 * 1000; // 30일
```

토큰은 `requests.json`에 `confirmToken`·`confirmTokenExpiresAt`로 저장.

### 5.2 URL 구조

```
/confirm?t={token}
```

### 5.3 확인 처리 (Netlify Functions: `confirm-token.js`)

```js
exports.handler = async (event) => {
  const token = event.queryStringParameters.t;
  
  // 1. requests.json에서 token 일치 항목 검색
  const requests = await loadGist("requests.json");
  const req = requests.find(r => r.confirmToken === token);
  
  if (!req) return { statusCode: 404, body: "링크가 유효하지 않습니다." };
  if (Date.now() > new Date(req.confirmTokenExpiresAt).getTime())
    return { statusCode: 410, body: "링크가 만료되었습니다." };
  if (req.confirmedAt)
    return { statusCode: 200, body: "이미 확인 처리되었습니다." };
  
  // 2. IP·시간 기록
  const ip = event.headers["x-nf-client-connection-ip"] || "unknown";
  const now = new Date().toISOString();
  req.confirmedAt = now;
  req.confirmedIp = ip;
  
  // 3. confirm-log.json에도 append
  const log = await loadGist("confirm-log.json");
  log.confirmations.push({
    requestId: req.id, token, confirmedAt: now, ip,
    userAgent: event.headers["user-agent"]
  });
  
  // 4. Gist 업데이트
  await saveGist("requests.json", requests);
  await saveGist("confirm-log.json", log);
  
  // 5. 확인 완료 페이지 반환
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: `<html><body>
      <h2>✅ 수신 확인 완료</h2>
      <p>${req.employeeName}님, ${now} 기준으로 확인 처리되었습니다.</p>
    </body></html>`
  };
};
```

---

## 6. 잔여 연차 계산

### 6.1 `calc-leave.js` (Netlify Functions)

```js
function calcLegalLeave(hireDate) {
  const now = new Date();
  const hire = new Date(hireDate);
  const diffMonths = (now.getFullYear() - hire.getFullYear()) * 12 
                   + (now.getMonth() - hire.getMonth());
  const years = Math.floor(diffMonths / 12);
  
  if (years < 1) {
    // 1년 미만: 월 1일 (최대 11일)
    return Math.min(diffMonths, 11);
  }
  // 1년 이상: 15일 + (3년 이상부터 2년마다 +1일, 최대 25일)
  let base = 15;
  if (years >= 3) base += Math.floor((years - 1) / 2);
  return Math.min(base, 25);
}

function calcRemaining(employee, requests) {
  const settings = loadSettings();
  const total = settings.leaveCalcMode === "legal"
    ? calcLegalLeave(employee.hireDate)
    : employee.customLeaveDays;
  
  // 현재 연도 승인된 신청 합산
  const year = new Date().getFullYear();
  const used = requests
    .filter(r => r.employeeId === employee.id 
              && r.status === "approved"
              && new Date(r.startDate).getFullYear() === year)
    .reduce((sum, r) => sum + r.days, 0);
  
  return total - used;
}
```

### 6.2 반차·반반차 처리

반차: `days: 0.5`
반반차: `days: 0.25`
엑셀 입력 시 소수점 허용.

---

## 7. 승인 처리

### 7.1 모드별 흐름

**자동 모드 (`approvalMode: "auto"`)**:
1. 신청 즉시 `status: "approved"` 설정
2. 승인 이메일 발송 (잔여 연차 포함)
3. 관리자·팀장 CC 이메일은 "승인됨" 표시

**수동 모드 (`approvalMode: "manual"`)**:
1. 신청 즉시 `status: "pending"`
2. 관리자·팀장에게 "승인 대기" 이메일
3. 관리자 대시보드 신청내역 탭에서 **승인** 버튼 클릭 시 승인 이메일 발송
4. **반려** 버튼 시 `status: "rejected"` + 사유 입력

### 7.2 관리자 대시보드 신청내역 UI

```
┌───────────────────────────────────────────────┐
│ 🔍 필터: [전체▼] [대기▼] [승인▼] [반려▼]      │
├───────────────────────────────────────────────┤
│ 홍길동  2026-05-20~22  3일  [대기] [승인][반려]│
│ 김철수  2026-05-15     1일  [승인] [재발송][취소]│
│ 이영희  2026-05-10~12  3일  [승인] [확인됨✓]  │
└───────────────────────────────────────────────┘
```

---

## 8. API 엔드포인트 명세

| 함수 | Method | URL | 기능 |
|---|---|---|---|
| submit-request | POST | `/.netlify/functions/submit-request` | 신청 접수 + 이메일 발송 |
| approve-request | POST | `/.netlify/functions/approve-request` | 수동 승인 처리 |
| reject-request | POST | `/.netlify/functions/reject-request` | 반려 처리 |
| resend-email | POST | `/.netlify/functions/resend-email` | 수동 재발송 |
| confirm-token | GET | `/.netlify/functions/confirm-token?t=` | 수신 확인 링크 처리 |
| calc-leave | POST | `/.netlify/functions/calc-leave` | 잔여 연차 계산 |
| gist-proxy | POST | `/.netlify/functions/gist-proxy` | Gist Read/Write (Phase A 완료) |

### 8.1 인증

모든 관리자 API는 `x-admin-key: <ADMIN_KEY>` 헤더 필수.
직원 제출 API (submit-request, confirm-token)는 무인증 (rate limit 적용).

---

## 9. Rate Limit 및 보안

- Netlify Functions 기본 Rate Limit: 분당 100회 (무료 플랜)
- submit-request: IP당 분당 5회 제한
- confirm-token: 동일 토큰 3회 이상 재시도 시 차단
- CORS: `https://eyepop-leave-management.netlify.app` 동일 도메인만

---

## 10. 테스트 케이스

### 10.1 단위 테스트

| # | 케이스 | 기대 결과 |
|---|---|---|
| 1 | 1년 미만 신입 (입사 6개월) | 잔여 연차 = 6일 |
| 2 | 3년차 (입사일 2023-03-15) | 15일 - 사용분 |
| 3 | 10년차 | 20일 - 사용분 |
| 4 | 반차 신청 | 0.5일 차감 |
| 5 | 임원 신청 | 팀장 CC 없이 김은주만 수신 |
| 6 | 부사장 신청 | gunbon21@gmail.com만 수신 |
| 7 | 수동 모드 + 승인 버튼 | 승인 메일 발송·로그 기록 |
| 8 | 수신확인 링크 30일 지나 클릭 | 410 만료 응답 |
| 9 | 동일 토큰 재클릭 | "이미 확인됨" 메시지 |
| 10 | 3일 내 팀장 이의 제기 (관리자에 별도 이메일) | 관리자 대시보드에 '이의 제기 중' 표시 |

### 10.2 통합 테스트 (수동)

- 신청 → 이메일 수신 → 수신확인 클릭 → 관리자 대시보드 '확인됨' 표시 전체 흐름
- 엑셀 업로드 → 직원 목록 반영 → 신청 가능 여부 확인
- 관리자 설정 변경 (이의 기간·승인모드·산정모드) 즉시 반영 확인

---

## 11. 개인정보 보호 구현 체크리스트

- [ ] `reason` 필드에 건강·의료 관련 단어 탐지 시 경고 팝업
- [ ] 민감정보 탐지 시 AES-256으로 암호화 저장
- [ ] 관리자 대시보드 조회 시 접근 로그 기록 (`access-log.json`)
- [ ] 퇴사 처리 시 해당 직원 데이터 3년 후 자동 파기 스케줄
- [ ] 처리방침 페이지·동의서 페이지 신규 추가 (별도 HTML)

---

## 12. 구현 순서 (Phase B 착수 시)

1. **Netlify Functions 추가** (submit-request, approve-request, confirm-token, calc-leave)
2. **신청 폼 UI** (`index.html` 또는 `apply.html`)
3. **신청 제출 로직** (submit-request 호출 + 이메일 3건 발송)
4. **수신확인 페이지** (`/confirm?t=...` → Function)
5. **관리자 신청내역 탭** (기존 `admin.html`에 추가)
6. **승인·반려·재발송 버튼 로직**
7. **잔여 연차 계산 통합**
8. **사유 민감정보 감지·암호화**
9. **테스트 10개 케이스 수동 검증**
10. **배포 + 김은주 차장에게 테스트 부탁**

예상 소요: 약 6~8시간 (집중 작업 기준)

---

## 13. Phase C~E 예고

| Phase | 범위 |
|---|---|
| C | 승인 이메일 HTML 템플릿 고도화·반응형 |
| D | 오프라인 업무 안내 팝업 (출력·서명·공지 가이드) |
| E | 하네스 연동 (Telegram 알림·Notion 자동 기록·health_check.sh 추가) |

---

## 14. 위험·이슈 대응

| 리스크 | 대응 |
|---|---|
| Resend 일일 한도 초과 | 무료 3,000건/월로 충분. 초과 시 유료 $20/월 |
| Gist 쓰기 경합 | 요청 적어 문제 가능성 낮음. 추후 Netlify Blobs 검토 |
| 토큰 유출 시 위변조 | 토큰 1회 사용 + 30일 만료로 피해 제한 |
| 관리자 비밀번호 탈취 | ADMIN_KEY 별도 + 접근 로그 |
| 크레딧 재소진 | 월초 사용량 모니터링 + 알림 |

---

**이상 Phase B 설계 완료. 4/23 이후 구현 착수 예정.**
