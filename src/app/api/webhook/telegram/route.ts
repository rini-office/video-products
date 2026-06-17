import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { extractJobId, processConfirmationJob } from '@/lib/telegram';

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
}

export async function POST(request: NextRequest) {
  try {
    // Verify secret token
    const secretHeader = request.headers.get('x-telegram-bot-api-secret-token');
    if (TELEGRAM_WEBHOOK_SECRET && secretHeader !== TELEGRAM_WEBHOOK_SECRET) {
      console.warn('[TelegramWebhook] Invalid secret token');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body: TelegramUpdate = await request.json();
    console.log('[TelegramWebhook] Received update:', JSON.stringify(body).substring(0, 500));

    const message = body.message;
    if (!message?.text) {
      return NextResponse.json({ ok: true, note: 'no text message' });
    }

    const userText = message.text.trim().toLowerCase();

    if (userText !== 'iya' && userText !== 'ulang') {
      return NextResponse.json({ ok: true, note: 'not a confirmation command' });
    }

    // Find the job this reply is for
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
        console.log(`[TelegramWebhook] Fallback: using most recent awaiting job: ${jobId}`);
      }
    }

    if (!jobId) {
      return NextResponse.json({ ok: true, note: 'no awaiting job' });
    }

    const res = await processConfirmationJob(jobId, userText as 'iya' | 'ulang');

    return NextResponse.json({
      ok: true,
      processed: res.success,
      error: res.error,
    });
  } catch (error) {
    console.error('[TelegramWebhook] Error:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
