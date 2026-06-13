'use client';

import { useState, useEffect, useCallback } from 'react';

interface ConfigData {
  config: Record<string, string>;
  driveReady: boolean;
  folders: { id: string; name: string }[];
}

export default function ConfigPanel() {
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [authCode, setAuthCode] = useState('');
  const [authUrl, setAuthUrl] = useState('');
  const [authenticating, setAuthenticating] = useState(false);

  const [form, setForm] = useState({
    kie_api_key: '',
    pipeline_mode: 'image-to-image',
    google_client_id: '',
    google_client_secret: '',
    drive_input_folder: '',
    drive_image_output_folder: '',
    drive_dest_folder: '',
    default_image_to_image_prompt: 'Enhance this image, improve quality, add cinematic lighting and detail',
    default_image_prompt: 'A beautiful cinematic scene, high quality, photorealistic',
    image_count: '1',
    image_resolution: '1K',
    image_aspect_ratio: 'auto',
    image_output_format: 'jpg',
    text_image_resolution: '1024x1024',
    default_prompt: '',
    default_duration: '10',
    schedule_cron: '0 8 * * *',
    schedule_timezone: 'Asia/Jakarta',
  });

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/config');
      const data: ConfigData = await res.json();
      setConfig(data);
      if (data.config) {
        setForm((prev) => ({ ...prev, ...data.config }));
      }
      if (!data.driveReady) {
        await fetchDriveAuth();
      }
    } catch (err) {
      console.error('Failed to load config:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchDriveAuth = async () => {
    try {
      const res = await fetch('/api/drive');
      const data = await res.json();
      if (data.authUrl) {
        setAuthUrl(data.authUrl);
      }
    } catch (err) {
      console.error('Failed to get auth URL:', err);
    }
  };

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const handleSave = async () => {
    setSaving(true);
    setMessage('');
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (data.success) {
        setMessage('Settings saved successfully!');
      } else {
        setMessage('Error: ' + (data.error || 'Failed to save'));
      }
    } catch (err) {
      setMessage('Error saving settings');
    } finally {
      setSaving(false);
    }
  };

  const handleAuth = async () => {
    if (!authCode) return;
    setAuthenticating(true);
    try {
      const res = await fetch('/api/drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: authCode }),
      });
      const data = await res.json();
      if (data.success) {
        setMessage('Google Drive connected successfully!');
        setAuthCode('');
        fetchConfig();
      } else {
        setMessage('Auth failed: ' + (data.error || 'Unknown error'));
      }
    } catch (err) {
      setMessage('Authentication failed');
    } finally {
      setAuthenticating(false);
    }
  };

  const updateField = (field: string, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  if (loading) {
    return (
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6">
        <p className="text-zinc-500">Loading settings...</p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 space-y-6">
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Settings</h2>

      {message && (
        <div className={`p-3 rounded-lg text-sm ${
          message.includes('success') || message.includes('connected')
            ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
            : 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300'
        }`}>
          {message}
        </div>
      )}

      {/* KIE AI Section */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-zinc-500 uppercase tracking-wider">KIE AI API</h3>
        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
            API Key
          </label>
          <input
            type="password"
            value={form.kie_api_key}
            onChange={(e) => updateField('kie_api_key', e.target.value)}
            placeholder="sk-..."
            className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
          />
          <p className="text-xs text-zinc-400 mt-1">
            Get your key at{' '}
            <a href="https://kie.ai/api-key" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">
              kie.ai/api-key
            </a>
          </p>
        </div>

        <div className="p-3 bg-zinc-50 dark:bg-zinc-800/50 rounded-lg text-xs text-zinc-500">
          Models: <strong>Nano Banana 2</strong> (image) &middot; <strong>Grok Imagine</strong> (video @ 720p)
        </div>
      </div>

      {/* Google Drive Section */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-zinc-500 uppercase tracking-wider">Google Drive</h3>
        {!config?.driveReady && (
          <div className="p-4 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800 space-y-3">
            <p className="text-sm text-amber-700 dark:text-amber-300">
              Google Drive needs to be connected first. Enter your OAuth credentials below.
            </p>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Client ID</label>
              <input type="text" value={form.google_client_id} onChange={(e) => updateField('google_client_id', e.target.value)} placeholder="xxx.apps.googleusercontent.com" className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Client Secret</label>
              <input type="password" value={form.google_client_secret} onChange={(e) => updateField('google_client_secret', e.target.value)} placeholder="GOCSPX-..." className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none" />
            </div>
            <button onClick={handleSave} disabled={saving} className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
              {saving ? 'Saving...' : 'Save OAuth Credentials'}
            </button>
            {authUrl && form.google_client_id && form.google_client_secret && (
              <div className="mt-2 space-y-2">
                <p className="text-sm text-zinc-600 dark:text-zinc-400">1. Open this URL to authorize:</p>
                <a href={authUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-500 hover:underline break-all block">{authUrl.substring(0, 80)}...</a>
                <p className="text-sm text-zinc-600 dark:text-zinc-400">2. Paste the authorization code here:</p>
                <input type="text" value={authCode} onChange={(e) => setAuthCode(e.target.value)} placeholder="4/0A..." className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none" />
                <button onClick={handleAuth} disabled={authenticating || !authCode} className="px-4 py-2 bg-emerald-600 text-white text-sm rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors">
                  {authenticating ? 'Connecting...' : 'Connect Google Drive'}
                </button>
              </div>
            )}
          </div>
        )}

        {config?.driveReady && (
          <div className="p-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg border border-emerald-200 dark:border-emerald-800 text-sm text-emerald-700 dark:text-emerald-300">
            Google Drive connected
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Input Folder ID (original images)</label>
          <input type="text" value={form.drive_input_folder} onChange={(e) => updateField('drive_input_folder', e.target.value)} placeholder="Google Drive folder ID" className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none" />
          {config?.folders && config.folders.length > 0 && (
            <select onChange={(e) => updateField('drive_input_folder', e.target.value)} className="mt-1 w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm">
              <option value="">Select a folder...</option>
              {config.folders.map((f) => (<option key={f.id} value={f.id}>{f.name}</option>))}
            </select>
          )}
          <p className="text-xs text-zinc-400 mt-1">Source images to enhance (image-to-image mode only).</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Image Output Folder ID</label>
          <input type="text" value={form.drive_image_output_folder} onChange={(e) => updateField('drive_image_output_folder', e.target.value)} placeholder="Google Drive folder ID" className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none" />
          {config?.folders && config.folders.length > 0 && (
            <select onChange={(e) => updateField('drive_image_output_folder', e.target.value)} className="mt-1 w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm">
              <option value="">Select a folder...</option>
              {config.folders.map((f) => (<option key={f.id} value={f.id}>{f.name}</option>))}
            </select>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Video Output Folder ID</label>
          <input type="text" value={form.drive_dest_folder} onChange={(e) => updateField('drive_dest_folder', e.target.value)} placeholder="Google Drive folder ID" className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none" />
        </div>
      </div>

      {/* Image Pipeline */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-zinc-500 uppercase tracking-wider">Image Pipeline</h3>

        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Pipeline Mode</label>
          <select value={form.pipeline_mode} onChange={(e) => updateField('pipeline_mode', e.target.value)} className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm">
            <option value="image-to-image">Image-to-Image — enhance input images</option>
            <option value="text-to-image">Text-to-Image — generate from prompt</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
            {form.pipeline_mode === 'image-to-image' ? 'Enhancement Prompt' : 'Image Prompt'}
          </label>
          <textarea
            value={form.pipeline_mode === 'image-to-image' ? form.default_image_to_image_prompt : form.default_image_prompt}
            onChange={(e) => {
              if (form.pipeline_mode === 'image-to-image') updateField('default_image_to_image_prompt', e.target.value);
              else updateField('default_image_prompt', e.target.value);
            }}
            rows={3}
            className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none resize-none"
          />
        </div>

        {form.pipeline_mode === 'image-to-image' && (
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Aspect Ratio</label>
              <select value={form.image_aspect_ratio} onChange={(e) => updateField('image_aspect_ratio', e.target.value)} className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm">
                <option value="auto">Auto</option>
                <option value="1:1">1:1</option>
                <option value="16:9">16:9</option>
                <option value="9:16">9:16</option>
                <option value="4:3">4:3</option>
                <option value="3:4">3:4</option>
                <option value="21:9">21:9</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Resolution</label>
              <select value={form.image_resolution} onChange={(e) => updateField('image_resolution', e.target.value)} className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm">
                <option value="1K">1K</option>
                <option value="2K">2K</option>
                <option value="4K">4K</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Format</label>
              <select value={form.image_output_format} onChange={(e) => updateField('image_output_format', e.target.value)} className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm">
                <option value="jpg">JPG</option>
                <option value="png">PNG</option>
              </select>
            </div>
          </div>
        )}

        {form.pipeline_mode === 'text-to-image' && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Number of Images</label>
              <input type="number" min="1" max="10" step="1" value={form.image_count} onChange={(e) => updateField('image_count', e.target.value)} className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Resolution</label>
              <select value={form.text_image_resolution} onChange={(e) => updateField('text_image_resolution', e.target.value)} className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm">
                <option value="1024x1024">1024x1024</option>
                <option value="1792x1024">1792x1024</option>
                <option value="1024x1792">1024x1792</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Video Generation */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-zinc-500 uppercase tracking-wider">Video Generation (Grok @ 720p)</h3>

        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Prompt</label>
          <textarea value={form.default_prompt} onChange={(e) => updateField('default_prompt', e.target.value)} placeholder="Generate a smooth, cinematic video from this image" rows={2} className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none resize-none" />
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Duration (6-30 seconds)</label>
          <input type="number" min="6" max="30" step="1" value={form.default_duration} onChange={(e) => updateField('default_duration', e.target.value)} className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm" />
        </div>
      </div>

      {/* Schedule */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-zinc-500 uppercase tracking-wider">Schedule</h3>
        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Cron Expression</label>
          <input type="text" value={form.schedule_cron} onChange={(e) => updateField('schedule_cron', e.target.value)} className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none font-mono" />
          <p className="text-xs text-zinc-400 mt-1">Default: 0 8 * * * (daily at 8:00 AM)</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Timezone</label>
          <input type="text" value={form.schedule_timezone} onChange={(e) => updateField('schedule_timezone', e.target.value)} placeholder="Asia/Jakarta" className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none" />
        </div>
      </div>

      <button onClick={handleSave} disabled={saving} className="w-full py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
        {saving ? 'Saving...' : 'Save All Settings'}
      </button>
    </div>
  );
}
