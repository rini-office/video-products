import { getConfig } from './db';
import crypto from 'crypto';

const KIE_API_BASE = 'https://api.kie.ai';
const WEBHOOK_HMAC_KEY = process.env.WEBHOOK_HMAC_KEY || '09795473fe3e5b6cef664b8d61b3fd4872860be763c37dcad0af723914dbf07d';

export function verifyWebhookSignature(
  taskId: string,
  timestamp: string,
  receivedSignature: string
): boolean {
  if (!WEBHOOK_HMAC_KEY) return true; // Skip if no key configured

  const dataToSign = `${taskId}.${timestamp}`;
  const hmac = crypto.createHmac('sha256', WEBHOOK_HMAC_KEY);
  hmac.update(dataToSign);
  const expected = hmac.digest('base64');

  if (expected.length !== receivedSignature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(receivedSignature));
}

interface KieApiResponse {
  code: number;
  msg: string;
  data?: {
    taskId?: string;
    state?: string;
    resultJson?: string;
    failMsg?: string;
    progress?: number;
    creditsConsumed?: number;
  };
}

async function getApiKey(): Promise<string> {
  const key = await getConfig('kie_api_key');
  if (!key) {
    throw new Error('KIE API key not configured. Please set kie_api_key in settings.');
  }
  return key;
}

async function kieGet(endpoint: string): Promise<KieApiResponse> {
  const response = await fetch(`${KIE_API_BASE}${endpoint}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${await getApiKey()}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`KIE API error (${response.status}): ${errorText}`);
  }

  return response.json();
}

async function kiePost(endpoint: string, body: Record<string, unknown>): Promise<KieApiResponse> {
  const response = await fetch(`${KIE_API_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${await getApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`KIE API error (${response.status}): ${errorText}`);
  }

  return response.json();
}

export interface VideoGenerationParams {
  imageUrl: string;
  prompt?: string;
  duration?: number;
  sound?: boolean;
  model?: string;
  callBackUrl?: string;
  mode?: string;       // Grok: fun/normal/spicy
  resolution?: string; // Grok: 480p/720p, Kling: n/a
}

function buildRequestBody(params: VideoGenerationParams): Record<string, unknown> {
  const model = params.model || 'grok-imagine/image-to-video';

  const input: Record<string, unknown> = {
    image_urls: [params.imageUrl],
  };

  // Prompt
  if (params.prompt) {
    input.prompt = params.prompt;
  }

  // Duration
  const dur = params.duration || 10;
  input.duration = String(dur);

  // Grok-specific
  input.mode = params.mode || 'normal';
  input.resolution = params.resolution || '720p';

  const body: Record<string, unknown> = { model, input };

  if (params.callBackUrl) {
    body.callBackUrl = params.callBackUrl;
  }

  return body;
}

export async function createImageToVideoTask(params: VideoGenerationParams): Promise<string> {
  const body = buildRequestBody(params);

  const result = await kiePost('/api/v1/jobs/createTask', body);

  if (result.code !== 200) {
    throw new Error(`KIE task creation failed (${result.code}): ${result.msg}`);
  }

  return result.data!.taskId!;
}

export interface TaskStatus {
  taskId: string;
  status: 'pending' | 'processing' | 'success' | 'failed';
  outputUrl?: string;
  outputUrls?: string[];
  error?: string;
  progress?: number;
}

export async function checkTaskStatus(taskId: string): Promise<TaskStatus> {
  const result = await kieGet(`/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`);

  if (result.code !== 200 && result.code !== 505) {
    throw new Error(`KIE task query failed (${result.code}): ${result.msg}`);
  }

  const state = result.data?.state || 'pending';
  let outputUrls: string[] = [];

  if (result.data?.resultJson) {
    try {
      const parsed = JSON.parse(result.data.resultJson);
      if (parsed.resultUrls && Array.isArray(parsed.resultUrls)) {
        outputUrls = parsed.resultUrls;
      }
    } catch {
      // resultJson might not be valid JSON
    }
  }

  return {
    taskId,
    status: state as TaskStatus['status'],
    outputUrl: outputUrls[0],
    outputUrls,
    error: result.data?.failMsg || undefined,
    progress: result.data?.progress,
  };
}

export async function pollTaskCompletion(
  taskId: string,
  maxAttempts = 120,
  intervalMs = 15000
): Promise<TaskStatus> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const status = await checkTaskStatus(taskId);

    if (status.status === 'success' || status.status === 'failed') {
      return status;
    }

    console.log(`[KIE] Task ${taskId} status: ${status.status} (progress: ${status.progress ?? '?'}%)`);

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Task ${taskId} timed out after ${maxAttempts} polling attempts`);
}

export async function downloadVideo(url: string): Promise<Buffer> {
  return downloadMedia(url);
}

// ── Image-to-Image (Enhancement) ───────────────────────────────────────────

export interface ImageToImageParams {
  imageUrl: string;
  prompt?: string;
  model?: string;
  aspectRatio?: string;   // "auto", "1:1", "16:9", "9:16", etc.
  resolution?: string;    // "1K", "2K", "4K"
  outputFormat?: string;  // "png", "jpg"
  callBackUrl?: string;
}

async function buildImageToImageRequestBody(params: ImageToImageParams): Promise<Record<string, unknown>> {
  const model = params.model || await getConfig('kie_image_model') || 'nano-banana-2';

  const input: Record<string, unknown> = {
    prompt: params.prompt || await getConfig('default_image_to_image_prompt') || 'Enhance this image, improve quality, add cinematic lighting and detail',
    image_input: [params.imageUrl],
    aspect_ratio: params.aspectRatio || await getConfig('image_aspect_ratio') || 'auto',
    resolution: params.resolution || await getConfig('image_resolution') || '1K',
    output_format: params.outputFormat || await getConfig('image_output_format') || 'jpg',
  };

  const body: Record<string, unknown> = { model, input };

  if (params.callBackUrl) {
    body.callBackUrl = params.callBackUrl;
  }

  return body;
}

export async function enhanceImage(params: ImageToImageParams): Promise<string> {
  const body = await buildImageToImageRequestBody(params);

  const result = await kiePost('/api/v1/jobs/createTask', body);

  if (result.code !== 200) {
    throw new Error(`KIE image-to-image failed (${result.code}): ${result.msg}`);
  }

  return result.data!.taskId!;
}

// ── Text-to-Image Generation ──────────────────────────────────────────────

export interface ImageGenerationParams {
  prompt: string;
  model?: string;
  count?: number;
  resolution?: string;  // e.g. "1024x1024", "1792x1024"
  callBackUrl?: string;
}

async function buildImageRequestBody(params: ImageGenerationParams): Promise<Record<string, unknown>> {
  const model = params.model || await getConfig('kie_image_model') || 'grok-imagine/text-to-image';
  const count = params.count || 1;
  const resolution = params.resolution || '1024x1024';

  const input: Record<string, unknown> = {
    prompt: params.prompt,
    num_images: count,
    resolution,
  };

  const body: Record<string, unknown> = { model, input };

  if (params.callBackUrl) {
    body.callBackUrl = params.callBackUrl;
  }

  return body;
}

export async function generateImage(params: ImageGenerationParams): Promise<string> {
  const body = await buildImageRequestBody(params);

  const result = await kiePost('/api/v1/jobs/createTask', body);

  if (result.code !== 200) {
    throw new Error(`KIE image generation failed (${result.code}): ${result.msg}`);
  }

  return result.data!.taskId!;
}

export interface ImageTaskStatus {
  taskId: string;
  status: 'pending' | 'processing' | 'success' | 'failed';
  imageUrls: string[];
  error?: string;
  progress?: number;
}

export async function checkImageTaskStatus(taskId: string): Promise<ImageTaskStatus> {
  const result = await kieGet(`/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`);

  if (result.code !== 200 && result.code !== 505) {
    throw new Error(`KIE image task query failed (${result.code}): ${result.msg}`);
  }

  const state = result.data?.state || 'pending';
  let imageUrls: string[] = [];

  if (result.data?.resultJson) {
    try {
      const parsed = JSON.parse(result.data.resultJson);
      const urls = parsed.resultUrls || parsed.imageUrls || parsed.images || [];
      imageUrls = Array.isArray(urls) ? urls : [];
    } catch {
      // resultJson might not be valid JSON
    }
  }

  return {
    taskId,
    status: state as ImageTaskStatus['status'],
    imageUrls,
    error: result.data?.failMsg || undefined,
    progress: result.data?.progress,
  };
}

export async function pollImageTaskCompletion(
  taskId: string,
  maxAttempts = 120,
  intervalMs = 15000
): Promise<ImageTaskStatus> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const status = await checkImageTaskStatus(taskId);

    if (status.status === 'success' || status.status === 'failed') {
      return status;
    }

    console.log(`[KIE] Image task ${taskId} status: ${status.status} (progress: ${status.progress ?? '?'}%)`);

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Image task ${taskId} timed out after ${maxAttempts} polling attempts`);
}

export async function downloadImage(url: string): Promise<Buffer> {
  return downloadMedia(url);
}

// ── Wan 2.7 Image Generation / Editing ───────────────────────────────────

export interface WanImageParams {
  prompt: string;
  inputUrls?: string[];       // optional - for image editing / variation
  aspectRatio?: string;        // "1:1", "16:9", "4:3", "21:9", "3:4", "9:16", "8:1", "1:8"
  resolution?: string;         // "1K", "2K", "4K"
  count?: number;              // 1-4 (sequential=false) or 1-12 (sequential=true)
  enableSequential?: boolean;
  thinkingMode?: boolean;      // only when sequential=false and no inputUrls
  watermark?: boolean;
  seed?: number;               // 0-2147483647
  nsfwChecker?: boolean;
  callBackUrl?: string;
}

function buildWanImageRequestBody(params: WanImageParams): Record<string, unknown> {
  const model = 'wan/2-7-image';

  const input: Record<string, unknown> = {
    prompt: params.prompt,
  };

  if (params.inputUrls && params.inputUrls.length > 0) {
    input.input_urls = params.inputUrls;
  }

  // aspect_ratio only meaningful for text-to-image (no inputUrls)
  if (!params.inputUrls?.length && params.aspectRatio) {
    input.aspect_ratio = params.aspectRatio;
  }

  if (params.resolution) {
    input.resolution = params.resolution;
  }

  const sequential = params.enableSequential ?? false;
  if (sequential) {
    input.enable_sequential = true;
  }

  const count = params.count ?? 1;
  input.n = count;

  if (params.thinkingMode && !sequential && (!params.inputUrls || params.inputUrls.length === 0)) {
    input.thinking_mode = true;
  }

  if (params.watermark) {
    input.watermark = true;
  }

  if (params.seed !== undefined && params.seed !== 0) {
    input.seed = params.seed;
  }

  if (params.nsfwChecker) {
    input.nsfw_checker = true;
  }

  const body: Record<string, unknown> = { model, input };

  if (params.callBackUrl) {
    body.callBackUrl = params.callBackUrl;
  }

  return body;
}

export async function createWanImageTask(params: WanImageParams): Promise<string> {
  const body = buildWanImageRequestBody(params);

  const result = await kiePost('/api/v1/jobs/createTask', body);

  if (result.code !== 200) {
    throw new Error(`KIE Wan 2.7 image task creation failed (${result.code}): ${result.msg}`);
  }

  return result.data!.taskId!;
}

// ── Wan 2.7 Image-to-Video ─────────────────────────────────────────────────

export interface WanVideoParams {
  prompt: string;
  negativePrompt?: string;
  firstFrameUrl?: string;       // first-frame-to-video mode
  lastFrameUrl?: string;        // first-and-last-frame mode
  firstClipUrl?: string;        // video continuation mode
  drivingAudioUrl?: string;     // audio-driven generation
  resolution?: string;          // "720p" | "1080p"
  duration?: number;            // 2-15, default 5
  promptExtend?: boolean;       // default true
  watermark?: boolean;
  seed?: number;                // 0-2147483647
  nsfwChecker?: boolean;
  callBackUrl?: string;
}

function buildWanVideoRequestBody(params: WanVideoParams): Record<string, unknown> {
  const model = 'wan/2-7-image-to-video';

  const input: Record<string, unknown> = {
    prompt: params.prompt,
    prompt_extend: params.promptExtend ?? true,
  };

  if (params.negativePrompt) {
    input.negative_prompt = params.negativePrompt;
  }

  if (params.firstFrameUrl) {
    input.first_frame_url = params.firstFrameUrl;
  }

  if (params.lastFrameUrl) {
    input.last_frame_url = params.lastFrameUrl;
  }

  if (params.firstClipUrl) {
    input.first_clip_url = params.firstClipUrl;
  }

  if (params.drivingAudioUrl) {
    input.driving_audio_url = params.drivingAudioUrl;
  }

  if (params.resolution) {
    input.resolution = params.resolution;
  }

  if (params.duration !== undefined) {
    // Wan expects integer, 2-15
    input.duration = Math.max(2, Math.min(15, Math.round(params.duration)));
  }

  if (params.watermark) {
    input.watermark = true;
  }

  if (params.seed !== undefined && params.seed !== 0) {
    input.seed = params.seed;
  }

  if (params.nsfwChecker) {
    input.nsfw_checker = true;
  }

  const body: Record<string, unknown> = { model, input };

  if (params.callBackUrl) {
    body.callBackUrl = params.callBackUrl;
  }

  return body;
}

export async function createWanVideoTask(params: WanVideoParams): Promise<string> {
  const body = buildWanVideoRequestBody(params);

  const result = await kiePost('/api/v1/jobs/createTask', body);

  if (result.code !== 200) {
    throw new Error(`KIE Wan 2.7 video task creation failed (${result.code}): ${result.msg}`);
  }

  return result.data!.taskId!;
}

// ── Veo 3.1 Lite Image-to-Video ────────────────────────────────────────────

export interface VeoVideoParams {
  prompt: string;
  imageUrl: string;
  callBackUrl?: string;
}

export async function createVeoVideoTask(params: VeoVideoParams): Promise<string> {
  const body: Record<string, unknown> = {
    prompt: params.prompt || 'Generate a cinematic video from this image',
    imageUrls: [params.imageUrl],
    model: 'veo3_lite',
    generationType: 'FIRST_AND_LAST_FRAMES_2_VIDEO',
    aspect_ratio: '9:16',
    resolution: '1080p',
    duration: 8,
  };

  if (params.callBackUrl) {
    body.callBackUrl = params.callBackUrl;
  }

  console.log('[KIE Veo] Sending request to /api/v1/veo/generate:', JSON.stringify(body, null, 2));

  const result = await kiePost('/api/v1/veo/generate', body);

  console.log('[KIE Veo] Response:', JSON.stringify(result));

  if (result.code !== 200) {
    throw new Error(`KIE Veo 3.1 video task creation failed (${result.code}): ${result.msg}`);
  }

  if (!result.data?.taskId) {
    throw new Error(`KIE Veo 3.1 returned 200 but no taskId in response: ${JSON.stringify(result)}`);
  }

  return result.data.taskId;
}

// ── Veo 3.1 polling (kebab-case: /api/v1/veo/record-info) ──────────────────

export async function checkVeoTaskStatus(taskId: string): Promise<TaskStatus> {
  const result = await kieGet(`/api/v1/veo/record-info?taskId=${encodeURIComponent(taskId)}`);

  // 422 = still processing, no record yet
  if (result.code === 422) {
    return { taskId, status: 'processing', outputUrls: [], progress: undefined };
  }

  if (result.code !== 200 && result.code !== 505) {
    throw new Error(`KIE Veo task query failed (${result.code}): ${result.msg}`);
  }

  let outputUrls: string[] = [];
  let state: string = 'pending';

  // Veo format: data.info.resultUrls (JSON string)
  const info = (result.data as Record<string, unknown> | undefined)?.info as Record<string, unknown> | undefined;
  if (info?.resultUrls && typeof info.resultUrls === 'string') {
    try {
      const parsed = JSON.parse(info.resultUrls);
      outputUrls = Array.isArray(parsed) ? parsed : [info.resultUrls];
    } catch {
      outputUrls = [info.resultUrls];
    }
  }

  // Fallback: standard resultJson format
  if (outputUrls.length === 0 && result.data?.resultJson) {
    try {
      const parsed = JSON.parse(result.data.resultJson);
      const urls = parsed.resultUrls || parsed.images || parsed.videoUrls || [];
      outputUrls = Array.isArray(urls) ? urls : [];
    } catch {
      // resultJson might not be valid JSON
    }
  }

  if (outputUrls.length > 0) {
    state = 'success';
  } else if (result.data?.state) {
    state = result.data.state;
  } else if (result.code === 200) {
    state = 'processing';
  }

  return {
    taskId,
    status: state as TaskStatus['status'],
    outputUrl: outputUrls[0],
    outputUrls,
    error: result.data?.failMsg || undefined,
    progress: result.data?.progress,
  };
}

export async function pollVeoTaskCompletion(
  taskId: string,
  maxAttempts = 120,
  intervalMs = 15000
): Promise<TaskStatus> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const status = await checkVeoTaskStatus(taskId);

    if (status.status === 'success' || status.status === 'failed') {
      return status;
    }

    console.log(`[KIE] Veo task ${taskId} status: ${status.status} (progress: ${status.progress ?? '?'}%)`);

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Veo task ${taskId} timed out after ${maxAttempts} polling attempts`);
}

// ── Shared download helper ────────────────────────────────────────────────

async function downloadMedia(url: string): Promise<Buffer> {
  // Use KIE download proxy for reliable download with auth
  const proxyRes = await fetch(`${KIE_API_BASE}/api/v1/common/download-url`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${await getApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url }),
  });

  let downloadUrl = url;
  if (proxyRes.ok) {
    const json = await proxyRes.json() as { code: number; data: string };
    if (json.code === 200 && json.data) {
      downloadUrl = json.data;
    }
  }

  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to download media: ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
