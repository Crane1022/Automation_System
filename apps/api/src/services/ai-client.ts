import type { AiService } from '@widebed/shared';
import { NodeError, type AiImageRequest, type AiImageResponse, type AiRequest, type AiResponse } from '@widebed/nodes';

/**
 * One small client for the three AI services. Each speaks a different HTTP API;
 * this turns them into the same request / answer shape for the AI nodes.
 * Temperature is only sent when an AI employee sets one (newer models reject some values).
 * `aiStream` gives the answer piece by piece while it is being written (for live typing in chats).
 */

export type AiFetch = (url: string, init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; json: any }>;

export const defaultAiFetch: AiFetch = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

const TIMEOUT_MS = 90_000;

/** The user's turn: text, plus pictures in each service's own format. */
function userTurn(service: AiService, prompt: string, images: AiRequest['images']) {
  const imgs = images ?? [];
  if (service === 'openai') {
    return { role: 'user', content: imgs.length ? [{ type: 'text', text: prompt }, ...imgs.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } }))] : prompt };
  }
  if (service === 'anthropic') {
    return { role: 'user', content: imgs.length ? [...imgs.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })), { type: 'text', text: prompt }] : prompt };
  }
  return { role: 'user', parts: [...imgs.map((i) => ({ inline_data: { mime_type: i.mime, data: i.data } })), { text: prompt }] };
}

function friendlyError(service: AiService, model: string, status: number, json: any, hadImages = false): NodeError {
  const raw = String(json?.error?.message ?? json?.error?.status ?? json?.message ?? `HTTP ${status}`);
  if (hadImages && status === 400 && /(image|vision|multimodal|modalit|inline_data|image_url)/i.test(raw)) {
    return new NodeError(`The AI model “${model}” can’t look at pictures. Choose a model that can (for example gpt-4o-mini, a Claude Sonnet or Haiku model, or gemini-2.5-flash) for this AI employee.`, { code: 'AI_NO_VISION' });
  }
  if (status === 401 || status === 403) {
    return new NodeError('The AI service refused the API key. Create a new key and update the AI connection on the Credentials page.', { code: 'AI_AUTH' });
  }
  if (status === 404 || (status === 400 && /model/i.test(raw) && /(not found|does not exist|invalid|unknown|not supported)/i.test(raw))) {
    return new NodeError(`The AI model “${model}” is not available for this key. Pick another model on the Credentials page (AI connection → Edit).`, { code: 'AI_MODEL' });
  }
  if (status === 429) {
    return new NodeError(`The AI service is busy or the account has no credit left (${raw}).`, { code: 'AI_RATE_LIMIT', retryable: true });
  }
  return new NodeError(`AI service error: ${raw}`, { code: 'AI_ERROR', retryable: status >= 500 });
}

/** An answer that stopped at the length limit before saying anything useful. */
function cutOff(text: unknown, hitLimit: boolean) {
  if (hitLimit && !String(text ?? '').trim()) {
    throw new NodeError('The AI ran out of answer length while thinking. Try again, ask a shorter question, or pick a lighter model on the Credentials page.', { code: 'AI_TOO_LONG', retryable: true });
  }
}

export interface AiConfig {
  service: AiService;
  model: string;
  apiKey: string;
  temperature?: number | null;
}

export async function aiComplete(
  cfg: AiConfig,
  req: AiRequest,
  fetchJson: AiFetch = defaultAiFetch,
  signal?: AbortSignal,
): Promise<AiResponse> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const maxTokens = req.maxTokens ?? 1500;
  const system = [req.system, req.json ? 'Answer with one valid JSON object only, no other text.' : ''].filter(Boolean).join('\n\n');

  let res: { status: number; json: any };
  try {
    if (cfg.service === 'openai') {
      res = await fetchJson('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          messages: [...(system ? [{ role: 'system', content: system }] : []), userTurn('openai', req.prompt, req.images)],
          max_completion_tokens: maxTokens,
          ...(cfg.temperature != null ? { temperature: cfg.temperature } : {}),
          ...(req.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: sig,
      });
      if (res.status >= 400) throw friendlyError('openai', cfg.model, res.status, res.json, !!req.images?.length);
      cutOff(res.json?.choices?.[0]?.message?.content, res.json?.choices?.[0]?.finish_reason === 'length');
      return {
        text: String(res.json?.choices?.[0]?.message?.content ?? ''),
        model: String(res.json?.model ?? cfg.model),
        inputTokens: res.json?.usage?.prompt_tokens,
        outputTokens: res.json?.usage?.completion_tokens,
      };
    }
    if (cfg.service === 'anthropic') {
      res = await fetchJson('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, ...(cfg.temperature != null ? { temperature: cfg.temperature } : {}), ...(system ? { system } : {}), messages: [userTurn('anthropic', req.prompt, req.images)] }),
        signal: sig,
      });
      if (res.status >= 400) throw friendlyError('anthropic', cfg.model, res.status, res.json, !!req.images?.length);
      const text = (res.json?.content ?? []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('');
      cutOff(text, res.json?.stop_reason === 'max_tokens');
      return { text, model: String(res.json?.model ?? cfg.model), inputTokens: res.json?.usage?.input_tokens, outputTokens: res.json?.usage?.output_tokens };
    }
    // Google Gemini
    res = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': cfg.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: [userTurn('gemini', req.prompt, req.images)],
        generationConfig: { maxOutputTokens: maxTokens, ...(cfg.temperature != null ? { temperature: cfg.temperature } : {}), ...(req.json ? { responseMimeType: 'application/json' } : {}) },
      }),
      signal: sig,
    });
    if (res.status >= 400) throw friendlyError('gemini', cfg.model, res.status, res.json, !!req.images?.length);
    const parts = (res.json?.candidates?.[0]?.content?.parts ?? []).filter((p: any) => !p?.thought);
    cutOff(parts.map((p: any) => p?.text ?? '').join(''), res.json?.candidates?.[0]?.finishReason === 'MAX_TOKENS');
    return {
      text: parts.map((p: any) => p?.text ?? '').join(''),
      model: String(res.json?.modelVersion ?? cfg.model),
      inputTokens: res.json?.usageMetadata?.promptTokenCount,
      outputTokens: res.json?.usageMetadata?.candidatesTokenCount,
    };
  } catch (err) {
    if (err instanceof NodeError) throw err;
    if (signal?.aborted) throw err;
    if (timeout.aborted) throw new NodeError('The AI service took too long to answer (90 s). Try again, or use a shorter text.', { code: 'AI_TIMEOUT', retryable: true });
    throw new NodeError(`Could not reach the AI service: ${(err as Error).message}`, { code: 'AI_NETWORK', retryable: true });
  }
}


/* ================================================================ pictures */

/** Gemini model that makes pictures, used when the AI connection's own model cannot. */
export const DEFAULT_IMAGE_MODEL = 'gemini-2.5-flash-image';
const IMAGE_TIMEOUT_MS = 100_000;

/**
 * Makes one picture with Gemini (optionally starting from photos). Only Gemini connections can do this.
 * The connection's model is used when it is an image model, otherwise gemini-2.5-flash-image.
 */
export async function aiGenerateImage(cfg: AiConfig, req: AiImageRequest, fetchJson: AiFetch = defaultAiFetch, signal?: AbortSignal): Promise<AiImageResponse> {
  if (cfg.service !== 'gemini') {
    throw new NodeError('AI Picture needs a Google Gemini AI connection. Add one on the Credentials page (AI service → Google Gemini) and choose it on this step.', { code: 'AI_IMAGE_SERVICE' });
  }
  const model = req.model?.trim() || (/image/i.test(cfg.model) ? cfg.model : DEFAULT_IMAGE_MODEL);
  const imageConfig: Record<string, string> = {};
  if (req.aspectRatio) imageConfig.aspectRatio = req.aspectRatio;
  if (req.imageSize && /gemini-3/i.test(model)) imageConfig.imageSize = req.imageSize; // only Gemini 3 image models take a size
  const timeout = AbortSignal.timeout(IMAGE_TIMEOUT_MS);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: { status: number; json: any };
  try {
    res = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': cfg.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [userTurn('gemini', req.prompt, req.images)],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...(Object.keys(imageConfig).length ? { imageConfig } : {}) },
      }),
      signal: sig,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    if (timeout.aborted) throw new NodeError('Making the picture took too long (100 s). Try again.', { code: 'AI_TIMEOUT', retryable: true });
    throw new NodeError(`Could not reach the AI service: ${(err as Error).message}`, { code: 'AI_NETWORK', retryable: true });
  }
  if (res.status >= 400) throw friendlyError('gemini', model, res.status, res.json, !!req.images?.length);
  const cand = res.json?.candidates?.[0];
  const parts: any[] = cand?.content?.parts ?? [];
  const pic = parts.map((p) => p?.inlineData ?? p?.inline_data).find((d) => d && typeof d.data === 'string' && /^image\//.test(d.mimeType ?? d.mime_type ?? ''));
  const text = parts.filter((p) => typeof p?.text === 'string' && !p.thought).map((p) => p.text).join('').trim();
  if (!pic) {
    const why = cand?.finishReason && cand.finishReason !== 'STOP' ? ` (${cand.finishReason})` : res.json?.promptFeedback?.blockReason ? ` (${res.json.promptFeedback.blockReason})` : '';
    throw new NodeError(`The AI did not make a picture${why}.${text ? ` It said: “${text.slice(0, 300)}”` : ''}`, { code: 'AI_NO_IMAGE', retryable: !why });
  }
  return { data: pic.data, mimeType: String(pic.mimeType ?? pic.mime_type), text, model: String(res.json?.modelVersion ?? model) };
}

/* ================================================================ streaming */

/** Like AiFetch, but on success gives the response body line by line (server-sent events). */
export type AiStreamFetch = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; json?: any; lines?: AsyncIterable<string> }>;

export const defaultAiStreamFetch: AiStreamFetch = async (url, init) => {
  const res = await fetch(url, init);
  if (!res.ok || !res.body) return { status: res.status, json: await res.json().catch(() => ({})) };
  const body = res.body;
  async function* lines() {
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        yield buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
      }
    }
    if (buf) yield buf;
  }
  return { status: res.status, lines: lines() };
};

/** Reads `data: {...}` events from a stream of lines. */
async function* sseData(lines: AsyncIterable<string>) {
  for await (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      yield JSON.parse(data);
    } catch {
      /* ignore keep-alives and partial lines */
    }
  }
}

/**
 * Same as aiComplete, but streams: `onText` is called with the whole text so far each
 * time more arrives. Returns the finished answer with token counts.
 */
export async function aiStream(
  cfg: AiConfig,
  req: AiRequest,
  onText: (soFar: string) => void,
  streamFetch: AiStreamFetch = defaultAiStreamFetch,
  signal?: AbortSignal,
): Promise<AiResponse> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS * 2);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const maxTokens = req.maxTokens ?? 1500;
  const system = [req.system, req.json ? 'Answer with one valid JSON object only, no other text.' : ''].filter(Boolean).join('\n\n');
  const temp = cfg.temperature != null ? { temperature: cfg.temperature } : {};

  let text = '';
  let model = cfg.model;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let hitLimit = false;
  const add = (piece: unknown) => {
    if (typeof piece === 'string' && piece) {
      text += piece;
      onText(text);
    }
  };

  try {
    let url: string;
    let headers: Record<string, string>;
    let body: unknown;
    if (cfg.service === 'openai') {
      url = 'https://api.openai.com/v1/chat/completions';
      headers = { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' };
      body = {
        model: cfg.model,
        messages: [...(system ? [{ role: 'system', content: system }] : []), userTurn('openai', req.prompt, req.images)],
        max_completion_tokens: maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        ...temp,
        ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      };
    } else if (cfg.service === 'anthropic') {
      url = 'https://api.anthropic.com/v1/messages';
      headers = { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
      body = { model: cfg.model, max_tokens: maxTokens, stream: true, ...temp, ...(system ? { system } : {}), messages: [userTurn('anthropic', req.prompt, req.images)] };
    } else {
      url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:streamGenerateContent?alt=sse`;
      headers = { 'x-goog-api-key': cfg.apiKey, 'content-type': 'application/json' };
      body = {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: [userTurn('gemini', req.prompt, req.images)],
        generationConfig: { maxOutputTokens: maxTokens, ...temp, ...(req.json ? { responseMimeType: 'application/json' } : {}) },
      };
    }
    const res = await streamFetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: sig });
    if (res.status >= 400 || !res.lines) throw friendlyError(cfg.service, cfg.model, res.status, res.json, !!req.images?.length);

    for await (const ev of sseData(res.lines)) {
      if (ev?.error) throw friendlyError(cfg.service, cfg.model, 500, ev);
      if (cfg.service === 'openai') {
        add(ev?.choices?.[0]?.delta?.content);
        if (ev?.choices?.[0]?.finish_reason === 'length') hitLimit = true;
        if (ev?.model) model = ev.model;
        if (ev?.usage) {
          inputTokens = ev.usage.prompt_tokens;
          outputTokens = ev.usage.completion_tokens;
        }
      } else if (cfg.service === 'anthropic') {
        if (ev?.type === 'message_start') {
          model = ev.message?.model ?? model;
          inputTokens = ev.message?.usage?.input_tokens;
        }
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') add(ev.delta.text);
        if (ev?.type === 'message_delta') {
          outputTokens = ev.usage?.output_tokens ?? outputTokens;
          if (ev.delta?.stop_reason === 'max_tokens') hitLimit = true;
        }
      } else {
        const c = ev?.candidates?.[0];
        for (const p of c?.content?.parts ?? []) if (!p?.thought) add(p?.text);
        if (c?.finishReason === 'MAX_TOKENS') hitLimit = true;
        if (ev?.modelVersion) model = ev.modelVersion;
        if (ev?.usageMetadata) {
          inputTokens = ev.usageMetadata.promptTokenCount;
          outputTokens = ev.usageMetadata.candidatesTokenCount;
        }
      }
    }
    cutOff(text, hitLimit);
    return { text, model, inputTokens, outputTokens };
  } catch (err) {
    if (err instanceof NodeError) throw err;
    if (signal?.aborted) throw err;
    if (timeout.aborted) throw new NodeError('The AI service took too long to answer. Try again, or ask a shorter question.', { code: 'AI_TIMEOUT', retryable: true });
    throw new NodeError(`Could not reach the AI service: ${(err as Error).message}`, { code: 'AI_NETWORK', retryable: true });
  }
}

/* ============================================================== model list */

export interface AiModelInfo {
  id: string;
  label: string;
}

/**
 * The models this API key can use, straight from the AI service (nothing hard-coded).
 * Only text/chat models are kept.
 */
export async function listAiModels(cfg: { service: AiService; apiKey: string }, fetchJson: AiFetch = defaultAiFetch): Promise<AiModelInfo[]> {
  const signal = AbortSignal.timeout(20_000);
  if (cfg.service === 'openai') {
    const res = await fetchJson('https://api.openai.com/v1/models', { method: 'GET', headers: { authorization: `Bearer ${cfg.apiKey}` }, signal });
    if (res.status >= 400) throw friendlyError('openai', '', res.status, res.json);
    return (res.json?.data ?? [])
      .map((m: any) => String(m?.id ?? ''))
      .filter((id: string) => /^(gpt|o\d|chatgpt)/i.test(id) && !/(audio|realtime|transcribe|tts|image|embedding|search|moderation|instruct)/i.test(id))
      .sort((a: string, b: string) => b.localeCompare(a))
      .map((id: string) => ({ id, label: id }));
  }
  if (cfg.service === 'anthropic') {
    const res = await fetchJson('https://api.anthropic.com/v1/models?limit=100', { method: 'GET', headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' }, signal });
    if (res.status >= 400) throw friendlyError('anthropic', '', res.status, res.json);
    return (res.json?.data ?? []).map((m: any) => ({ id: String(m.id), label: String(m.display_name ?? m.id) }));
  }
  const res = await fetchJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { method: 'GET', headers: { 'x-goog-api-key': cfg.apiKey }, signal });
  if (res.status >= 400) throw friendlyError('gemini', '', res.status, res.json);
  return (res.json?.models ?? [])
    .filter((m: any) => (m?.supportedGenerationMethods ?? []).includes('generateContent') && !/(embedding|aqa|imagen|veo|tts|image)/i.test(String(m?.name)))
    .map((m: any) => ({ id: String(m.name).replace(/^models\//, ''), label: String(m.displayName ?? m.name) }));
}
