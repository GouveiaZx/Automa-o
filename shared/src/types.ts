export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'retry';
export type AccountStatus = 'active' | 'paused' | 'needs_login' | 'error';
export type ProfileStatus = 'idle' | 'running' | 'error' | 'paused';
export type MediaType = 'story' | 'reel' | 'photo';
export type LogLevel = 'info' | 'warn' | 'error';
export type LogSource = 'worker' | 'api' | 'driver';
export type AutomationMode = 'mock' | 'real';

export interface Campaign {
  id: string;
  name: string;
  description: string | null;
  windowStart: string;
  windowEnd: string;
  minIntervalMin: number;
  maxIntervalMin: number;
  storiesPerDay: number;
  reelsPerDay: number;
  fixedTimes: string | null;
  active: boolean;
  createdAt: string;
}

export interface AdsPowerProfile {
  id: string;
  adsPowerId: string;
  name: string;
  notes: string | null;
  status: ProfileStatus;
  lastOpenedAt: string | null;
  account?: InstagramAccount | null;
}

export interface InstagramAccount {
  id: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  websiteUrl: string | null;
  groupName: string | null;
  status: AccountStatus;
  lastFailureAt: string | null;
  consecutiveFails: number;
  // FIX 18: distingue auto-pausada (worker) de pausada manual (user via UI).
  // Auto-unpause no poller so re-ativa as auto-pausadas.
  autoPaused: boolean;
  campaignId: string | null;
  campaign?: Campaign | null;
  adsPowerProfileId: string | null;
  adsPowerProfile?: AdsPowerProfile | null;
}

export interface MediaItem {
  id: string;
  type: MediaType;
  filePath: string;
  caption: string | null;
  linkUrl: string | null;
  thumbnail: string | null;
  tag: string | null;
  campaignId: string;
  publishedAt: string | null;
  usedCount: number;
  createdAt: string;
}

export interface PostJob {
  id: string;
  accountId: string;
  account?: InstagramAccount;
  mediaId: string;
  media?: MediaItem;
  type: MediaType;
  status: JobStatus;
  attempts: number;
  scheduledFor: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface AutomationLog {
  id: string;
  level: LogLevel;
  source: LogSource;
  accountId: string | null;
  jobId: string | null;
  message: string;
  metadata: unknown;
  createdAt: string;
}

export interface AppSetting {
  key: string;
  value: string;
}

export interface DashboardSummary {
  jobs: {
    queued: number;
    running: number;
    retry: number;
    failed: number;
    doneToday: number;
  };
  accounts: {
    active: number;
    paused: number;
    needsLogin: number;
    error: number;
  };
  alerts: Array<{
    id: string;
    severity: 'info' | 'warn' | 'error';
    message: string;
    createdAt: string;
  }>;
}

export type SseEvent =
  | { type: 'log'; payload: AutomationLog }
  | { type: 'job-update'; payload: PostJob }
  | { type: 'account-update'; payload: InstagramAccount }
  | { type: 'alert'; payload: { severity: 'warn' | 'error'; message: string; sound?: boolean } }
  | { type: 'worker-heartbeat'; payload: { at: number; tickCount: number; inFlight: number } };
