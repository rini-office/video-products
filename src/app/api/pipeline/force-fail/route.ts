import { NextRequest, NextResponse } from 'next/server';
import { updateJob, getJob } from '@/lib/db';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const { jobId } = await request.json();

    if (!jobId || typeof jobId !== 'string') {
      return NextResponse.json({ error: 'jobId is required' }, { status: 400 });
    }

    const job = getJob(jobId);
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    if (job.status !== 'processing_image' && job.status !== 'processing_video') {
      return NextResponse.json({ error: 'Job is not stuck in processing state' }, { status: 422 });
    }

    updateJob(jobId, {
      status: 'failed',
      error: 'Manually marked as failed (stuck)',
      completed_at: new Date().toISOString(),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
