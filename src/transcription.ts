import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

interface TranscriptionConfig {
  provider: string;
  model?: string;
  enabled: boolean;
}

function loadConfig(): TranscriptionConfig {
  const configPath = path.join(process.cwd(), '.transcription.config.json');
  try {
    const configData = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(configData);
  } catch {
    logger.warn('Transcription config not found or invalid, disabling');
    return {
      provider: 'groq',
      enabled: false,
    };
  }
}

async function transcribeWithGroq(
  audioBuffer: Buffer,
  model: string,
): Promise<string | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    logger.warn('GROQ_API_KEY not set');
    return null;
  }

  try {
    const openaiModule = await import('openai');
    const OpenAI = openaiModule.default;
    const toFile = openaiModule.toFile;

    const groq = new OpenAI({
      apiKey,
      baseURL: 'https://api.groq.com/openai/v1',
    });

    const file = await toFile(audioBuffer, 'voice.ogg', {
      type: 'audio/ogg',
    });

    const transcription = await groq.audio.transcriptions.create({
      file,
      model,
      response_format: 'text',
    });

    return transcription as unknown as string;
  } catch (err) {
    logger.error({ err }, 'Groq transcription failed');
    return null;
  }
}

export async function transcribeAudio(
  downloadAudio: () => Promise<Buffer>,
): Promise<string | null> {
  const config = loadConfig();

  if (!config.enabled) {
    return null;
  }

  try {
    const buffer = await downloadAudio();

    if (!buffer || buffer.length === 0) {
      logger.error('Failed to download audio message: empty buffer');
      return null;
    }

    logger.debug({ bytes: buffer.length }, 'Downloaded audio message');

    switch (config.provider) {
      case 'groq':
        return await transcribeWithGroq(
          buffer,
          config.model || 'whisper-large-v3',
        );
      default:
        logger.error(
          { provider: config.provider },
          'Unknown transcription provider',
        );
        return null;
    }
  } catch (err) {
    logger.error({ err }, 'Transcription error');
    return null;
  }
}
