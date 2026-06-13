import { NextRequest, NextResponse } from 'next/server';
import { retryJobVideo } from '@/lib/pipeline';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const { jobId } = await request.json();

    if (!jobId || typeof jobId !== 'string') {
      return NextResponse.json({ error: 'jobId is required' }, { status: 400 });
    }

    const result = await retryJobVideo(jobId);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 422 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
