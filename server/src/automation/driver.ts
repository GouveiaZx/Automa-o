export interface DriverResult {
  ok: boolean;
  reason?: string;
}

export interface PostArgs {
  adsPowerId: string;
  filePath: string;
  caption?: string | null;
  linkUrl?: string | null;
  /** IG username — usado pela verificacao por perfil (FIX 12). */
  igUsername?: string;
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
  /**
   * FIX 21 + FIX 24.3: pega contador de seguidores navegando pro perfil IG.
   * Retorna `reason` quando falha (pra debug/log na UI: "redirect:...",
   * "parse_failed:source=none preview=...", etc).
   */
  getFollowers?(adsPowerId: string, igUsername: string): Promise<{ followersCount: number | null; reason?: string }>;
}

import { mockDriver } from './mock-driver.js';
import { realDriver } from './real-driver.js';
import { env } from '../env.js';

export function getDriver(): AutomationDriver {
  return env.AUTOMATION_MODE === 'real' ? realDriver : mockDriver;
}
