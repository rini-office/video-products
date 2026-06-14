import { NextRequest, NextResponse } from 'next/server';
import { executePipeline } from '@/lib/scheduler';
import { getConfig } from '@/lib/db';
import { shouldRunCron, getNextCronTime } from '@/lib/cron';

export const runtime = 'nodejs';

// Vercel Cron Job endpoint — called every ~5 min by cron-job.org, checks schedule_cron from DB

export async function GET(request: NextRequest) {
  try {
    // Verify CRON_SECRET
    const authHeader = request.headers.get('Authorization');
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const schedulerRunning = await getConfig('scheduler_running');
    if (schedulerRunning === 'false') {
      return NextResponse.json({ skipped: true, reason: 'scheduler stopped' });
    }

    const cronExpression = await getConfig('schedule_cron') || '0 8 * * *';
    const timezone = await getConfig('schedule_timezone') || 'Asia/Jakarta';
    const lastRun = await getConfig('last_run');

    if (!shouldRunCron(cronExpression, lastRun, new Date(), timezone)) {
      // Calculate next run for info
      const nextRun = getNextCronTime(cronExpression, new Date(), timezone);
      return NextResponse.json({
        skipped: true,
        reason: 'not yet',
        nextRun: nextRun.toISOString(),
      });
    }

    await executePipeline();

    const lastRunStatus = await getConfig('last_run_status') || 'unknown';
    return NextResponse.json({ success: true, status: lastRunStatus });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Cron] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
