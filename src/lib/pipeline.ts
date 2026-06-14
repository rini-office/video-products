import { v4 as uuidv4 } from 'uuid';
import {
  listImagesInFolder,
  getFileUrl,
  uploadFile,
} from './drive';
import {
  createImageToVideoTask,
  checkTaskStatus,
  downloadVideo,
  generateImage,
  enhanceImage,
} from './kie';
import { createJob, updateJob, getJob, isFileProcessed, markFileProcessed, getConfig } from './db';

const isVercel = !!process.env.VERCEL;

interface PipelineResult {
  success: boolean;
  processed: number;
  failed: number;
  errors: string[];
  jobIds: string[];
}

function getCallbackUrl(): string | undefined {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  if (appUrl.includes('localhost') || appUrl.includes('127.0.0.1') || appUrl.includes('192.168')) {
    return undefined;
  }
  return `${appUrl}/api/webhook/kie`;
}

export async function runPipeline(
  inputFolderId: string,
  imageOutputFolderId: string,
  videoOutputFolderId: string
): Promise<PipelineResult> {
  const pipelineMode = await getConfig('pipeline_mode') || 'image-to-image';

  if (pipelineMode === 'text-to-image') {
    return runTextToImagePipeline(imageOutputFolderId, videoOutputFolderId);
  }
  return runImageToImagePipeline(inputFolderId, imageOutputFolderId, videoOutputFolderId);
}

// ── Image-to-Image Pipeline (async — submit only, webhook handles rest) ────

async function runImageToImagePipeline(
  inputFolderId: string,
  imageOutputFolderId: string,
  _videoOutputFolderId: string
): Promise<PipelineResult> {
  const result: PipelineResult = {
    success: true,
    processed: 0,
    failed: 0,
    errors: [],
    jobIds: [],
  };

  console.log(`[Pipeline] Image-to-Image (async) - input: ${inputFolderId}, image out: ${imageOutputFolderId}`);

  const images = await listImagesInFolder(inputFolderId);
  console.log(`[Pipeline] Found ${images.length} images in input folder`);

  const enhancePrompt = await getConfig('default_image_to_image_prompt') || 'Enhance this image, improve quality, add cinematic lighting';
  const imageAspectRatio = await getConfig('image_aspect_ratio') || 'auto';
  const imageResolution = await getConfig('image_resolution') || '1K';
  const imageOutputFormat = await getConfig('image_output_format') || 'jpg';
  const defaultDuration = parseInt(await getConfig('default_duration') || '10', 10);
  const callbackUrl = getCallbackUrl();

  for (const image of images) {
    if (await isFileProcessed(image.id)) {
      console.log(`[Pipeline] Skipping already processed: ${image.name}`);
      continue;
    }

    const jobId = uuidv4();
    const enhancedName = `enhanced_${image.name.replace(/\.[^.]+$/, '')}.png`;

    try {
      let imageUrl = image.webContentLink;
      if (!imageUrl) {
        imageUrl = await getFileUrl(image.id);
      }

      await createJob({
        id: jobId,
        source_file_name: enhancedName,
        source_file_id: image.id,
        status: 'processing_image',
        kie_task_id: null,
        output_url: null,
        output_file_id: null,
        image_prompt: enhancePrompt,
        image_output_file_id: null,
        image_gen_task_id: null,
        duration: defaultDuration,
        resolution: 'grok-imagine/image-to-video',
        error: null,
      });

      result.jobIds.push(jobId);

      // Submit image enhancement task (async — webhook handles rest)
      console.log(`[Pipeline] Submitting enhancement: ${image.name}`);
      const imageTaskId = await enhanceImage({
        imageUrl,
        prompt: enhancePrompt,
        model: 'nano-banana-2',
        aspectRatio: imageAspectRatio,
        resolution: imageResolution,
        outputFormat: imageOutputFormat,
        callBackUrl: callbackUrl,
      });

      await updateJob(jobId, { image_gen_task_id: imageTaskId });
      result.processed++;
      console.log(`[Pipeline] Image task submitted: ${imageTaskId} (job ${jobId})`);

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[Pipeline] Failed submitting: ${image.name} - ${errorMsg}`);

      if (!(await getJob(jobId))) {
        try {
          await createJob({
            id: jobId,
            source_file_name: enhancedName,
            source_file_id: '',
            status: 'failed',
            kie_task_id: null,
            output_url: null,
            output_file_id: null,
            image_prompt: enhancePrompt,
            image_output_file_id: null,
            image_gen_task_id: null,
            duration: defaultDuration,
            resolution: 'grok-imagine/image-to-video',
            error: errorMsg,
          });
        } catch { /* ignore */ }
      }

      try {
        await updateJob(jobId, { status: 'failed', error: errorMsg, completed_at: new Date().toISOString() });
      } catch { /* ignore */ }

      result.failed++;
      result.errors.push(`${image.name}: ${errorMsg}`);
    }
  }

  result.success = result.failed === 0;
  console.log(`[Pipeline] Image-to-Image done - ${result.processed} submitted, ${result.failed} failed`);
  return result;
}

// ── Text-to-Image Pipeline (async — submit only, webhook handles rest) ──────

async function runTextToImagePipeline(
  imageOutputFolderId: string,
  _videoOutputFolderId: string
): Promise<PipelineResult> {
  const result: PipelineResult = {
    success: true,
    processed: 0,
    failed: 0,
    errors: [],
    jobIds: [],
  };

  console.log(`[Pipeline] Text-to-Image (async) - image out: ${imageOutputFolderId}`);

  const imagePrompt = await getConfig('default_image_prompt') || 'A beautiful cinematic scene, high quality, photorealistic';
  const imageCount = parseInt(await getConfig('image_count') || '1', 10);
  const imageResolution = await getConfig('text_image_resolution') || '1024x1024';
  const defaultDuration = parseInt(await getConfig('default_duration') || '10', 10);
  const callbackUrl = getCallbackUrl();

  const variantSuffixes = ['', 'variant B', 'variant C', 'variant D', 'variant E'];

  for (let i = 0; i < imageCount; i++) {
    const variantSuffix = i < variantSuffixes.length ? ` (${variantSuffixes[i]})` : ` (variant ${i + 1})`;
    const prompt = imagePrompt + variantSuffix;
    const jobId = uuidv4();
    const imageName = `generated_image_${Date.now()}_${i + 1}.png`;

    console.log(`[Pipeline] Submitting image ${i + 1}/${imageCount}: "${prompt.substring(0, 80)}..."`);

    try {
      await createJob({
        id: jobId,
        source_file_name: imageName,
        source_file_id: '',
        status: 'processing_image',
        kie_task_id: null,
        output_url: null,
        output_file_id: null,
        image_prompt: prompt,
        image_output_file_id: null,
        image_gen_task_id: null,
        duration: defaultDuration,
        resolution: 'grok-imagine/image-to-video',
        error: null,
      });

      result.jobIds.push(jobId);

      const imageTaskId = await generateImage({
        prompt,
        model: 'grok-imagine/text-to-image',
        count: 1,
        resolution: imageResolution,
        callBackUrl: callbackUrl,
      });

      await updateJob(jobId, { image_gen_task_id: imageTaskId });
      result.processed++;
      console.log(`[Pipeline] Image task submitted: ${imageTaskId} (job ${jobId})`);

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[Pipeline] Failed submitting ${i + 1}/${imageCount}: ${errorMsg}`);

      if (!(await getJob(jobId))) {
        try {
          await createJob({
            id: jobId,
            source_file_name: imageName,
            source_file_id: '',
            status: 'failed',
            kie_task_id: null,
            output_url: null,
            output_file_id: null,
            image_prompt: prompt,
            image_output_file_id: null,
            image_gen_task_id: null,
            duration: defaultDuration,
            resolution: 'grok-imagine/image-to-video',
            error: errorMsg,
          });
        } catch { /* ignore */ }
      }

      try {
        await updateJob(jobId, { status: 'failed', error: errorMsg, completed_at: new Date().toISOString() });
      } catch { /* ignore */ }

      result.failed++;
      result.errors.push(`${imageName}: ${errorMsg}`);
    }
  }

  result.success = result.failed === 0;
  console.log(`[Pipeline] Text-to-Image done - ${result.processed} submitted, ${result.failed} failed`);
  return result;
}

// ── Retry: video-only (local dev / VPS only — polling exceeds Vercel timeout) ──

export async function retryJobVideo(jobId: string): Promise<{ success: boolean; videoUrl?: string; error?: string }> {
  if (isVercel) {
    return { success: false, error: 'retryJobVideo is not available on Vercel (long polling exceeds serverless timeout). Use locally.' };
  }

  const job = await getJob(jobId);
  if (!job) {
    return { success: false, error: 'Job not found' };
  }

  if (!job.image_output_file_id) {
    return { success: false, error: 'No enhanced/generated image found — cannot retry video-only' };
  }

  const defaultPrompt = await getConfig('default_prompt') || undefined;
  const defaultDuration = parseInt(await getConfig('default_duration') || '10', 10);
  const callbackUrl = getCallbackUrl();
  const videoOutputFolderId = await getConfig('drive_dest_folder');

  if (!videoOutputFolderId) {
    return { success: false, error: 'Video output folder not configured' };
  }

  try {
    await updateJob(jobId, { status: 'processing_video', error: null });

    const driveImageUrl = await getFileUrl(job.image_output_file_id);
    console.log(`[Retry] Got Drive image URL for job ${jobId}`);

    const videoTaskId = await createImageToVideoTask({
      imageUrl: driveImageUrl,
      prompt: defaultPrompt,
      duration: defaultDuration,
      model: 'grok-imagine/image-to-video',
      resolution: '720p',
      callBackUrl: callbackUrl,
    });

    await updateJob(jobId, { kie_task_id: videoTaskId });
    console.log(`[Retry] Video task created: ${videoTaskId}`);

    const videoResult = await checkTaskStatus(videoTaskId);

    if (videoResult.status !== 'success' && videoResult.status !== 'failed') {
      let done = false;
      for (let i = 0; i < 30 && !done; i++) {
        await new Promise((resolve) => setTimeout(resolve, 15000));
        const status = await checkTaskStatus(videoTaskId);
        console.log(`[Retry] Poll ${i + 1}/30: ${videoTaskId} = ${status.status}`);
        if (status.status === 'success' || status.status === 'failed') {
          Object.assign(videoResult, status);
          done = true;
        }
      }
    }

    if (videoResult.status !== 'success' || (!videoResult.outputUrl && !videoResult.outputUrls?.length)) {
      throw new Error(videoResult.error || 'Video generation failed');
    }

    const videoUrl = videoResult.outputUrl || videoResult.outputUrls![0];

    const videoBuffer = await downloadVideo(videoUrl);
    const videoName = job.source_file_name.replace(/\.[^.]+$/, '') + '_video.mp4';
    const uploadedVideoId = await uploadFile(videoOutputFolderId, videoName, videoBuffer, 'video/mp4');

    await updateJob(jobId, {
      status: 'completed',
      output_url: videoUrl,
      output_file_id: uploadedVideoId,
      completed_at: new Date().toISOString(),
    });

    console.log(`[Retry] Job ${jobId} completed: ${videoName}`);
    return { success: true, videoUrl };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Retry] Job ${jobId} failed: ${errorMsg}`);

    await updateJob(jobId, { status: 'failed', error: errorMsg, completed_at: new Date().toISOString() });

    return { success: false, error: errorMsg };
  }
}

// ── Manual sync: advance stuck job (local dev / VPS only) ──────

export async function syncJob(jobId: string): Promise<{ success: boolean; status: string; error?: string }> {
  if (isVercel) {
    return { success: false, status: 'blocked', error: 'syncJob is not available on Vercel (long polling exceeds serverless timeout). Use locally.' };
  }

  const job = await getJob(jobId);
  if (!job) {
    return { success: false, status: 'not_found', error: 'Job not found' };
  }

  // ── Image phase: poll image task, then trigger video ──
  if ((job.status === 'processing_image' || job.status === 'pending') && job.image_gen_task_id) {
    try {
      const { pollImageTaskCompletion, downloadImage } = await import('./kie');

      console.log(`[Sync] Polling image task: ${job.image_gen_task_id}`);
      const imageResult = await pollImageTaskCompletion(job.image_gen_task_id, 60, 10000);

      if (imageResult.status !== 'success' || imageResult.imageUrls.length === 0) {
        await updateJob(jobId, {
          status: 'failed',
          error: imageResult.error || 'Image task failed',
          completed_at: new Date().toISOString(),
        });
        return { success: false, status: 'failed', error: imageResult.error || 'Image task failed' };
      }

      const imageUrl = imageResult.imageUrls[0];
      const imageBuffer = await downloadImage(imageUrl);
      const imageOutputFolderId = await getConfig('drive_image_output_folder') || await getConfig('drive_source_folder') || '';
      const uploadedImageId = await uploadFile(imageOutputFolderId, job.source_file_name, imageBuffer, 'image/png');
      console.log(`[Sync] Image uploaded: ${uploadedImageId}`);

      await updateJob(jobId, { image_output_file_id: uploadedImageId, source_file_id: uploadedImageId });
      await markFileProcessed(job.source_file_id);

      const driveImageUrl = await getFileUrl(uploadedImageId);
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

      await updateJob(jobId, { kie_task_id: videoTaskId, status: 'processing_video' });
      console.log(`[Sync] Video task created: ${videoTaskId}`);
      return { success: true, status: 'processing_video' };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await updateJob(jobId, { status: 'failed', error: msg, completed_at: new Date().toISOString() });
      return { success: false, status: 'failed', error: msg };
    }
  }

  // ── Video phase: poll video task, then finalize ──
  if (job.status === 'processing_video' && job.kie_task_id) {
    try {
      console.log(`[Sync] Polling video task: ${job.kie_task_id}`);
      const videoResult = await checkTaskStatus(job.kie_task_id);

      if (videoResult.status !== 'success' && videoResult.status !== 'failed') {
        for (let i = 0; i < 30; i++) {
          await new Promise((resolve) => setTimeout(resolve, 15000));
          const status = await checkTaskStatus(job.kie_task_id!);
          console.log(`[Sync] Poll ${i + 1}/30: ${job.kie_task_id} = ${status.status}`);
          if (status.status === 'success' || status.status === 'failed') {
            Object.assign(videoResult, status);
            break;
          }
        }
      }

      if (videoResult.status !== 'success' || (!videoResult.outputUrl && !videoResult.outputUrls?.length)) {
        await updateJob(jobId, {
          status: 'failed',
          error: videoResult.error || 'Video generation failed',
          completed_at: new Date().toISOString(),
        });
        return { success: false, status: 'failed', error: videoResult.error || 'Video generation failed' };
      }

      const videoUrl = videoResult.outputUrl || videoResult.outputUrls![0];
      const videoBuffer = await downloadVideo(videoUrl);
      const videoOutputFolderId = await getConfig('drive_dest_folder') || '';
      const videoName = job.source_file_name.replace(/\.[^.]+$/, '') + '_video.mp4';
      const uploadedVideoId = await uploadFile(videoOutputFolderId, videoName, videoBuffer, 'video/mp4');

      await updateJob(jobId, {
        status: 'completed',
        output_url: videoUrl,
        output_file_id: uploadedVideoId,
        completed_at: new Date().toISOString(),
      });

      console.log(`[Sync] Job ${jobId} completed: ${videoName}`);
      return { success: true, status: 'completed' };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await updateJob(jobId, { status: 'failed', error: msg, completed_at: new Date().toISOString() });
      return { success: false, status: 'failed', error: msg };
    }
  }

  return { success: false, status: 'skipped', error: 'Job not in syncable state' };
}
