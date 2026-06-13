import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATHS = ['/login', '/api/auth/login', '/api/webhook/kie'];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname.startsWith(p)) ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon');
}

function bytesToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function verifyToken(token: string): Promise<boolean> {
  const parts = token.split(':');
  if (parts.length !== 3) return false;

  const [username, timestamp, signatureHex] = parts;

  // Expiry: 24 hours
  const age = Date.now() - parseInt(timestamp, 10);
  if (age > 24 * 60 * 60 * 1000) return false;

  const secret = process.env.AUTH_SECRET || 'dev-secret-change-me';
  const data = `${username}:${timestamp}`;
  const enc = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );

  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  const expectedHex = bytesToHex(sig);

  if (signatureHex.length !== expectedHex.length) return false;
  return signatureHex === expectedHex;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const token = request.cookies.get('auth_token')?.value;

  if (!token || !(await verifyToken(token))) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
