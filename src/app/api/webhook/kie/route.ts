import { NextRequest, NextResponse } from 'next/server';
import { updateJob, markFileProcessed } from '@/lib/db';
import { downloadVideo, downloadImage, verifyWebhookSignature } from '@/lib/kie';
import { uploadFile, getFileUrl } from '@/lib/drive';
import { getConfig, getDb } from '@/lib/db';
import { createImageToVideoTask } from '@/lib/kie';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const taskId = body.data?.taskId || body.data?.task_id || body.taskId;
    if (!taskId) {
      return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
    }

    // ── HMAC signature verification ──
    const timestamp = request.headers.get('x-webhook-timestamp');
    const receivedSig = request.headers.get('x-webhook-signature');
    if (timestamp && receivedSig) {
      const isValid = verifyWebhookSignature(taskId, timestamp, receivedSig);
      if (!isValid) {
        console.warn(`[Webhook] Invalid signature for task ${taskId}`);
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
      }
      console.log(`[Webhook] Signature verified for task ${taskId}`);
    } else if (process.env.NODE_ENV === 'production') {
      console.warn(`[Webhook] Missing HMAC headers for task ${taskId} in production`);
    }

    console.log(`[Webhook] Received callback for task: ${taskId}`, JSON.stringify(body).substring(0, 300));

    // Find job by image_gen_task_id or kie_task_id
    const db = getDb();
    const job = db.prepare(
      'SELECT * FROM jobs WHERE image_gen_task_id = ? OR kie_task_id = ?'
    ).get(taskId, taskId) as {
      id: string;
      source_file_name: string;
      source_file_id: string;
      image_output_file_id: string | null;
      image_gen_task_id: string | null;
      kie_task_id: string | null;
      status: string;
    } | undefined;

    if (!job) {
      console.log(`[Webhook] No job found for task: ${taskId}`);
      return NextResponse.json({ received: true, note: 'no matching job' });
    }

    // Determine phase: image or video
    const isImageTask = job.image_gen_task_id === taskId;
    const isVideoTask = job.kie_task_id === taskId;

    if (isImageTask) {
      await handleImageCompletion(job, body);
    } else if (isVideoTask) {
      await handleVideoCompletion(job, body);
    } else {
      console.log(`[Webhook] Task ${taskId} matches job ${job.id} but not image_gen_task_id or kie_task_id`);
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error('[Webhook] Error:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

// ── Image completion → trigger video generation ──

async function handleImageCompletion(
  job: { id: string; source_file_name: string; source_file_id: string; status: string },
  body: Record<string, unknown>
): Promise<void> {
  const state = (body.data as Record<string, unknown> | undefined)?.state as string | undefined;
  const resultJson = (body.data as Record<string, unknown> | undefined)?.resultJson as string | undefined;

  if (state !== 'success' || !resultJson) {
    updateJob(job.id, {
      status: 'failed',
      error: ((body.data as Record<string, unknown> | undefined)?.failMsg as string) || 'Image generation failed',
      completed_at: new Date().toISOString(),
    });
    console.log(`[Webhook] Image task failed for job ${job.id}`);
    return;
  }

  // Extract image URL
  let imageUrl = '';
  try {
    const parsed = JSON.parse(resultJson);
    const urls: string[] = parsed.resultUrls || parsed.imageUrls || parsed.images || [];
    imageUrl = urls[0] || '';
  } catch {
    console.error('[Webhook] Failed to parse image resultJson');
    return;
  }

  if (!imageUrl) {
    updateJob(job.id, { status: 'failed', error: 'No image URL in result', completed_at: new Date().toISOString() });
    return;
  }

  // Download image and upload to Drive
  const imageOutputFolderId = getConfig('drive_image_output_folder') || getConfig('drive_source_folder');
  if (!imageOutputFolderId) {
    updateJob(job.id, { status: 'failed', error: 'Image output folder not configured', completed_at: new Date().toISOString() });
    return;
  }

  try {
    const imageBuffer = await downloadImage(imageUrl);
    const uploadedImageId = await uploadFile(imageOutputFolderId, job.source_file_name, imageBuffer, 'image/png');
    console.log(`[Webhook] Image uploaded to Drive: ${job.source_file_name} (${uploadedImageId})`);

    updateJob(job.id, { image_output_file_id: uploadedImageId, source_file_id: uploadedImageId });

    // Mark source file as processed so it won't be re-processed on next run
    if (job.source_file_id) {
      markFileProcessed(job.source_file_id);
    }

    // Get Drive URL and trigger video generation
    const driveImageUrl = await getFileUrl(uploadedImageId);
    const defaultPrompt = getConfig('default_prompt') || undefined;
    const defaultDuration = parseInt(getConfig('default_duration') || '10', 10);
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const callbackUrl = appUrl.includes('localhost') ? undefined : `${appUrl}/api/webhook/kie`;

    const videoTaskId = await createImageToVideoTask({
      imageUrl: driveImageUrl,
      prompt: defaultPrompt,
      duration: defaultDuration,
      model: 'grok-imagine/image-to-video',
      resolution: '720p',
      callBackUrl: callbackUrl,
    });

    updateJob(job.id, { kie_task_id: videoTaskId, status: 'processing_video' });
    console.log(`[Webhook] Video task created: ${videoTaskId} for job ${job.id}`);

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Webhook] Image completion error for job ${job.id}: ${errorMsg}`);
    updateJob(job.id, { status: 'failed', error: errorMsg, completed_at: new Date().toISOString() });
  }
}

// ── Video completion → download & upload to Drive ──

async function handleVideoCompletion(
  job: { id: string; source_file_name: string },
  body: Record<string, unknown>
): Promise<void> {
  const state = (body.data as Record<string, unknown> | undefined)?.state as string | undefined;
  const resultJson = (body.data as Record<string, unknown> | undefined)?.resultJson as string | undefined;

  // Standard KIE format: data.state + data.resultJson
  let videoUrl = '';
  if (state === 'success' && resultJson) {
    try {
      const parsed = JSON.parse(resultJson);
      const urls: string[] = parsed.resultUrls || [];
      videoUrl = urls[0] || '';
    } catch {
      console.error('[Webhook] Failed to parse video resultJson');
    }
  }

  if (videoUrl) {
    await finalizeVideo(job, videoUrl);
    return;
  }

  // Failure
  if (state === 'fail' || (body.data as Record<string, unknown> | undefined)?.failMsg) {
    updateJob(job.id, {
      status: 'failed',
      error: ((body.data as Record<string, unknown> | undefined)?.failMsg as string) || 'Video generation failed',
      completed_at: new Date().toISOString(),
    });
    console.log(`[Webhook] Video task failed for job ${job.id}`);
  }
}

async function finalizeVideo(
  job: { id: string; source_file_name: string },
  videoUrl: string
): Promise<void> {
  updateJob(job.id, { status: 'completed', output_url: videoUrl });

  const destFolderId = getConfig('drive_dest_folder');
  if (destFolderId) {
    try {
      const videoBuffer = await downloadVideo(videoUrl);
      const videoName = job.source_file_name.replace(/\.[^.]+$/, '') + '_video.mp4';
      const uploadedFileId = await uploadFile(destFolderId, videoName, videoBuffer, 'video/mp4');
      updateJob(job.id, {
        output_file_id: uploadedFileId,
        completed_at: new Date().toISOString(),
      });
      console.log(`[Webhook] Video uploaded to Drive: ${videoName}`);
    } catch (uploadErr) {
      console.error('[Webhook] Failed to upload video to Drive:', uploadErr);
      updateJob(job.id, { completed_at: new Date().toISOString() });
    }
  } else {
    updateJob(job.id, { completed_at: new Date().toISOString() });
  }
  console.log(`[Webhook] Job ${job.id} completed`);
}
