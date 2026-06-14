import { NextRequest, NextResponse } from 'next/server';
import { getAllConfig, setConfig } from '@/lib/db';
import { isAuthenticated, listFolders } from '@/lib/drive';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const config = await getAllConfig();
    const driveReady = await isAuthenticated();

    let folders: { id: string; name: string }[] = [];
    if (driveReady) {
      try {
        folders = await listFolders();
      } catch {
        // Folders might not be loadable if token expired
      }
    }

    return NextResponse.json({
      config: {
        kie_api_key: config.kie_api_key ? '••••••••' : '',
        pipeline_mode: config.pipeline_mode || 'image-to-image',
        drive_input_folder: config.drive_input_folder || config.drive_source_folder || '',
        drive_image_output_folder: config.drive_image_output_folder || config.drive_source_folder || '',
        drive_dest_folder: config.drive_dest_folder || '',
        default_image_to_image_prompt: config.default_image_to_image_prompt || '',
        default_image_prompt: config.default_image_prompt || '',
        image_count: config.image_count || '1',
        image_resolution: config.image_resolution || '1K',
        image_aspect_ratio: config.image_aspect_ratio || 'auto',
        image_output_format: config.image_output_format || 'jpg',
        text_image_resolution: config.text_image_resolution || '1024x1024',
        default_prompt: config.default_prompt || '',
        default_duration: config.default_duration || '10',
        schedule_cron: config.schedule_cron || '0 8 * * *',
        schedule_timezone: config.schedule_timezone || 'Asia/Jakarta',
        google_client_id: config.google_client_id || '',
        google_client_secret: config.google_client_secret ? '••••••••' : '',
      },
      driveReady,
      folders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const fields = [
      'kie_api_key',
      'pipeline_mode',
      'google_client_id',
      'google_client_secret',
      'drive_source_folder',
      'drive_input_folder',
      'drive_image_output_folder',
      'drive_dest_folder',
      'default_image_to_image_prompt',
      'default_image_prompt',
      'image_count',
      'image_resolution',
      'image_aspect_ratio',
      'image_output_format',
      'text_image_resolution',
      'default_prompt',
      'default_duration',
      'schedule_cron',
      'schedule_timezone',
    ];

    for (const field of fields) {
      if (body[field] !== undefined && body[field] !== '' && !body[field].includes('••••')) {
        await setConfig(field, body[field]);
      }
    }

    // Handle scheduler control (local dev / VPS only)
    if (body.action === 'start_scheduler') {
      await setConfig('scheduler_running', 'true');
      const { startScheduler } = await import('@/lib/scheduler');
      await startScheduler();
      return NextResponse.json({ success: true, schedulerStarted: true });
    }

    if (body.action === 'stop_scheduler') {
      await setConfig('scheduler_running', 'false');
      const { stopScheduler } = await import('@/lib/scheduler');
      stopScheduler();
      return NextResponse.json({ success: true, schedulerStopped: true });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
