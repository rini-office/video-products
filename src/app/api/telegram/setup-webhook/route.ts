import { NextRequest, NextResponse } from 'next/server';
import { setTelegramWebhook, deleteTelegramWebhook, getTelegramWebhookInfo } from '@/lib/telegram';

export const runtime = 'nodejs';

/**
 * ?action=register → register webhook
 * ?action=delete   → delete webhook
 * ?action=reset    → delete + re-register (full reset)
 * (no param)       → diagnostic page
 */
export async function GET(request: NextRequest) {
  const action = request.nextUrl.searchParams.get('action');
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const webhookUrl = `${appUrl}/api/webhook/telegram`;
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || '';

  if (action === 'register') {
    if (appUrl.includes('localhost')) {
      return NextResponse.json({ error: 'Cannot register on localhost' }, { status: 400 });
    }
    const ok = await setTelegramWebhook(webhookUrl, webhookSecret);
    const info = await getTelegramWebhookInfo();
    return NextResponse.json({ success: ok, webhookUrl, info });
  }

  if (action === 'delete') {
    const ok = await deleteTelegramWebhook();
    const info = await getTelegramWebhookInfo();
    return NextResponse.json({ success: ok, info });
  }

  if (action === 'reset') {
    if (appUrl.includes('localhost')) {
      return NextResponse.json({ error: 'Cannot register on localhost' }, { status: 400 });
    }
    const delOk = await deleteTelegramWebhook();
    await new Promise(r => setTimeout(r, 1000)); // brief delay
    const regOk = await setTelegramWebhook(webhookUrl, webhookSecret);
    const info = await getTelegramWebhookInfo();
    return NextResponse.json({
      deleted: delOk,
      registered: regOk,
      webhookUrl,
      info,
    });
  }

  // Default: diagnostic page
  const info = await getTelegramWebhookInfo();
  const result = (info as Record<string, unknown> | undefined)?.result as Record<string, unknown> | undefined;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Telegram Webhook Diagnostic</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 700px; margin: 40px auto; padding: 20px; background: #111; color: #eee; }
  h1 { font-size: 1.4em; }
  .card { background: #1a1a2e; border: 1px solid #333; border-radius: 8px; padding: 16px; margin: 12px 0; }
  .ok { color: #4caf50; }
  .warn { color: #ff9800; }
  .err { color: #f44336; }
  .mono { font-family: monospace; font-size: 0.9em; word-break: break-all; }
  .btn { display: inline-block; padding: 8px 16px; margin: 4px; border-radius: 4px; text-decoration: none; font-weight: 600; }
  .btn-go { background: #4caf50; color: #fff; }
  .btn-warn { background: #ff9800; color: #000; }
  .btn-danger { background: #f44336; color: #fff; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 6px 8px; border-bottom: 1px solid #333; }
  td:first-child { color: #999; width: 160px; }
</style>
</head>
<body>
<h1>🔧 Telegram Webhook Diagnostic</h1>

<div class="card">
  <h2>Status</h2>
  <table>
    <tr><td>URL</td><td class="mono">${result?.url || '<span class="warn">not set</span>'}</td></tr>
    <tr><td>Pending updates</td><td>${result?.pending_update_count ?? '?'}</td></tr>
    <tr><td>Allowed updates</td><td class="mono">${JSON.stringify(result?.allowed_updates || [])}</td></tr>
    <tr><td>Last error</td><td>${result?.last_error_message ? `<span class="err">${result.last_error_message}</span>` : '<span class="ok">none</span>'}</td></tr>
    <tr><td>Last error date</td><td>${result?.last_error_date ? new Date(Number(result.last_error_date) * 1000).toISOString() : '-'}</td></tr>
    <tr><td>Max connections</td><td>${result?.max_connections ?? '?'}</td></tr>
  </table>
</div>

<div class="card">
  <h2>Diagnosis</h2>
  ${diagnose(result)}
</div>

<div class="card">
  <h2>Actions</h2>
  <a class="btn btn-go" href="?action=register">Register Webhook</a>
  <a class="btn btn-warn" href="?action=reset">Full Reset (delete + register)</a>
  <a class="btn btn-danger" href="?action=delete">Delete Webhook</a>
</div>

<p style="color:#666;font-size:0.8em;margin-top:24px;">
  Target URL: <span class="mono">${webhookUrl}</span><br>
  Secret set: ${webhookSecret ? '<span class="ok">yes</span>' : '<span class="warn">no (TELEGRAM_WEBHOOK_SECRET)</span>'}
</p>
</body>
</html>`;

  return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function diagnose(result: Record<string, unknown> | undefined): string {
  if (!result) {
    return '<span class="err">❌ Webhook tidak terdaftar. Klik "Register Webhook".</span>';
  }

  const issues: string[] = [];
  const allowed = (result.allowed_updates as string[]) || [];
  const url = (result.url as string) || '';

  if (!url) {
    issues.push('<span class="err">❌ URL tidak di-set.</span>');
  }

  if (!allowed.includes('callback_query')) {
    issues.push(`<span class="err">❌ "callback_query" tidak ada di allowed_updates!</span> Inilah kenapa tombol inline keyboard tidak berfungsi. Klik <b>Full Reset</b>.`);
  }

  if (!allowed.includes('message')) {
    issues.push('<span class="warn">⚠️ "message" tidak ada di allowed_updates.</span>');
  }

  if (result.last_error_message) {
    issues.push(`<span class="warn">⚠️ Last error: ${result.last_error_message}</span>`);
  }

  if (issues.length === 0) {
    return '<span class="ok">✅ Semua OK. Webhook seharusnya berfungsi.</span>';
  }

  return issues.join('<br>');
}
