// OpenAI-compatible LLM client for Omniroute (or any /v1 proxy).
//
// Omniroute exposes an OpenAI-style REST API. Point the app at it and the AI
// loop engine will use it to generate engineering/architecture insights.
//
// Configuration precedence (highest first):
//   1. ?llm=<baseUrl> / ?llmKey=<key> / ?llmModel=<id> query params
//   2. localStorage: reslo_llm_base / reslo_llm_key / reslo_llm_model
//   3. Vite env: VITE_OMNIROUTE_URL / VITE_OMNIROUTE_KEY / VITE_OMNIROUTE_MODEL
//   4. Built-in defaults (localhost Omniroute)

const DEFAULT_BASE = 'http://localhost:20128/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';

export class LlmError extends Error {
  constructor(msg: string) { super(msg); this.name = 'LlmError'; }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function fromQuery(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = new URLSearchParams(window.location.search).get(key);
    return v && v.trim() ? v.trim() : null;
  } catch { return null; }
}

function fromStorage(key: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const v = localStorage.getItem(key);
    return v && v.trim() ? v.trim() : null;
  } catch { return null; }
}

function fromEnv(key: string): string | null {
  try {
    const v = (import.meta as any)?.env?.[key];
    return v && String(v).trim() ? String(v).trim() : null;
  } catch { return null; }
}

function initBase(): string {
  return (fromQuery('llm') || fromStorage('reslo_llm_base') || fromEnv('VITE_OMNIROUTE_URL') || DEFAULT_BASE).replace(/\/$/, '');
}
function initKey(): string {
  return fromQuery('llmKey') || fromStorage('reslo_llm_key') || fromEnv('VITE_OMNIROUTE_KEY') || '';
}
function initModel(): string {
  return fromQuery('llmModel') || fromStorage('reslo_llm_model') || fromEnv('VITE_OMNIROUTE_MODEL') || DEFAULT_MODEL;
}

class LlmClient {
  baseUrl = $state(initBase());
  apiKey = $state(initKey());
  model = $state(initModel());
  connected = $state(false);
  lastError = $state<string | null>(null);

  /** True once the base URL is set. A key is optional for a local proxy. */
  isConfigured(): boolean {
    return !!this.baseUrl;
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/$/, '');
    try { localStorage.setItem('reslo_llm_base', this.baseUrl); } catch {}
  }
  setApiKey(key: string): void {
    this.apiKey = key;
    try { localStorage.setItem('reslo_llm_key', key); } catch {}
  }
  setModel(model: string): void {
    this.model = model;
    try { localStorage.setItem('reslo_llm_model', model); } catch {}
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  /** GET /v1/models — verifies reachability and returns available model ids. */
  async listModels(): Promise<string[]> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(`${this.baseUrl}/models`, { headers: this.headers(), signal: controller.signal });
      clearTimeout(id);
      if (!res.ok) throw new LlmError(`Models endpoint returned ${res.status}`);
      const data = await res.json();
      const ids = (data?.data ?? []).map((m: any) => m.id).filter(Boolean);
      this.connected = true;
      this.lastError = null;
      return ids;
    } catch (e: any) {
      clearTimeout(id);
      this.connected = false;
      this.lastError = e?.name === 'AbortError'
        ? `Timed out reaching ${this.baseUrl}`
        : `Unable to reach ${this.baseUrl}: ${e?.message ?? e}`;
      throw e instanceof LlmError ? e : new LlmError(this.lastError);
    }
  }

  /** Lightweight connectivity check used by the AI loop before it calls the model. */
  async health(): Promise<boolean> {
    try {
      await this.listModels();
      return true;
    } catch {
      return false;
    }
  }

  /** POST /v1/chat/completions. Returns the assistant message content. */
  async chat(messages: ChatMessage[], opts: { temperature?: number; maxTokens?: number; model?: string; signal?: AbortSignal } = {}): Promise<string> {
    if (!this.isConfigured()) throw new LlmError('LLM base URL is not configured.');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    const signal = opts.signal ?? controller.signal;

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: opts.model ?? this.model,
          messages,
          temperature: opts.temperature ?? 0.3,
          max_tokens: opts.maxTokens ?? 800,
          stream: false,
        }),
        signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new LlmError(`Chat completion failed (${res.status}): ${body.slice(0, 300)}`);
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new LlmError('Malformed response: no message content.');
      this.connected = true;
      this.lastError = null;
      return content;
    } catch (e: any) {
      clearTimeout(timeoutId);
      this.lastError = e?.message ?? String(e);
      if (e?.name === 'AbortError') throw new LlmError('LLM request timed out (30s).');
      throw e instanceof LlmError ? e : new LlmError(this.lastError!);
    }
  }

  /**
   * Ask the model for structured JSON. Returns the parsed object, tolerating
   * responses wrapped in ```json fences.
   */
  async chatJson<T = any>(messages: ChatMessage[], opts?: { temperature?: number; maxTokens?: number; model?: string }): Promise<T> {
    const raw = await this.chat(messages, opts);
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const text = (fenced ? fenced[1] : raw).trim();
    try {
      return JSON.parse(text) as T;
    } catch {
      // Best-effort: grab the first {...} or [...] block.
      const m = text.match(/[[{][\s\S]*[\]}]/);
      if (m) return JSON.parse(m[0]) as T;
      throw new LlmError('Model did not return valid JSON.');
    }
  }
}

export const llmClient = new LlmClient();
