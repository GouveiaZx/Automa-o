export interface DriverResult {
  ok: boolean;
  reason?: string;
}

export interface PostArgs {
  adsPowerId: string;
  filePath: string;
  caption?: string | null;
  linkUrl?: string | null;
}

export interface BioArgs {
  adsPowerId: string;
  bio?: string | null;
  websiteUrl?: string | null;
}

export interface AutomationDriver {
  openProfile(adsPowerId: string): Promise<DriverResult>;
  ensureLoggedIn(adsPowerId: string, igUsername: string): Promise<boolean>;
  postStory(args: PostArgs): Promise<DriverResult>;
  postReel(args: PostArgs): Promise<DriverResult>;
  updateBio(args: BioArgs): Promise<DriverResult>;
  closeProfile(adsPowerId: string): Promise<void>;
  /** IDs de perfis AdsPower com sessao Playwright atualmente aberta. */
  getOpenSessionIds?(): string[];
}

import { mockDriver } from './mock-driver.js';
import { realDriver } from './real-driver.js';
import { env } from '../env.js';

export function getDriver(): AutomationDriver {
  return env.AUTOMATION_MODE === 'real' ? realDriver : mockDriver;
}
