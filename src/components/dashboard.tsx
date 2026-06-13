'use client';

import { useState, useEffect, useCallback } from 'react';
import ConfigPanel from './config-panel';
import JobList from './job-list';

interface Stats {
  total: number;
  completed: number;
  failed: number;
  processing_image: number;
  processing_video: number;
}

interface SchedulerInfo {
  running: boolean;
  cronExpression: string;
  pipelineRunning: boolean;
  lastRun: string;
  lastRunStatus: string;
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats>({ total: 0, completed: 0, failed: 0, processing_image: 0, processing_video: 0 });
  const [scheduler, setScheduler] = useState<SchedulerInfo | null>(null);
  const [pipelineStatus, setPipelineStatus] = useState('');
  const [triggering, setTriggering] = useState(false);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'settings'>('dashboard');

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/pipeline/status');
      const data = await res.json();
      if (data.stats) setStats(data.stats);
      if (data.scheduler) setScheduler(data.scheduler);
    } catch (err) {
      console.error('Failed to load status:', err);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const handleTrigger = async () => {
    setTriggering(true);
    setPipelineStatus('Starting pipeline...');
    try {
      const res = await fetch('/api/pipeline/trigger', { method: 'POST' });
      const data = await res.json();
      if (data.error) {
        setPipelineStatus(`Error: ${data.error}`);
      } else {
        setPipelineStatus(
          `Pipeline complete! ${data.processed} processed, ${data.failed} failed.`
        );
      }
      fetchStatus();
    } catch (err) {
      setPipelineStatus('Failed to trigger pipeline');
    } finally {
      setTriggering(false);
    }
  };

  const handleSchedulerToggle = async () => {
    try {
      const action = scheduler?.running ? 'stop_scheduler' : 'start_scheduler';
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      fetchStatus();
    } catch (err) {
      console.error('Failed to toggle scheduler:', err);
    }
  };

  const formatTime = (iso?: string) => {
    if (!iso) return 'Never';
    return new Date(iso).toLocaleString();
  };

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      {/* Header */}
      <header className="bg-white dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">
              Video Pipeline
            </h1>
            <p className="text-sm text-zinc-500">
              Generate &amp; enhance images, then turn them into videos — all via KIE AI &amp; Google Drive
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setActiveTab('dashboard')}
              className={`px-4 py-2 text-sm rounded-lg transition-colors ${
                activeTab === 'dashboard'
                  ? 'bg-blue-600 text-white'
                  : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
              }`}
            >
              Dashboard
            </button>
            <button
              onClick={() => setActiveTab('settings')}
              className={`px-4 py-2 text-sm rounded-lg transition-colors ${
                activeTab === 'settings'
                  ? 'bg-blue-600 text-white'
                  : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
              }`}
            >
              Settings
            </button>
            <button
              onClick={async () => {
                await fetch('/api/auth/logout', { method: 'POST' });
                window.location.href = '/login';
              }}
              className="px-3 py-2 text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              title="Sign out"
            >
              ⏻
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        {activeTab === 'dashboard' ? (
          <>
            {/* Stats Cards */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-5">
                <p className="text-sm text-zinc-400 mb-2">Total Jobs</p>
                <p className="text-3xl font-bold text-zinc-900 dark:text-zinc-100">{stats.total}</p>
              </div>
              <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-5">
                <p className="text-sm text-zinc-400 mb-2">Completed</p>
                <p className="text-3xl font-bold text-emerald-600">{stats.completed}</p>
              </div>
              <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-5">
                <p className="text-sm text-zinc-400 mb-2">Processing Image</p>
                <p className="text-3xl font-bold text-blue-600">{stats.processing_image}</p>
              </div>
              <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-5">
                <p className="text-sm text-zinc-400 mb-2">Processing Video</p>
                <p className="text-3xl font-bold text-purple-600">{stats.processing_video}</p>
              </div>
              <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-5">
                <p className="text-sm text-zinc-400 mb-2">Failed</p>
                <p className="text-3xl font-bold text-red-600">{stats.failed}</p>
              </div>
            </div>

            {/* Pipeline Control */}
            <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
                    Pipeline Control
                  </h2>
                  <div className="flex items-center gap-4 text-sm text-zinc-500">
                    <span>
                      Schedule:{' '}
                      <code className="px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 rounded text-xs font-mono">
                        {scheduler?.cronExpression || 'Not configured'}
                      </code>
                    </span>
                    <span>
                      Scheduler:{' '}
                      <span className={scheduler?.running ? 'text-emerald-600' : 'text-zinc-400'}>
                        {scheduler?.running ? 'Running' : 'Stopped'}
                      </span>
                    </span>
                    <span>
                      Last run:{' '}
                      {formatTime(scheduler?.lastRun)}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleSchedulerToggle}
                    className={`px-3 py-2 text-sm rounded-lg transition-colors ${
                      scheduler?.running
                        ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-900/50'
                        : 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-200 dark:hover:bg-emerald-900/50'
                    }`}
                  >
                    {scheduler?.running ? 'Stop Scheduler' : 'Start Scheduler'}
                  </button>
                  <button
                    onClick={handleTrigger}
                    disabled={triggering}
                    className="px-5 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors flex items-center gap-2"
                  >
                    {triggering ? (
                      <>
                        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        Running...
                      </>
                    ) : (
                      <>
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        Run Pipeline Now
                      </>
                    )}
                  </button>
                </div>
              </div>
              {pipelineStatus && (
                <div className={`mt-4 p-3 rounded-lg text-sm ${
                  pipelineStatus.includes('Error')
                    ? 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300'
                    : 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
                }`}>
                  {pipelineStatus}
                </div>
              )}
            </div>

            {/* Job List */}
            <JobList />
          </>
        ) : (
          <ConfigPanel />
        )}
      </main>
    </div>
  );
}
