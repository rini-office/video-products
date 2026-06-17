import { NextRequest, NextResponse } from 'next/server';
import { getConfig, getJob, updateJob } from '@/lib/db';
import { getFileUrl } from '@/lib/drive';
import { createImageToVideoTask, enhanceImage, generateImage } from '@/lib/kie';

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

/**
 * Extracts a job ID from a confirmation message text.
 * Looks for pattern: [ref:UUID]
 */
function extractJobId(text: string): string | null {
  const match = text.match(/\[ref:([a-f0-9-]+)\]/i);
  return match ? match[1] : null;
}

function getCallbackUrl(): string | undefined {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  if (appUrl.includes('localhost') || appUrl.includes('127.0.0.1') || appUrl.includes('192.168')) {
    return undefined;
  }
  return `${appUrl}/api/webhook/kie`;
}

export async function POST(request: NextRequest) {
  try {
    // ── Verify secret token ──
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

    // Check if it's a confirmation reply ("iya" or "ulang")
    if (userText !== 'iya' && userText !== 'ulang') {
      console.log(`[TelegramWebhook] Ignoring non-confirmation message: "${userText}"`);
      return NextResponse.json({ ok: true, note: 'not a confirmation command' });
    }

    // Find the job this reply is for
    let jobId: string | null = null;

    // First, try to extract job ID from the replied-to message
    if (message.reply_to_message?.text) {
      jobId = extractJobId(message.reply_to_message.text);
    }

    // Fallback: find the most recent awaiting_confirmation job
    if (!jobId) {
      const { getDb } = await import('@/lib/db');
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
      console.log('[TelegramWebhook] No awaiting_confirmation job found');
      return NextResponse.json({ ok: true, note: 'no awaiting job' });
    }

    const job = await getJob(jobId);
    if (!job) {
      console.log(`[TelegramWebhook] Job not found: ${jobId}`);
      return NextResponse.json({ ok: true, note: 'job not found' });
    }

    if (job.status !== 'awaiting_confirmation') {
      console.log(`[TelegramWebhook] Job ${jobId} is not awaiting confirmation (status: ${job.status})`);
      return NextResponse.json({ ok: true, note: 'job not awaiting confirmation' });
    }

    console.log(`[TelegramWebhook] User replied "${userText}" for job ${jobId}`);

    if (userText === 'iya') {
      await handleConfirmationIya(job);
    } else if (userText === 'ulang') {
      await handleConfirmationUlang(job);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[TelegramWebhook] Error:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

// ── "iya" → proceed to video generation ──

async function handleConfirmationIya(
  job: NonNullable<Awaited<ReturnType<typeof getJob>>>
): Promise<void> {
  if (!job.image_output_file_id) {
    await updateJob(job.id, {
      status: 'failed',
      error: 'No enhanced image found — cannot create video',
      completed_at: new Date().toISOString(),
    });
    console.log(`[TelegramWebhook] Job ${job.id}: no image_output_file_id`);
    return;
  }

  try {
    const driveImageUrl = await getFileUrl(job.image_output_file_id);
    const defaultPrompt = await getConfig('default_prompt') || undefined;
    const defaultDuration = parseInt(await getConfig('default_duration') || '10', 10);
    const callbackUrl = getCallbackUrl();

    const videoTaskId = await createImageToVideoTask({
      imageUrl: driveImageUrl,
      prompt: defaultPrompt,
      duration: defaultDuration,
      model: 'grok-imagine/image-to-video',
      resolution: '720p',
      callBackUrl: callbackUrl,
    });

    await updateJob(job.id, { kie_task_id: videoTaskId, status: 'processing_video' });
    console.log(`[TelegramWebhook] Video task created: ${videoTaskId} for job ${job.id}`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[TelegramWebhook] Video creation error for job ${job.id}: ${errorMsg}`);
    await updateJob(job.id, { status: 'failed', error: errorMsg, completed_at: new Date().toISOString() });
  }
}

// ── "ulang" → re-submit image generation ──

async function handleConfirmationUlang(
  job: NonNullable<Awaited<ReturnType<typeof getJob>>>
): Promise<void> {
  try {
    const callbackUrl = getCallbackUrl();

    // Determine mode: image-to-image (has source_file_id) or text-to-image
    if (job.source_file_id) {
      // ── Image-to-Image: re-enhance the original image ──
      const originalImageUrl = await getFileUrl(job.source_file_id);
      const enhancePrompt = await getConfig('default_image_to_image_prompt') || 'Enhance this image, improve quality, add cinematic lighting';
      const imageAspectRatio = await getConfig('image_aspect_ratio') || 'auto';
      const imageResolution = await getConfig('image_resolution') || '1K';
      const imageOutputFormat = await getConfig('image_output_format') || 'jpg';

      console.log(`[TelegramWebhook] Re-enhancing original image for job ${job.id}`);

      const newImageTaskId = await enhanceImage({
        imageUrl: originalImageUrl,
        prompt: enhancePrompt,
        model: 'nano-banana-2',
        aspectRatio: imageAspectRatio,
        resolution: imageResolution,
        outputFormat: imageOutputFormat,
        callBackUrl: callbackUrl,
      });

      await updateJob(job.id, {
        image_gen_task_id: newImageTaskId,
        status: 'processing_image',
        error: null,
        kie_task_id: null,
        output_url: null,
        output_file_id: null,
        image_output_file_id: null,
      });

      console.log(`[TelegramWebhook] Image re-enhancement submitted: ${newImageTaskId} for job ${job.id}`);
    } else {
      // ── Text-to-Image: re-generate from the same prompt ──
      const prompt = job.image_prompt || await getConfig('default_image_prompt') || 'A beautiful cinematic scene';
      const imageResolution = await getConfig('text_image_resolution') || '1024x1024';

      console.log(`[TelegramWebhook] Re-generating image for job ${job.id}: "${prompt.substring(0, 80)}..."`);

      const newImageTaskId = await generateImage({
        prompt,
        model: 'grok-imagine/text-to-image',
        count: 1,
        resolution: imageResolution,
        callBackUrl: callbackUrl,
      });

      await updateJob(job.id, {
        image_gen_task_id: newImageTaskId,
        status: 'processing_image',
        error: null,
        kie_task_id: null,
        output_url: null,
        output_file_id: null,
        image_output_file_id: null,
      });

      console.log(`[TelegramWebhook] Image re-generation submitted: ${newImageTaskId} for job ${job.id}`);
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[TelegramWebhook] Re-submit error for job ${job.id}: ${errorMsg}`);
    await updateJob(job.id, { status: 'failed', error: errorMsg, completed_at: new Date().toISOString() });
  }
}
