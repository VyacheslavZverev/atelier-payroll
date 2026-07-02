// Reads one photo (possibly containing several paper invoices) via a vision
// model and returns normalized rows for the review list. The provider is
// chosen by VISION_MODEL: claude-* -> Anthropic API, gemini-* -> Google API,
// vendor/model (with a slash, e.g. google/gemini-3.5-flash) -> OpenRouter.
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

const PROMPT = `This photo shows one or more handwritten Russian repair-shop invoices ("Накладная").
They may be laid out in a grid, rotated, or partially overlapping.

For EACH invoice visible in the photo, extract:
1. "number": the invoice number after "Накладная №" (integer). Use null if unreadable.
2. "amount": the total after "Итого" (integer, rubles, no kopecks). Use null if unreadable.
3. "paid_stamp": true if a red "ОПЛАЧЕНО" stamp is visible anywhere on that invoice. The stamp is usually on the side; it may be rotated, partial, faint, or overlapping the text. false if no such stamp is visible.
4. "confidence": set to "high" ONLY when you are completely certain of EVERY digit of BOTH the number and the amount. In every other case set "low".

Read each invoice digit by digit. The amount after "Итого" is small handwriting and by far the most error-prone field — re-read it carefully. When a handwritten digit could plausibly be read two ways (for example 1/7, 4/9, 3/8, 0/6, 5/6, 2/3), do NOT guess: set "confidence" to "low". It is far better to flag a row for the human to check than to report a wrong amount with high confidence.

Return ONLY JSON of the form {"invoices": [...]} with no prose.`;

const SCHEMA = {
  type: 'object',
  properties: {
    invoices: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          number: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          amount: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          paid_stamp: { type: 'boolean' },
          confidence: { type: 'string', enum: ['high', 'low'] }
        },
        required: ['number', 'amount', 'paid_stamp', 'confidence'],
        additionalProperties: false
      }
    }
  },
  required: ['invoices'],
  additionalProperties: false
};

// Same schema in the OpenAPI-style dialect the Gemini API expects.
const GEMINI_SCHEMA = {
  type: 'object',
  properties: {
    invoices: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          number: { type: 'integer', nullable: true },
          amount: { type: 'integer', nullable: true },
          paid_stamp: { type: 'boolean' },
          confidence: { type: 'string', enum: ['high', 'low'] }
        },
        required: ['number', 'amount', 'paid_stamp', 'confidence']
      }
    }
  },
  required: ['invoices']
};

// Credentials resolve in SDK precedence order: ANTHROPIC_API_KEY, then
// ANTHROPIC_AUTH_TOKEN, then an `ant auth login` OAuth profile on this machine.
function hasOAuthProfile() {
  const credentialsDir =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA || '', 'Anthropic', 'credentials')
      : path.join(
          process.env.ANTHROPIC_CONFIG_DIR ||
            path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'anthropic'),
          'credentials'
        );
  try {
    return fs.readdirSync(credentialsDir).some((f) => f.endsWith('.json'));
  } catch {
    return false;
  }
}

let client = null;
function getClient() {
  if (!hasAnthropicCredentials()) return null;
  client ??= new Anthropic(); // bare client — SDK resolves key/token/profile itself
  return client;
}

function activeModel() {
  return process.env.VISION_MODEL || DEFAULT_MODEL;
}

// Comma-separated model IDs tried in order when the primary model fails
// (overloaded, rate-limited, or returns garbage). May mix providers.
function fallbackModels() {
  return (process.env.VISION_FALLBACK_MODELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isGeminiModel(model) {
  return model.toLowerCase().startsWith('gemini');
}

// OpenRouter model IDs are always "vendor/model".
function isOpenRouterModel(model) {
  return model.includes('/');
}

function hasAnthropicCredentials() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || hasOAuthProfile());
}

export function isVisionConfigured() {
  const model = activeModel();
  if (isOpenRouterModel(model)) return Boolean(process.env.OPENROUTER_API_KEY);
  if (isGeminiModel(model)) return Boolean(process.env.GEMINI_API_KEY);
  return hasAnthropicCredentials();
}

// Tolerant parser: strips code fences, finds the outermost JSON value.
export function parseInvoiceJson(text) {
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const candidates = [t];
  const firstBrace = t.indexOf('{');
  const lastBrace = t.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(t.slice(firstBrace, lastBrace + 1));
  const firstBracket = t.indexOf('[');
  const lastBracket = t.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) candidates.push(t.slice(firstBracket, lastBracket + 1));

  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      const arr = Array.isArray(v) ? v : Array.isArray(v?.invoices) ? v.invoices : null;
      if (arr) return normalize(arr);
    } catch {
      // try next candidate
    }
  }
  return null;
}

function toIntOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
}

function normalize(arr) {
  return arr
    .filter((it) => it && typeof it === 'object')
    .map((it) => {
      const number = toIntOrNull(it.number);
      const amount = toIntOrNull(it.amount);
      const lowConfidence = it.confidence === 'low' || number === null || amount === null;
      return {
        number,
        amount: amount ?? 0,
        paid_stamp: Boolean(it.paid_stamp),
        needs_review: lowConfidence
      };
    });
}

// Calls the Google Gemini API directly over REST; returns the raw text reply.
async function readViaGemini(base64Data, mediaType, model) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    const err = new Error('GEMINI_API_KEY is not configured');
    err.code = 'NO_KEY';
    throw err;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const request = (generationConfig) =>
    fetch(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      // Overloaded models can hang for minutes — cap the wait so the
      // fallback chain gets its turn while the owner is still looking.
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ inlineData: { mimeType: mediaType, data: base64Data } }, { text: PROMPT }]
          }
        ],
        generationConfig
      })
    });

  let res = await request({ responseMimeType: 'application/json', responseSchema: GEMINI_SCHEMA });
  if (res.status === 400) {
    // Schema dialect mismatch on some models — fall back to plain JSON mode.
    res = await request({ responseMimeType: 'application/json' });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini API error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts || [])
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('');
}

// Calls OpenRouter's OpenAI-compatible API; returns the raw text reply.
// No response_format is sent so any vision model works — the prompt demands
// bare JSON and parseInvoiceJson() tolerates fences/prose anyway.
async function readViaOpenRouter(base64Data, mediaType, model) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    const err = new Error('OPENROUTER_API_KEY is not configured');
    err.code = 'NO_KEY';
    throw err;
  }

  // OpenRouter natively supports a fallback list, but only of its own
  // vendor/model IDs — cross-provider fallbacks are handled by the caller.
  const fallbacks = fallbackModels().filter((m) => isOpenRouterModel(m));

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model,
      ...(fallbacks.length > 0 ? { models: [model, ...fallbacks] } : {}),
      // ~35 output tokens per invoice; a photo holds at most a dozen stubs.
      // Keep the cap modest so scans work even on a near-empty balance.
      max_tokens: 1500,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64Data}` } },
            { type: 'text', text: PROMPT }
          ]
        }
      ]
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenRouter API error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => typeof p?.text === 'string')
      .map((p) => p.text)
      .join('');
  }
  return '';
}

// Calls the Anthropic Messages API via the SDK; returns the raw text reply.
async function readViaAnthropic(base64Data, mediaType, model) {
  const c = getClient();
  if (!c) {
    const err = new Error('Anthropic credentials are not configured');
    err.code = 'NO_KEY';
    throw err;
  }

  const baseParams = {
    model,
    max_tokens: 4000,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
          { type: 'text', text: PROMPT }
        ]
      }
    ]
  };

  let response;
  try {
    // Structured outputs guarantee parseable JSON on supporting models.
    response = await c.messages.create({
      ...baseParams,
      output_config: { format: { type: 'json_schema', schema: SCHEMA } }
    });
  } catch (e) {
    if (e instanceof Anthropic.BadRequestError) {
      // Model/feature mismatch — fall back to plain prompting + tolerant parsing.
      response = await c.messages.create(baseParams);
    } else {
      throw e;
    }
  }

  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function readOnce(base64Data, mediaType, model) {
  if (isOpenRouterModel(model)) return readViaOpenRouter(base64Data, mediaType, model);
  if (isGeminiModel(model)) return readViaGemini(base64Data, mediaType, model);
  return readViaAnthropic(base64Data, mediaType, model);
}

export async function readInvoicesFromImage(base64Data, mediaType) {
  // Try the primary model, then each fallback (possibly other providers).
  const candidates = [...new Set([activeModel(), ...fallbackModels()])];
  let lastError = null;

  for (const model of candidates) {
    let text;
    try {
      text = await readOnce(base64Data, mediaType, model);
    } catch (e) {
      // A missing key for the PRIMARY model is a configuration problem the
      // owner must hear about; for fallbacks it just means "skip".
      if (e.code === 'NO_KEY' && model === candidates[0] && candidates.length === 1) throw e;
      lastError = e;
      console.error(`vision: ${model} failed, trying next:`, e.message);
      continue;
    }
    const rows = parseInvoiceJson(text);
    if (rows) return rows;
    lastError = Object.assign(new Error(`Could not parse output of ${model} as JSON`), {
      code: 'PARSE_FAILED'
    });
  }

  throw lastError ?? Object.assign(new Error('No vision model configured'), { code: 'NO_KEY' });
}
