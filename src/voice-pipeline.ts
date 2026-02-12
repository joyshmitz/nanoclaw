import { transcribeAudio } from './transcription.js';
import { updateMessageContent } from './db.js';
import { logger } from './logger.js';
import { NewMessage } from './types.js';

export const VOICE_TTL_MS = 30 * 60 * 1000;
export const MAX_PENDING_VOICE = 500;
export const MAX_VOICE_PER_CYCLE = 2;
export const VOICE_DOWNLOAD_TIMEOUT_MS = 5_000;
export const VOICE_TRANSCRIBE_TIMEOUT_MS = 10_000;
export const VOICE_SWEEP_INTERVAL_MS = 5 * 60_000;

export interface PendingVoiceEntry {
  downloadAudio: () => Promise<Buffer>;
  chatJid: string;
  createdAt: number;
}

export const pendingVoice = new Map<string, PendingVoiceEntry>();

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

export async function transcribePendingVoice(messages: NewMessage[]): Promise<void> {
  let attempted = 0;
  for (const m of messages) {
    if (m.content !== '[Voice Message]') continue;
    if (attempted >= MAX_VOICE_PER_CYCLE) break;

    const key = `${m.id}:${m.chat_jid}`;
    const pending = pendingVoice.get(key);
    if (!pending) {
      logger.debug({ key }, 'Voice: no pending entry (missing_pending)');
      continue;
    }

    if (Date.now() - pending.createdAt > VOICE_TTL_MS) {
      logger.warn({ key }, 'Voice: entry expired, skipping (expired)');
      pendingVoice.delete(key);
      continue;
    }

    attempted++;
    try {
      const buffer = await withTimeout(pending.downloadAudio(), VOICE_DOWNLOAD_TIMEOUT_MS, 'download');
      const transcript = await withTimeout(
        transcribeAudio(async () => buffer),
        VOICE_TRANSCRIBE_TIMEOUT_MS,
        'transcribe',
      );
      if (transcript?.trim()) {
        m.content = `[Voice: ${transcript.trim()}]`;
        updateMessageContent(m.id, m.chat_jid, m.content);
        logger.info({ key }, 'Voice message transcribed');
      } else {
        logger.info({ key }, 'Voice: empty transcript (provider_disabled or empty)');
      }
    } catch (err) {
      logger.warn({ key, err }, 'Voice: transcription failed, keeping placeholder (download_failed/timeout)');
    } finally {
      pendingVoice.delete(key);
    }
  }
}

export function addPendingVoice(msgId: string, chatJid: string, downloadAudio: () => Promise<Buffer>): void {
  if (pendingVoice.size >= MAX_PENDING_VOICE) {
    logger.warn({ size: pendingVoice.size }, 'pendingVoice at capacity, dropping oldest');
    const firstKey = pendingVoice.keys().next().value;
    if (firstKey) pendingVoice.delete(firstKey);
  }
  pendingVoice.set(`${msgId}:${chatJid}`, { downloadAudio, chatJid, createdAt: Date.now() });
}

export function startVoiceSweeper(): void {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of pendingVoice) {
      if (now - entry.createdAt > VOICE_TTL_MS) {
        logger.debug({ key }, 'Evicting expired pending voice entry');
        pendingVoice.delete(key);
      }
    }
  }, VOICE_SWEEP_INTERVAL_MS);
}
