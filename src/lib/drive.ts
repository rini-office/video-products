import { google } from 'googleapis';
import { getConfig, setConfig } from './db';

const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
];

/**
 * Checks if an error is a Google OAuth2 `invalid_grant` error
 * (token expired or revoked). Handles nested error structures from the
 * googleapis library, gaxios, and minified Next.js builds.
 */
function isInvalidGrantError(error: unknown): boolean {
  const err = error as Record<string, unknown> | null;
  if (!err) return false;

  // Direct message field
  if (err.message === 'invalid_grant') return true;

  // Nested cause (gaxios pattern)
  const cause = err.cause as Record<string, unknown> | null;
  if (cause?.message === 'invalid_grant') return true;

  // Response data (googleapis pattern)
  const response = err.response as Record<string, unknown> | null;
  const data = response?.data as Record<string, unknown> | null;
  if (data?.error === 'invalid_grant') return true;

  // Error string representation
  const str = String(err.message ?? err).toLowerCase();
  return str.includes('invalid_grant');
}

/**
 * Clears the stored Google OAuth2 refresh token from the database.
 * Called when the token is detected as invalid/expired/revoked.
 */
async function clearInvalidToken(): Promise<void> {
  try {
    await setConfig('google_refresh_token', '');
    await setConfig('google_access_token', '');
    console.log('[Drive] Cleared invalid Google OAuth tokens from config');
  } catch (e) {
    console.error('[Drive] Failed to clear invalid tokens:', e);
  }
}

export const AUTH_EXPIRED_MESSAGE =
  'Google Drive authentication has expired or been revoked. ' +
  'Please re-authenticate via the web dashboard Settings page.';

/**
 * Wraps a Drive API call with `invalid_grant` error handling.
 * Safety net for the rare TOCTOU case where the token is valid during
 * `getAccessToken()` validation but becomes invalid before the actual
 * Drive API call (e.g. concurrent revocation).
 */
async function withInvalidGrantGuard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error: unknown) {
    if (isInvalidGrantError(error)) {
      await clearInvalidToken();
      throw new Error(AUTH_EXPIRED_MESSAGE);
    }
    throw error;
  }
}

interface GetOAuth2ClientOptions {
  /**
   * Whether to proactively validate the refresh token by fetching an access
   * token. Default: true. Set to false for operations that don't require
   * a valid token (e.g. generating an auth URL for re-authentication).
   */
  validate?: boolean;
}

async function getOAuth2Client({ validate = true }: GetOAuth2ClientOptions = {}) {
  const clientId = await getConfig('google_client_id');
  const clientSecret = await getConfig('google_client_secret');
  const refreshToken = await getConfig('google_refresh_token');

  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth credentials not configured. Please set google_client_id and google_client_secret.');
  }

  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    process.env.NEXT_PUBLIC_APP_URL
      ? `${process.env.NEXT_PUBLIC_APP_URL}/api/drive/auth-callback`
      : 'http://localhost:3000/api/drive/auth-callback'
  );

  if (refreshToken) {
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    // Register event handler BEFORE getAccessToken() so token refresh events
    // from the validation call are captured and persisted to the database.
    oauth2Client.on('tokens', (tokens) => {
      if (tokens.refresh_token) {
        setConfig('google_refresh_token', tokens.refresh_token).catch(() => {});
      }
      if (tokens.access_token) {
        setConfig('google_access_token', tokens.access_token).catch(() => {});
      }
    });

    if (validate) {
      // Proactively validate the refresh token by forcing an access token fetch.
      // If the token is expired/revoked, Google returns `invalid_grant` and we
      // clear the stored token so the dashboard shows "not connected" immediately.
      try {
        await oauth2Client.getAccessToken();
      } catch (error: unknown) {
        if (isInvalidGrantError(error)) {
          await clearInvalidToken();
          throw new Error(AUTH_EXPIRED_MESSAGE);
        }
        // Other errors (network, Google outage) — don't clear the token
        throw error;
      }
    }
  }

  return oauth2Client;
}

export async function getAuthUrl(): Promise<string> {
  // Skip validation: generating an auth URL doesn't require a valid token,
  // and we need this to work even when the token is expired (re-auth flow).
  const oauth2Client = await getOAuth2Client({ validate: false });
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
}

export async function handleAuthCallback(code: string): Promise<void> {
  // Skip validation: we're exchanging an auth code for NEW tokens.
  // The old token state is irrelevant and may be expired (re-auth flow).
  const oauth2Client = await getOAuth2Client({ validate: false });
  const { tokens } = await oauth2Client.getToken(code);
  if (tokens.refresh_token) {
    await setConfig('google_refresh_token', tokens.refresh_token);
  }
  if (tokens.access_token) {
    await setConfig('google_access_token', tokens.access_token);
  }
}

export async function isAuthenticated(): Promise<boolean> {
  return !!(await getConfig('google_refresh_token'));
}

export async function listImagesInFolder(folderId: string): Promise<{ id: string; name: string; mimeType: string; webContentLink?: string }[]> {
  const auth = await getOAuth2Client();
  const drive = google.drive({ version: 'v3', auth });

  return withInvalidGrantGuard(async () => {
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false and mimeType contains 'image/'`,
      fields: 'files(id, name, mimeType, webContentLink)',
      pageSize: 100,
      orderBy: 'createdTime desc',
    });

    return (response.data.files || []).filter((f): f is { id: string; name: string; mimeType: string; webContentLink?: string } =>
      !!f.id && !!f.name && !!f.mimeType
    );
  });
}

export async function listFolders(): Promise<{ id: string; name: string }[]> {
  const auth = await getOAuth2Client();
  const drive = google.drive({ version: 'v3', auth });

  return withInvalidGrantGuard(async () => {
    const response = await drive.files.list({
      q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      fields: 'files(id, name)',
      pageSize: 50,
    });

    return (response.data.files || []).filter((f): f is { id: string; name: string } =>
      !!f.id && !!f.name
    );
  });
}

export async function downloadFile(fileId: string): Promise<{ buffer: Buffer; name: string; mimeType: string }> {
  const auth = await getOAuth2Client();
  const drive = google.drive({ version: 'v3', auth });

  return withInvalidGrantGuard(async () => {
    const meta = await drive.files.get({ fileId, fields: 'name,mimeType' });
    const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });

    return {
      buffer: Buffer.from(response.data as ArrayBuffer),
      name: meta.data.name || 'unknown',
      mimeType: meta.data.mimeType || 'application/octet-stream',
    };
  });
}

export async function uploadFile(
  folderId: string,
  fileName: string,
  buffer: Buffer,
  mimeType: string
): Promise<string> {
  const auth = await getOAuth2Client();
  const drive = google.drive({ version: 'v3', auth });

  return withInvalidGrantGuard(async () => {
    const response = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [folderId],
        mimeType,
      },
      media: {
        mimeType,
        body: require('stream').Readable.from(buffer),
      },
      fields: 'id',
    });

    return response.data.id!;
  });
}

export async function getFileUrl(fileId: string): Promise<string> {
  const auth = await getOAuth2Client();
  const drive = google.drive({ version: 'v3', auth });

  return withInvalidGrantGuard(async () => {
    await drive.permissions.create({
      fileId,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
    });

    const meta = await drive.files.get({
      fileId,
      fields: 'webContentLink',
    });

    if (meta.data.webContentLink) {
      return meta.data.webContentLink;
    }

    return `https://drive.google.com/uc?export=download&id=${fileId}`;
  });
}

/**
 * Gets a readable URL for a Drive file WITHOUT modifying its permissions.
 * Use when the app doesn't own the file (e.g. reading original input files
 * for "ulang" re-processing). Read-only — no write access required.
 */
export async function getFileReadUrl(fileId: string): Promise<string> {
  const auth = await getOAuth2Client();
  const drive = google.drive({ version: 'v3', auth });

  return withInvalidGrantGuard(async () => {
    // Try webContentLink first (no permission change needed)
    const meta = await drive.files.get({
      fileId,
      fields: 'webContentLink',
    });

    if (meta.data.webContentLink) {
      return meta.data.webContentLink;
    }

    // Fallback: direct download URL (works if file is shared with the authenticated user)
    return `https://drive.google.com/uc?export=download&id=${fileId}`;
  });
}
