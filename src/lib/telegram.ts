import { getConfig } from './db';

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
 * Returns the sent message's message_id for reply tracking.
 */
export async function sendConfirmationPrompt(
  jobId: string,
  fileName: string,
): Promise<number | null> {
  const token = await getConfig('telegram_image_bot_token');
  const chatId = await getConfig('telegram_image_chat_id');

  if (!token || !chatId) return null;

  const text = [
    `✅ Gambar selesai: ${fileName}`,
    ``,
    `Balas dengan:`,
    `• "iya" — lanjut buat video`,
    `• "ulang" — ulang gambar yang sama`,
    ``,
    `[ref:${jobId}]`,
  ].join('\n');

  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
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
  params.set('timeout', '5');
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
        });
      }
    }

    return { messages, nextOffset: maxUpdateId + 1 };
  } catch (err) {
    console.error('[Telegram] getUpdates error:', err);
    return { messages: [], nextOffset: offset ?? 0 };
  }
}
