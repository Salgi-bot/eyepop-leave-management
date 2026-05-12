// Resend API 발송 모듈
// 호출자: submit-request, approve-request 등

const RESEND_API = 'https://api.resend.com/emails';

export async function sendEmail({ to, cc, subject, html, replyTo, attachments }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY not configured');
  }
  if (!to || !subject || !html) {
    throw new Error('to, subject, html are required');
  }

  const payload = {
    from: '연차관리 <noreply@eyepopeng.com>',
    to: Array.isArray(to) ? to : [to],
    subject,
    html
  };
  if (cc) payload.cc = Array.isArray(cc) ? cc : [cc];
  if (replyTo) payload.reply_to = Array.isArray(replyTo) ? replyTo : [replyTo];
  if (Array.isArray(attachments) && attachments.length > 0) payload.attachments = attachments;

  const resp = await fetch(RESEND_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`Resend error: ${data.message || resp.statusText}`);
  }

  return {
    messageId: data.id,
    sentAt: new Date().toISOString()
  };
}

export function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
