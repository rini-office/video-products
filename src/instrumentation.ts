export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startScheduler } = await import('@/lib/scheduler');
    const { getConfig } = await import('@/lib/db');

    const wasRunning = await getConfig('scheduler_running');
    if (wasRunning !== 'false') {
      await startScheduler();
    }
  }
}
