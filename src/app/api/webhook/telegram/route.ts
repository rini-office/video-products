import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { extractJobId, processConfirmationJob, answerCallbackQuery } from '@/lib/telegram';

export const runtime = 'nodejs';

const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number | string };
    text?: string;
    reply_to_message?: {
      message_id: number;
      text?: string;
    };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message?: {
      message_id: number;
      chat: { id: number | string };
      text?: string;
    };
    data?: string;
  };
}

/**
 * Parses callback_data format: "confirm:{jobId}:{action}"
 */
function parseCallbackData(data: string): { jobId: string; action: 'iya' | 'ulang' } | null {
  const parts = data.split(':');
  if (parts.length === 3 && parts[0] === 'confirm' && (parts[2] === 'iya' || parts[2] === 'ulang')) {
    return { jobId: parts[1], action: parts[2] };
  }
  return null;
}

export async function POST(request: NextRequest) {
  // ── Verify secret token ──
  const secretHeader = request.headers.get('x-telegram-bot-api-secret-token');
  if (TELEGRAM_WEBHOOK_SECRET && secretHeader !== TELEGRAM_WEBHOOK_SECRET) {
    console.warn('[TelegramWebhook] Invalid secret token');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: TelegramUpdate = await request.json();
  console.log('[TelegramWebhook] Update:', JSON.stringify(body).substring(0, 400));

  // ── 1. Handle inline keyboard callback ──
  if (body.callback_query?.data) {
    return handleCallbackQuery(body);
  }

  // ── 2. Handle text message (fallback for manual reply) ──
  if (body.message?.text) {
    return handleTextMessage(body);
  }

  return NextResponse.json({ ok: true, note: 'no actionable content' });
}

// ── Callback query handler (inline keyboard button tap) ──

async function handleCallbackQuery(body: TelegramUpdate) {
  const cq = body.callback_query!;
  const parsed = parseCallbackData(cq.data!);

  if (!parsed) {
    await answerCallbackQuery(cq.id);
    return NextResponse.json({ ok: true, note: 'invalid callback data' });
  }

  console.log(`[TelegramWebhook] Callback: job=${parsed.jobId}, action=${parsed.action}`);

  // Answer immediately so the button stops loading
  const label = parsed.action === 'iya' ? 'Lanjut buat video...' : 'Mengulang gambar...';
  await answerCallbackQuery(cq.id, label);

  // Process confirmation
  const res = await processConfirmationJob(parsed.jobId, parsed.action);

  return NextResponse.json({
    ok: true,
    method: 'callback',
    processed: res.success,
    error: res.error,
  });
}

// ── Text message handler (fallback) ──

async function handleTextMessage(body: TelegramUpdate) {
  const message = body.message!;
  const userText = message.text!.trim().toLowerCase();

  if (userText !== 'iya' && userText !== 'ulang') {
    return NextResponse.json({ ok: true, note: 'not a confirmation command' });
  }

  // Try to extract job ID from the replied-to message
  let jobId: string | null = null;

  if (message.reply_to_message?.text) {
    jobId = extractJobId(message.reply_to_message.text);
  }

  // Fallback: find the most recent awaiting_confirmation job
  if (!jobId) {
    const db = await getDb();
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM jobs WHERE status = 'awaiting_confirmation' ORDER BY updated_at DESC LIMIT 1`
    );
    if (rows.length > 0) {
      jobId = rows[0].id;
    }
  }

  if (!jobId) {
    return NextResponse.json({ ok: true, note: 'no awaiting job' });
  }

  console.log(`[TelegramWebhook] Text reply: "${userText}" for job ${jobId}`);

  const res = await processConfirmationJob(jobId, userText as 'iya' | 'ulang');

  return NextResponse.json({
    ok: true,
    method: 'text',
    processed: res.success,
    error: res.error,
  });
}
