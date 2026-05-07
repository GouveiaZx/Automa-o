import { z } from 'zod';

const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

export const loginSchema = z.object({
  email: z.string().min(3),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

// Aceita "00:00,03:00,06:00" ou "" (vazio = ignora) ou null
const fixedTimesRegex = /^(([01]\d|2[0-3]):[0-5]\d)(\s*,\s*([01]\d|2[0-3]):[0-5]\d)*$/;

export const campaignBaseSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  windowStart: z.string().regex(timeRegex, 'HH:MM'),
  windowEnd: z.string().regex(timeRegex, 'HH:MM'),
  minIntervalMin: z.number().int().min(5).max(1440),
  maxIntervalMin: z.number().int().min(5).max(1440),
  storiesPerDay: z.number().int().min(0).max(50),
  reelsPerDay: z.number().int().min(0).max(50),
  fixedTimes: z
    .string()
    .regex(fixedTimesRegex, 'Formato: "HH:MM" separado por virgula. Ex: "00:00,03:00,06:00"')
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
  active: z.boolean().default(true),
});

export const campaignInputSchema = campaignBaseSchema.refine(
  (d) => d.maxIntervalMin >= d.minIntervalMin,
  { message: 'maxIntervalMin deve ser >= minIntervalMin', path: ['maxIntervalMin'] }
);
export const campaignPartialSchema = campaignBaseSchema.partial();
export type CampaignInput = z.infer<typeof campaignInputSchema>;

export const adsPowerProfileInputSchema = z.object({
  adsPowerId: z.string().min(1).max(120),
  name: z.string().min(1).max(120),
  notes: z.string().max(2000).nullable().optional(),
});
export type AdsPowerProfileInput = z.infer<typeof adsPowerProfileInputSchema>;

export const instagramAccountInputSchema = z.object({
  username: z.string().min(1).max(80),
  displayName: z.string().max(120).nullable().optional(),
  bio: z.string().max(500).nullable().optional(),
  websiteUrl: z
    .string()
    .max(500)
    .url('URL inválida (precisa começar com http:// ou https://)')
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
  groupName: z.string().max(80).nullable().optional(),
  campaignId: z.string().nullable().optional(),
  adsPowerProfileId: z.string().nullable().optional(),
});

export const syncBioSchema = z.object({
  // Permite override pontual; se não enviar, usa bio/websiteUrl da conta
  bio: z.string().max(500).nullable().optional(),
  websiteUrl: z.string().url().max(500).nullable().optional(),
});
export type InstagramAccountInput = z.infer<typeof instagramAccountInputSchema>;

export const accountStatusUpdateSchema = z.object({
  status: z.enum(['active', 'paused', 'needs_login', 'error']),
});

export const mediaInputSchema = z.object({
  type: z.enum(['story', 'reel', 'photo']),
  caption: z.string().max(2200).nullable().optional(),
  linkUrl: z.string().url().max(500).nullable().optional(),
  tag: z.string().max(80).nullable().optional(),
  campaignId: z.string().min(1),
});
export type MediaInput = z.infer<typeof mediaInputSchema>;

export const scheduleJobSchema = z.object({
  accountId: z.string().min(1),
  mediaId: z.string().min(1),
  scheduledFor: z.string().datetime().optional(),
});
export type ScheduleJobInput = z.infer<typeof scheduleJobSchema>;

export const scheduleBulkSchema = z.object({
  accountId: z.string().min(1),
  mediaIds: z.array(z.string().min(1)).min(1).max(50),
  spreadOver: z.enum(['now', 'hour', 'today', '24h', 'campaign']).default('today'),
});
export type ScheduleBulkInput = z.infer<typeof scheduleBulkSchema>;

// Schedule em lote pra MULTIPLAS contas com as MESMAS midias.
// Ex: 5 contas + 3 midias = 15 jobs criados (3 por conta, espalhados).
export const scheduleBulkMultiSchema = z.object({
  accountIds: z.array(z.string().min(1)).min(1).max(50),
  mediaIds: z.array(z.string().min(1)).min(1).max(50),
  spreadOver: z.enum(['now', 'hour', 'today', '24h', 'campaign']).default('today'),
});
export type ScheduleBulkMultiInput = z.infer<typeof scheduleBulkMultiSchema>;

export const settingUpdateSchema = z.object({
  value: z.string(),
});
