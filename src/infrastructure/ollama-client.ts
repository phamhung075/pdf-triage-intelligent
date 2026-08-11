import { Ollama } from 'ollama';
import { CONFIG } from './settings.js';

interface ModelHealthCacheEntry {
  modelName: string;
  checkedAt: number;
  canGenerate: boolean;
  error?: string;
}
let modelHealthCache: ModelHealthCacheEntry | null = null;
const MODEL_HEALTH_CACHE_TTL_MS = 5 * 60 * 1000;

// A model can pass the "exists locally" check (ollama.list()) yet still be unable to
// generate — e.g. a cloud/subscription-gated model that's listed but rejects requests
// at generate-time. This does a cheap 1-token generation to catch that proactively,
// cached briefly so it isn't repeated on every single document classification.
export async function checkModelCanGenerate(modelName: string, host: string = CONFIG.OLLAMA_HOST, forceRefresh = false): Promise<{ ok: boolean; error?: string }> {
  const now = Date.now();
  if (!forceRefresh && modelHealthCache && modelHealthCache.modelName === modelName && (now - modelHealthCache.checkedAt) < MODEL_HEALTH_CACHE_TTL_MS) {
    return { ok: modelHealthCache.canGenerate, error: modelHealthCache.error };
  }
  const ollama = new Ollama({ host });
  try {
    await ollama.generate({ model: modelName, prompt: 'test', options: { num_predict: 1 } });
    modelHealthCache = { modelName, checkedAt: now, canGenerate: true };
    return { ok: true };
  } catch (err: any) {
    modelHealthCache = { modelName, checkedAt: now, canGenerate: false, error: err.message };
    return { ok: false, error: err.message };
  }
}

export async function ensureOllamaModel(modelName: string = CONFIG.OLLAMA_MODEL): Promise<boolean> {
  const ollama = new Ollama({ host: CONFIG.OLLAMA_HOST });
  try {
    const list = await ollama.list();
    const exists = list.models.some(m => m.name.startsWith(modelName) || m.name.includes(modelName));
    if (!exists) {
      console.log(`Model '${modelName}' not found locally in Ollama. Pulling '${modelName}'...`);
      await ollama.pull({ model: modelName });
      console.log(`Model '${modelName}' pulled successfully.`);
    }
    const health = await checkModelCanGenerate(modelName);
    if (!health.ok) {
      console.warn(`Model '${modelName}' exists locally but cannot generate (e.g. subscription-gated cloud model): ${health.error}`);
      return false;
    }
    return true;
  } catch (err: any) {
    console.warn(`Ollama check/pull warning for model ${modelName}:`, err.message);
    try {
      console.log('Attempting auto-spawn of local Ollama serve process...');
      const { exec } = await import('child_process');
      exec('ollama serve', { windowsHide: true });
      await new Promise(r => setTimeout(r, 2000));
      const retryList = await ollama.list();
      const existsAfterSpawn = retryList.models.some(m => m.name.startsWith(modelName) || m.name.includes(modelName));
      if (!existsAfterSpawn) return false;
      const health = await checkModelCanGenerate(modelName, CONFIG.OLLAMA_HOST, true);
      return health.ok;
    } catch (autoErr: any) {
      console.error('Failed to auto-spawn Ollama:', autoErr.message);
      return false;
    }
  }
}

// Thin wrapper around the raw classification generate() call — think:false is required
// here: qwen3.5:9b is a thinking-capable model that otherwise routes its whole JSON
// answer into response.thinking and leaves response.response empty (see the regression
// test in src/application/classify-document.test.ts).
export async function requestClassificationCompletion(system: string, user: string): Promise<{ response: string; thinking?: string }> {
  const ollama = new Ollama({ host: CONFIG.OLLAMA_HOST });
  const result: any = await ollama.generate({
    model: CONFIG.OLLAMA_MODEL,
    system,
    prompt: user,
    format: 'json',
    think: false,
    options: {
      temperature: 0.1,
      num_ctx: 8192,
      num_predict: 4096
    }
  });
  return { response: result.response, thinking: result.thinking };
}

// General text chat completion wrapper (without format: 'json') for Markdown Q&A responses
export async function requestTextChatCompletion(system: string, user: string): Promise<{ response: string; thinking?: string }> {
  const ollama = new Ollama({ host: CONFIG.OLLAMA_HOST });
  const result: any = await ollama.generate({
    model: CONFIG.OLLAMA_MODEL,
    system,
    prompt: user,
    think: false,
    options: {
      temperature: 0.2,
      num_ctx: 8192,
      num_predict: 4096
    }
  });
  return { response: result.response || '', thinking: result.thinking };
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const ollama = new Ollama({ host: CONFIG.OLLAMA_HOST });
  try {
    const response = await ollama.embeddings({
      model: CONFIG.OLLAMA_EMBED_MODEL,
      prompt: text.substring(0, 1000)
    });
    return response.embedding || [];
  } catch {
    return [];
  }
}
