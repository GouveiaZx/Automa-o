import { env } from '../env.js';
import type { AutomationDriver, BioArgs, DriverResult, PostArgs } from './driver.js';
import { appLog } from '../logger.js';

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function simulatedDelay(): Promise<void> {
  await delay(rand(env.AUTOMATION_MOCK_MIN_DELAY, env.AUTOMATION_MOCK_MAX_DELAY));
}

export const mockDriver: AutomationDriver = {
  async openProfile(adsPowerId) {
    await appLog({ source: 'driver', level: 'info', message: `[mock] abrindo perfil ${adsPowerId}` });
    await simulatedDelay();
    return { ok: true };
  },

  async ensureLoggedIn(adsPowerId, igUsername) {
    await appLog({
      source: 'driver',
      level: 'info',
      message: `[mock] verificando login de @${igUsername}`,
    });
    await delay(rand(500, 1500));
    return Math.random() > 1 / 30;
  },

  async postStory(args: PostArgs): Promise<DriverResult> {
    await appLog({
      source: 'driver',
      level: 'info',
      message: `[mock] postando STORY (${args.filePath}) no perfil ${args.adsPowerId}${args.linkUrl ? ` com link ${args.linkUrl}` : ''}`,
    });
    await simulatedDelay();
    if (Math.random() < env.AUTOMATION_MOCK_FAIL_RATE) {
      return { ok: false, reason: 'mock_simulated_failure' };
    }
    return { ok: true };
  },

  async postReel(args: PostArgs): Promise<DriverResult> {
    await appLog({
      source: 'driver',
      level: 'info',
      message: `[mock] postando REEL (${args.filePath}) no perfil ${args.adsPowerId}`,
    });
    await simulatedDelay();
    if (Math.random() < env.AUTOMATION_MOCK_FAIL_RATE) {
      return { ok: false, reason: 'mock_simulated_failure' };
    }
    return { ok: true };
  },

  async updateBio(args: BioArgs): Promise<DriverResult> {
    await appLog({
      source: 'driver',
      level: 'info',
      message: `[mock] atualizando bio do perfil ${args.adsPowerId} (bio="${(args.bio || '').slice(0, 30)}", site=${args.websiteUrl || '-'})`,
    });
    await delay(rand(env.AUTOMATION_MOCK_MIN_DELAY, env.AUTOMATION_MOCK_MAX_DELAY));
    if (Math.random() < env.AUTOMATION_MOCK_FAIL_RATE) {
      return { ok: false, reason: 'mock_simulated_bio_failure' };
    }
    return { ok: true };
  },

  async closeProfile(adsPowerId) {
    await appLog({ source: 'driver', level: 'info', message: `[mock] fechando perfil ${adsPowerId}` });
    await delay(rand(300, 800));
  },
};
