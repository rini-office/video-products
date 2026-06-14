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
   // Pass Buffer directly — undici (Node.js fetch) supports this at runtime.
   // The `as unknown as` cast avoids TS DOM-type mismatch (BlobPart vs Buffer).
   (formData as unknown as Record<string, (name: string, value: unknown, filename?: string) => void>)
      .append(fieldName, buffer, fileName);

   if (caption) {
      formData.append('caption', caption);
   }

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
 *
 * @param buffer  The image binary data
 * @param fileName  The filename WITH extension (e.g. "photo.png")
 * @param caption  Optional caption text
 * @returns true if sent successfully, false if skipped/errored
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
 *
 * @param buffer  The video binary data
 * @param fileName  The filename WITH extension (e.g. "video.mp4")
 * @param caption  Optional caption text
 * @returns true if sent successfully, false if skipped/errored
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
