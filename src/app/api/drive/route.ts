import { NextRequest, NextResponse } from 'next/server';
import { getAuthUrl, handleAuthCallback, isAuthenticated } from '@/lib/drive';

export const runtime = 'nodejs';

export async function GET() {
  try {
    if (!(await isAuthenticated())) {
      const url = await getAuthUrl();
      return NextResponse.json({ authUrl: url, authenticated: false });
    }
    return NextResponse.json({ authenticated: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (body.code) {
      await handleAuthCallback(body.code);
      return NextResponse.json({ success: true, authenticated: true });
    }
    return NextResponse.json({ error: 'Authorization code required' }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
