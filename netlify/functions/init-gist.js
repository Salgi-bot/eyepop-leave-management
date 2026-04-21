// init-gist.js
// 최초 1회 Gist 생성. GIST_ID 환경변수가 없을 때만 생성하고 ID 반환.
// 이미 있으면 현재 ID 반환 (idempotent).

const GIST_API = 'https://api.github.com/gists';

const DEFAULT_EMPLOYEES = {
  employees: [],
  updatedAt: new Date().toISOString()
};

const DEFAULT_SETTINGS = {
  objectionPeriodDays: 3,
  approvalMode: 'auto',
  leaveCalcMode: 'legal',
  emailSender: 'noreply@eyepopeng.com',
  adminEmail: 'eunju@eyepopeng.com',
  vicePresidentEmail: 'gunbon21@gmail.com',
  updatedAt: new Date().toISOString()
};

const DEFAULT_REQUESTS = {
  requests: [],
  updatedAt: new Date().toISOString()
};

export default async (req, context) => {
  const token = process.env.GIST_TOKEN;
  const adminKey = process.env.ADMIN_KEY;

  if (!token) {
    return json({ error: 'GIST_TOKEN not configured' }, 500);
  }

  // 관리자 키 확인 (GET 은 허용, POST 는 키 필요)
  if (req.method !== 'GET') {
    const providedKey = req.headers.get('x-admin-key');
    if (!adminKey || providedKey !== adminKey) {
      return json({ error: 'Unauthorized' }, 401);
    }
  }

  const existingId = process.env.GIST_ID;
  if (existingId) {
    return json({
      status: 'exists',
      gistId: existingId,
      message: 'GIST_ID already configured in Netlify env vars'
    });
  }

  // Gist 신규 생성
  try {
    const resp = await fetch(GIST_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'eyepop-leave-management'
      },
      body: JSON.stringify({
        description: 'EYEPOP 연차관리 데이터 (자동생성)',
        public: false,
        files: {
          'employees.json': { content: JSON.stringify(DEFAULT_EMPLOYEES, null, 2) },
          'settings.json': { content: JSON.stringify(DEFAULT_SETTINGS, null, 2) },
          'requests.json': { content: JSON.stringify(DEFAULT_REQUESTS, null, 2) }
        }
      })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return json({ error: 'Gist creation failed', detail: errText }, resp.status);
    }

    const data = await resp.json();
    return json({
      status: 'created',
      gistId: data.id,
      gistUrl: data.html_url,
      message: `NEXT STEP: run 'netlify env:set GIST_ID ${data.id}' then redeploy`
    });
  } catch (err) {
    return json({ error: 'Unexpected error', detail: err.message }, 500);
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
