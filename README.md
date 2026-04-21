# EYEPOP 연차관리 (eyepop-leave-management)

아이팝엔지니어링 사내 연차관리 웹앱. Plain HTML + Vanilla JS + Netlify Functions + GitHub Gist 스토리지.

## 아키텍처

```
브라우저 (Plain HTML/JS)
    ↓ fetch
Netlify Functions (/.netlify/functions/)
    ├── gist-proxy    : Gist Read/Write (토큰 서버에서만 사용)
    └── init-gist     : 최초 1회 Gist 생성 + ID 반환
        ↓ HTTPS
GitHub Gist API (실제 데이터, secret gist)
```

## 보안 모델

- GitHub PAT (`GIST_TOKEN`) 은 Netlify 환경변수에만 보관. 클라이언트 JS 에는 절대 노출되지 않음.
- Gist 는 secret 으로 생성 (GitHub 검색 비노출). 단, ID 를 아는 누구나 접근 가능하므로 ID 자체도 비공개 유지.
- 관리자 게이트: 클라이언트 비밀번호 (`0477`) + Netlify Function 측 `ADMIN_KEY` 헤더 이중 확인.
- 데이터는 GitHub 저장 외 추가 암호화 없음. PII (이름/이메일/입사일) 포함되므로 PAT 로테이션은 `.secrets/eyepop-leave.env` 갱신 → `netlify env:set GIST_TOKEN` 재실행으로 수행.

## Netlify 환경변수

| Key | Value | Required |
|---|---|---|
| `GIST_TOKEN` | GitHub PAT (gist scope) | 필수 |
| `GIST_ID` | init-gist 로 생성된 Gist ID | 2차 배포 후 설정 |
| `ADMIN_KEY` | 관리자 인증용 공유 시크릿 | 필수 |

## Phase 진행 상황

- **Phase A** (현재): 관리자 로그인, 엑셀 업로드, 직원 CRUD, 설정 저장
- **Phase B** (예정): 이메일 발송 (Resend), 신청·승인 흐름, 이의 제기 기간 처리

## 배포

```bash
# 최초 설정
source /Users/salgi/.secrets/eyepop-leave.env
netlify env:set GIST_TOKEN "$GIST_TOKEN"
netlify env:set ADMIN_KEY "$(openssl rand -hex 16)"
netlify deploy --prod

# init-gist 호출해서 ID 확보
curl https://<site>.netlify.app/.netlify/functions/init-gist
# 반환된 ID 를 환경변수에 저장 후 재배포
netlify env:set GIST_ID <gist-id>
netlify deploy --prod
```

## 법적 준수 요건

- 근로기준법 제60조 연차 유급휴가 산정식 준수
- 개인정보보호법: 직원 동의 하에 이름/이메일/입사일 저장
- 퇴사자 데이터는 별도 정책 (Phase B 에서 아카이브 기능 추가 예정)
