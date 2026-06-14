import { NextResponse } from 'next/server';
import { executePipeline } from '@/lib/scheduler';
import { getConfig } from '@/lib/db';

export const runtime = 'nodejs';

// Vercel Cron Job endpoint
// Set up in Vercel dashboard: vercel.json cron or Vercel project settings
// Example vercel.json:
// { "crons": [{ "path": "/api/cron", "schedule": "0 8 * * *" }] }

export async function GET() {
  try {
    const schedulerRunning = await getConfig('scheduler_running');
    if (schedulerRunning === 'false') {
      return NextResponse.json({ skipped: true, reason: 'scheduler_running is false' });
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
