import { NextRequest, NextResponse } from 'next/server';
import { syncJob } from '@/lib/pipeline';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const { jobId } = await request.json();

    if (!jobId || typeof jobId !== 'string') {
      return NextResponse.json({ error: 'jobId is required' }, { status: 400 });
    }

    // WARNING: syncJob polls KIE tasks (up to 10 min for image, 7.5 min for video)
    // Only use for local dev or VPS. Not suitable for Vercel serverless.
    const result = await syncJob(jobId);

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
