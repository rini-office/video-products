import { runPipeline } from './pipeline';
import { getConfig, setConfig } from './db';

let isRunning = false;
const isVercel = !!process.env.VERCEL;

export async function startScheduler(): Promise<void> {
  if (isVercel) {
    console.log('[Scheduler] Running on Vercel — use Vercel Cron Jobs (see /api/cron)');
  } else {
    console.log('[Scheduler] Local dev — trigger pipeline via /api/cron or /api/pipeline/trigger');
  }
}

export async function executePipeline(): Promise<void> {
  console.log(`[Scheduler] Triggering pipeline at ${new Date().toISOString()}`);

  const inputFolderId = await getConfig('drive_input_folder') || await getConfig('drive_source_folder');
  const imageOutputFolderId = await getConfig('drive_image_output_folder') || await getConfig('drive_source_folder');
  const videoOutputFolderId = await getConfig('drive_dest_folder');

  if (!imageOutputFolderId || !videoOutputFolderId) {
    console.error('[Scheduler] Image output or video output folder not configured');
    return;
  }

  try {
    isRunning = true;
    await setConfig('last_run', new Date().toISOString());
    const result = await runPipeline(inputFolderId || '', imageOutputFolderId, videoOutputFolderId);
    await setConfig('last_run_status', result.success ? 'completed' : 'failed');
    await setConfig('last_run_summary', JSON.stringify(result));
    console.log(`[Scheduler] Pipeline completed: ${result.processed} processed, ${result.failed} failed`);
  } catch (error) {
    console.error('[Scheduler] Pipeline error:', error);
    await setConfig('last_run_status', 'error');
    await setConfig('last_run_error', String(error));
  } finally {
    isRunning = false;
  }
}

export function stopScheduler(): void {
  console.log('[Scheduler] Stop requested — use Vercel dashboard to disable Cron Jobs');
}

export function restartScheduler(): void {
  startScheduler();
}

export async function getSchedulerStatus(): Promise<{
  running: boolean;
  cronExpression: string | undefined;
  pipelineRunning: boolean;
  lastRun: string | undefined;
  lastRunStatus: string | undefined;
}> {
  return {
    running: true, // Always "ready" — actual schedule is managed by Vercel Cron Jobs
    cronExpression: await getConfig('schedule_cron') || '0 8 * * *',
    pipelineRunning: isRunning,
    lastRun: await getConfig('last_run'),
    lastRunStatus: await getConfig('last_run_status'),
  };
}
