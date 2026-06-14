import { google } from 'googleapis';
import { getConfig, setConfig } from './db';

const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
];

async function getOAuth2Client() {
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
    // Event handler for token refresh — these setConfig calls are fire-and-forget
    oauth2Client.on('tokens', (tokens) => {
      if (tokens.refresh_token) {
        setConfig('google_refresh_token', tokens.refresh_token).catch(() => {});
      }
      if (tokens.access_token) {
        setConfig('google_access_token', tokens.access_token).catch(() => {});
      }
    });
  }

  return oauth2Client;
}

export async function getAuthUrl(): Promise<string> {
  const oauth2Client = await getOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
}

export async function handleAuthCallback(code: string): Promise<void> {
  const oauth2Client = await getOAuth2Client();
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

  const response = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false and mimeType contains 'image/'`,
    fields: 'files(id, name, mimeType, webContentLink)',
    pageSize: 100,
    orderBy: 'createdTime desc',
  });

  return (response.data.files || []).filter((f): f is { id: string; name: string; mimeType: string; webContentLink?: string } =>
    !!f.id && !!f.name && !!f.mimeType
  );
}

export async function listFolders(): Promise<{ id: string; name: string }[]> {
  const auth = await getOAuth2Client();
  const drive = google.drive({ version: 'v3', auth });

  const response = await drive.files.list({
    q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    fields: 'files(id, name)',
    pageSize: 50,
  });

  return (response.data.files || []).filter((f): f is { id: string; name: string } =>
    !!f.id && !!f.name
  );
}

export async function downloadFile(fileId: string): Promise<{ buffer: Buffer; name: string; mimeType: string }> {
  const auth = await getOAuth2Client();
  const drive = google.drive({ version: 'v3', auth });

  const meta = await drive.files.get({ fileId, fields: 'name,mimeType' });
  const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });

  return {
    buffer: Buffer.from(response.data as ArrayBuffer),
    name: meta.data.name || 'unknown',
    mimeType: meta.data.mimeType || 'application/octet-stream',
  };
}

export async function uploadFile(
  folderId: string,
  fileName: string,
  buffer: Buffer,
  mimeType: string
): Promise<string> {
  const auth = await getOAuth2Client();
  const drive = google.drive({ version: 'v3', auth });

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
}

export async function getFileUrl(fileId: string): Promise<string> {
  const auth = await getOAuth2Client();
  const drive = google.drive({ version: 'v3', auth });

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
}
