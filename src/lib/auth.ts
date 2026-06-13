import crypto from 'crypto';

export function signToken(username: string): string {
  const secret = process.env.AUTH_SECRET || 'dev-secret-change-me';
  const timestamp = Date.now().toString();
  const data = `${username}:${timestamp}`;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(data);
  return `${data}:${hmac.digest('hex')}`;
}

export function verifyToken(token: string): boolean {
  const secret = process.env.AUTH_SECRET || 'dev-secret-change-me';
  const parts = token.split(':');
  if (parts.length !== 3) return false;

  const [, timestamp, signature] = parts;

  // Expiry: 24 hours
  const age = Date.now() - parseInt(timestamp, 10);
  if (age > 24 * 60 * 60 * 1000) return false;

  const data = `${parts[0]}:${timestamp}`;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(data);
  const expected = hmac.digest('hex');

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
