// Vercel Edge Function — Gist Read/Write 프록시
export const config = { runtime: 'edge' };

const GIST_API = 'https://api.github.com/gists';
const ALLOWED_FILES = new Set(['employees.json', 'settings.json', 'requests.json', 'confirm-log.json']);

export default async function handler(req) {
  const token = process.env.GIST_TOKEN;
  const gistId = process.env.GIST_ID;
  const adminKey = process.env.ADMIN_KEY;

  if (!token) return json({ error: 'GIST_TOKEN not configured' }, 500);
  if (!gistId) return json({ error: 'GIST_ID not configured — run init-gist first' }, 500);
  if (!adminKey) return json({ error: 'ADMIN_KEY not configured' }, 500);

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-admin-key'
      }
    });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const providedKey = req.headers.get('x-admin-key');
  if (providedKey !== adminKey) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { action, file, content } = body;

  if (!action) return json({ error: 'action required' }, 400);
  if (file && !ALLOWED_FILES.has(file)) {
    return json({ error: `file must be one of: ${[...ALLOWED_FILES].join(', ')}` }, 400);
  }

  try {
    if (action === 'read') {
      return await handleRead(token, gistId, file);
    }
    if (action === 'write') {
      if (!file) return json({ error: 'file required for write' }, 400);
      if (content === undefined) return json({ error: 'content required for write' }, 400);
      return await handleWrite(token, gistId, file, content);
    }
    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (err) {
    return json({ error: 'Unexpected error', detail: err.message }, 500);
  }
}

async function handleRead(token, gistId, file) {
  const resp = await fetch(`${GIST_API}/${gistId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'eyepop-leave-management'
    }
  });
  if (!resp.ok) {
    const errText = await resp.text();
    return json({ error: 'Gist fetch failed', detail: errText }, resp.status);
  }
  const data = await resp.json();

  if (file) {
    const f = data.files?.[file];
    if (!f) return json({ error: `File not found: ${file}` }, 404);
    let parsed;
    try {
      parsed = JSON.parse(f.content);
    } catch {
      return json({ error: `File is not valid JSON: ${file}` }, 500);
    }
    return json({ file, content: parsed });
  }

  const files = {};
  for (const [name, f] of Object.entries(data.files || {})) {
    try {
      files[name] = JSON.parse(f.content);
    } catch {
      files[name] = null;
    }
  }
  return json({ files });
}

async function handleWrite(token, gistId, file, content) {
  const payload = {
    files: {
      [file]: { content: JSON.stringify(content, null, 2) }
    }
  };
  const resp = await fetch(`${GIST_API}/${gistId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'eyepop-leave-management'
    },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const errText = await resp.text();
    return json({ error: 'Gist update failed', detail: errText }, resp.status);
  }
  return json({ status: 'ok', file, updatedAt: new Date().toISOString() });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
