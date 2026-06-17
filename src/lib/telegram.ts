import { getConfig, getJob, updateJob, getDb, setConfig } from './db';
import { createImageToVideoTask, enhanceImage, generateImage } from './kie';
import { getFileUrl } from './drive';

/**
 * Sends a file to a Telegram bot via the Bot API.
 * Uses native fetch + FormData (Node 18+). No external library needed.
 *
 * Telegram Bot API limits: 50 MB max file size for bots.
 * https://core.telegram.org/bots/api#sendphoto
 * https://core.telegram.org/bots/api#sendvideo
 */

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB Telegram bot limit

interface TelegramResult {
   ok: boolean;
   description?: string;
   result?: unknown;
}

async function sendToTelegram(
   botTokenKey: string,
   chatIdKey: string,
   method: 'sendPhoto' | 'sendVideo',
   buffer: Buffer,
   fileName: string,
   caption?: string,
): Promise<boolean> {
   const token = await getConfig(botTokenKey);
   const chatId = await getConfig(chatIdKey);

   if (!token || !chatId) {
      return false; // not configured — silently skip
   }

   // Check Telegram's 50 MB file size limit
   if (buffer.length > MAX_FILE_SIZE) {
      console.warn(
         `[Telegram] ${method} skipped: file too large ` +
         `(${(buffer.length / 1024 / 1024).toFixed(1)}MB > 50MB limit) for ${fileName}`,
      );
      return false;
   }

   const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;
   const formData = new FormData();
   formData.append('chat_id', chatId);

   const fieldName = method === 'sendPhoto' ? 'photo' : 'video';
   // File extends Blob — satisfies FormData.append's runtime type check.
   // Cast needed because @types/node Buffer<ArrayBufferLike> conflicts with DOM BlobPart.
   formData.append(fieldName, new File([buffer as BlobPart], fileName));

   if (caption) {
      formData.append('caption', caption);
   }

   // No AbortController — Node.js undici has a known deadlock with
   // AbortSignal + FormData streams. TCP keepalive handles hung connections naturally.
   try {
      const response = await fetch(url, { method: 'POST', body: formData });
      const result: TelegramResult = await response.json();

      if (!result.ok) {
         console.error(`[Telegram] ${method} API error:`, result.description);
         return false;
      }

      console.log(`[Telegram] ${method} sent to chat ${chatId}: ${fileName}`);
      return true;
   } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Telegram] ${method} network error for ${fileName}:`, msg);
      return false;
   }
}

/**
 * Sends an image to the Telegram image bot.
 * Configure via `telegram_image_bot_token` and `telegram_image_chat_id` config keys.
 */
export async function sendImageToTelegram(
   buffer: Buffer,
   fileName: string,
   caption?: string,
): Promise<boolean> {
   return sendToTelegram(
      'telegram_image_bot_token',
      'telegram_image_chat_id',
      'sendPhoto',
      buffer,
      fileName,
      caption,
   );
}

/**
 * Sends a video to the Telegram video bot.
 * Configure via `telegram_video_bot_token` and `telegram_video_chat_id` config keys.
 */
export async function sendVideoToTelegram(
   buffer: Buffer,
   fileName: string,
   caption?: string,
): Promise<boolean> {
   return sendToTelegram(
      'telegram_video_bot_token',
      'telegram_video_chat_id',
      'sendVideo',
      buffer,
      fileName,
      caption,
   );
}

// ── Text message (used as fallback when media send fails) ──────────────────

async function sendText(
   botTokenKey: string,
   chatIdKey: string,
   text: string,
): Promise<boolean> {
   const token = await getConfig(botTokenKey);
   const chatId = await getConfig(chatIdKey);

   if (!token || !chatId) return false; // not configured — silently skip

   const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;

   try {
      const response = await fetch(url, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ chat_id: chatId, text }),
      });
      const result: TelegramResult = await response.json();

      if (!result.ok) {
         console.error(`[Telegram] sendMessage error:`, result.description);
         return false;
      }

      console.log(`[Telegram] Message sent to chat ${chatId}`);
      return true;
   } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Telegram] sendMessage network error:`, msg);
      return false;
   }
}

/**
 * Sends a text message to the Telegram video chat.
 * Used as fallback when video upload fails (includes Drive link).
 */
export async function sendTextToVideoChat(text: string): Promise<boolean> {
   return sendText('telegram_video_bot_token', 'telegram_video_chat_id', text);
}

/**
 * Sends a text message to the Telegram image chat.
 * Used as fallback when image upload fails (includes Drive link).
 */
export async function sendTextToImageChat(text: string): Promise<boolean> {
  return sendText('telegram_image_bot_token', 'telegram_image_chat_id', text);
}

// ── Confirmation prompt ───────────────────────────────────────────────────

/**
 * Sends a confirmation prompt to the image chat asking user to choose
 * "iya" (proceed to video) or "ulang" (redo image generation).
 * Uses inline keyboard for clean UX — user just taps a button.
 * Returns the sent message's message_id.
 */
export async function sendConfirmationPrompt(
  jobId: string,
  fileName: string,
): Promise<number | null> {
  const token = await getConfig('telegram_image_bot_token');
  const chatId = await getConfig('telegram_image_chat_id');

  if (!token || !chatId) return null;

  const text = `✅ Gambar selesai: ${fileName}\n\nApa selanjutnya?`;

  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Iya — lanjut video', callback_data: `confirm:${jobId}:iya` },
              { text: '🔄 Ulang — gambar ulang', callback_data: `confirm:${jobId}:ulang` },
            ],
          ],
        },
      }),
    });
    const result: TelegramResult = await response.json();

    if (result.ok && result.result && typeof result.result === 'object') {
      const msgId = (result.result as { message_id: number }).message_id;
      console.log(`[Telegram] Confirmation prompt sent: message_id=${msgId}`);
      return msgId;
    }

    console.error('[Telegram] Failed to send confirmation prompt:', result.description);
    return null;
  } catch (err) {
    console.error('[Telegram] Confirmation prompt network error:', err);
    return null;
  }
}

// ── Bot webhook setup ─────────────────────────────────────────────────────

/**
 * Answers a callback query from an inline keyboard button.
 * Must be called quickly to stop the loading spinner on the user's device.
 */
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
): Promise<boolean> {
  const token = await getConfig('telegram_image_bot_token');
  if (!token) return false;

  const url = `${TELEGRAM_API_BASE}/bot${token}/answerCallbackQuery`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
    const result: TelegramResult = await response.json();
    return result.ok;
  } catch {
    return false;
  }
}

/**
 * Registers a webhook URL with the Telegram Bot API so Telegram
 * sends message updates to our endpoint.
 *
 * Call once during setup or at app startup.
 * Secret token is verified via X-Telegram-Bot-Api-Secret-Token header.
 */
export async function setTelegramWebhook(
  webhookUrl: string,
  secretToken: string,
): Promise<boolean> {
  const token = await getConfig('telegram_image_bot_token');
  if (!token) {
    console.warn('[Telegram] Cannot set webhook — image bot token not configured');
    return false;
  }

  const url = `${TELEGRAM_API_BASE}/bot${token}/setWebhook`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: secretToken,
        allowed_updates: ['message'],
      }),
    });
    const result: TelegramResult = await response.json();

    if (result.ok) {
      console.log('[Telegram] Webhook set successfully');
      return true;
    }

    console.error('[Telegram] Failed to set webhook:', result.description);
    return false;
  } catch (err) {
    console.error('[Telegram] Webhook setup network error:', err);
    return false;
  }
}

/**
 * Removes the Telegram bot webhook and switches back to getUpdates mode.
 */
export async function deleteTelegramWebhook(): Promise<boolean> {
  const token = await getConfig('telegram_image_bot_token');
  if (!token) return false;

  const url = `${TELEGRAM_API_BASE}/bot${token}/deleteWebhook`;
  try {
    const response = await fetch(url, { method: 'POST' });
    const result: TelegramResult = await response.json();
    return result.ok;
  } catch {
    return false;
  }
}

/**
 * Returns the current webhook info for the image bot.
 */
export async function getTelegramWebhookInfo(): Promise<Record<string, unknown> | null> {
  const token = await getConfig('telegram_image_bot_token');
  if (!token) return null;

  const url = `${TELEGRAM_API_BASE}/bot${token}/getWebhookInfo`;
  try {
    const response = await fetch(url);
    const result = await response.json();
    return result as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── Polling fallback (getUpdates) ─────────────────────────────────────────

export interface TelegramMessage {
  messageId: number;
  chatId: string;
  text: string;
  replyToText?: string;
  updateId: number;
}

/**
 * Polls the image bot for new messages using getUpdates.
 * Used as fallback when webhook is not set up.
 * Returns array of parsed messages.
 */
export async function pollForConfirmationMessages(
  offset?: number,
): Promise<{ messages: TelegramMessage[]; nextOffset: number }> {
  const token = await getConfig('telegram_image_bot_token');
  const expectedChatId = await getConfig('telegram_image_chat_id');

  if (!token || !expectedChatId) {
    return { messages: [], nextOffset: offset ?? 0 };
  }

  const params = new URLSearchParams();
  params.set('timeout', '0'); // quick poll for cron — no long-polling
  params.set('allowed_updates', JSON.stringify(['message']));
  if (offset) {
    params.set('offset', String(offset));
  }

  const url = `${TELEGRAM_API_BASE}/bot${token}/getUpdates?${params.toString()}`;

  try {
    const response = await fetch(url);
    const result = (await response.json()) as {
      ok: boolean;
      result?: Array<{
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
      }>;
    };

    if (!result.ok || !result.result) {
      return { messages: [], nextOffset: offset ?? 0 };
    }

    const messages: TelegramMessage[] = [];
    let maxUpdateId = offset ?? 0;

    for (const update of result.result) {
      maxUpdateId = Math.max(maxUpdateId, update.update_id);
      if (
        update.message?.text &&
        String(update.message.chat.id) === expectedChatId
      ) {
        messages.push({
          messageId: update.message.message_id,
          chatId: String(update.message.chat.id),
          text: update.message.text,
          replyToText: update.message.reply_to_message?.text || undefined,
          updateId: update.update_id,
        });
      }
    }

    return { messages, nextOffset: maxUpdateId + 1 };
  } catch (err) {
    console.error('[Telegram] getUpdates error:', err);
    return { messages: [], nextOffset: offset ?? 0 };
  }
}

// ── Confirmation processing (shared by webhook & cron polling) ───────────

function getCallbackUrl(): string | undefined {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  if (appUrl.includes('localhost') || appUrl.includes('127.0.0.1') || appUrl.includes('192.168')) {
    return undefined;
  }
  return `${appUrl}/api/webhook/kie`;
}

/**
 * Extracts a job ID from a confirmation message text.
 * Looks for pattern: [ref:UUID]
 */
export function extractJobId(text: string): string | null {
  const match = text.match(/\[ref:([a-f0-9-]+)\]/i);
  return match ? match[1] : null;
}

/**
 * Processes a confirmation action ("iya" or "ulang") for a given job.
 * This is the shared core logic used by both webhook and cron polling.
 */
export async function processConfirmationJob(
  jobId: string,
  action: 'iya' | 'ulang',
): Promise<{ success: boolean; error?: string }> {
  const job = await getJob(jobId);
  if (!job) {
    return { success: false, error: 'Job not found' };
  }

  if (job.status !== 'awaiting_confirmation') {
    return { success: false, error: `Job ${jobId} is not awaiting confirmation (status: ${job.status})` };
  }

  console.log(`[Telegram] Processing "${action}" for job ${jobId}`);

  if (action === 'iya') {
    return handleIya(job);
  } else {
    return handleUlang(job);
  }
}

async function handleIya(
  job: NonNullable<Awaited<ReturnType<typeof getJob>>>
): Promise<{ success: boolean; error?: string }> {
  if (!job.image_output_file_id) {
    const err = 'No enhanced image found — cannot create video';
    await updateJob(job.id, { status: 'failed', error: err, completed_at: new Date().toISOString() });
    return { success: false, error: err };
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
    console.log(`[Telegram] Video task created: ${videoTaskId} for job ${job.id}`);
    return { success: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await updateJob(job.id, { status: 'failed', error: errorMsg, completed_at: new Date().toISOString() });
    return { success: false, error: errorMsg };
  }
}

async function handleUlang(
  job: NonNullable<Awaited<ReturnType<typeof getJob>>>
): Promise<{ success: boolean; error?: string }> {
  try {
    const callbackUrl = getCallbackUrl();

    if (job.source_file_id) {
      // Image-to-Image: re-enhance the original image
      const originalImageUrl = await getFileUrl(job.source_file_id);
      const enhancePrompt = await getConfig('default_image_to_image_prompt') || 'Enhance this image, improve quality, add cinematic lighting';
      const imageAspectRatio = await getConfig('image_aspect_ratio') || 'auto';
      const imageResolution = await getConfig('image_resolution') || '1K';
      const imageOutputFormat = await getConfig('image_output_format') || 'jpg';

      console.log(`[Telegram] Re-enhancing original image for job ${job.id}`);

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

      console.log(`[Telegram] Image re-enhancement submitted: ${newImageTaskId}`);
    } else {
      // Text-to-Image: re-generate from the same prompt
      const prompt = job.image_prompt || await getConfig('default_image_prompt') || 'A beautiful cinematic scene';
      const imageResolution = await getConfig('text_image_resolution') || '1024x1024';

      console.log(`[Telegram] Re-generating image for job ${job.id}`);

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

      console.log(`[Telegram] Image re-generation submitted: ${newImageTaskId}`);
    }

    return { success: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await updateJob(job.id, { status: 'failed', error: errorMsg, completed_at: new Date().toISOString() });
    return { success: false, error: errorMsg };
  }
}

/**
 * Polls Telegram for confirmation messages and processes any "iya"/"ulang" replies.
 * Meant to be called periodically (e.g., from the cron job).
 * Uses persisted offset in config to avoid re-processing old messages.
 */
export async function processTelegramConfirmations(): Promise<{
  processed: number;
  errors: string[];
}> {
  const result = { processed: 0, errors: [] as string[] };

  try {
    const offsetStr = await getConfig('telegram_poll_offset');
    const offset = offsetStr ? parseInt(offsetStr, 10) : undefined;

    const { messages, nextOffset } = await pollForConfirmationMessages(offset);

    await setConfig('telegram_poll_offset', String(nextOffset));

    for (const msg of messages) {
      const userText = msg.text.trim().toLowerCase();
      if (userText !== 'iya' && userText !== 'ulang') {
        continue; // not a confirmation command
      }

      // Try to extract job ID from the replied-to message text
      let jobId: string | null = null;
      if (msg.replyToText) {
        jobId = extractJobId(msg.replyToText);
      }

      // Fallback: find the most recent awaiting_confirmation job
      if (!jobId) {
        try {
          const db = await getDb();
          const { rows } = await db.query<{ id: string }>(
            `SELECT id FROM jobs WHERE status = 'awaiting_confirmation' ORDER BY updated_at DESC LIMIT 1`
          );
          if (rows.length > 0) {
            jobId = rows[0].id;
          }
        } catch {
          // ignore
        }
      }

      if (!jobId) {
        console.log(`[Telegram] No awaiting job found for confirmation msg: "${userText}"`);
        continue;
      }

      const res = await processConfirmationJob(jobId, userText as 'iya' | 'ulang');
      if (res.success) {
        result.processed++;
      } else {
        result.errors.push(res.error || 'unknown error');
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Telegram] processTelegramConfirmations error:', msg);
    result.errors.push(msg);
  }

  return result;
}
