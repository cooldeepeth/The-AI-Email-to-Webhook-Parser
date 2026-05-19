import { env } from "@/lib/env";

export interface AiParseInput {
  schemaInstructions: string;
  subject: string;
  from: string;
  body: string;
}

export interface AiParseResult {
  json: Record<string, unknown>;
  rawModelText: string;
  model: string;
}

const SYSTEM_PROMPT =
  "You are a deterministic data-extraction engine. You are given the " +
  "instructions/JSON schema a developer expects, plus the raw text of an " +
  "inbound email. Extract the requested fields and respond with ONLY a " +
  "single valid JSON object that matches the requested schema. Do not " +
  "include markdown, code fences, comments, or any prose. If a value " +
  "cannot be found in the email, use null for that key. Never invent data.";

function buildUserPrompt(input: AiParseInput): string {
  return [
    "### Developer schema / extraction instructions",
    input.schemaInstructions,
    "",
    "### Inbound email",
    `From: ${input.from}`,
    `Subject: ${input.subject}`,
    "",
    "Body:",
    input.body,
    "",
    "Return ONLY the JSON object.",
  ].join("\n");
}

/**
 * Robustly coerce a model response into a JSON object. LLMs sometimes wrap
 * output in ```json fences or add a stray sentence, so we strip fences and
 * fall back to the outermost {...} span before parsing.
 */
export function extractJson(text: string): Record<string, unknown> {
  const cleaned = text
    .replace(/^﻿/, "")
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();

  const candidates: string[] = [cleaned];
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first !== -1 && last > first) {
    candidates.push(cleaned.slice(first, last + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try next candidate
    }
  }
  throw new Error("Model did not return a parseable JSON object");
}

async function callAnthropic(input: AiParseInput): Promise<AiParseResult> {
  const model = env.anthropicModel;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.aiTimeoutMs);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": env.anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: buildUserPrompt(input) }],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Anthropic API ${res.status}: ${detail.slice(0, 500)}`);
    }
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const rawModelText =
      data.content
        ?.filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("") ?? "";
    return { json: extractJson(rawModelText), rawModelText, model };
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAi(input: AiParseInput): Promise<AiParseResult> {
  const model = env.openaiModel;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.aiTimeoutMs);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.openaiApiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(input) },
        ],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`OpenAI API ${res.status}: ${detail.slice(0, 500)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const rawModelText = data.choices?.[0]?.message?.content ?? "";
    return { json: extractJson(rawModelText), rawModelText, model };
  } finally {
    clearTimeout(timer);
  }
}

export async function parseEmailWithAi(
  input: AiParseInput,
): Promise<AiParseResult> {
  return env.aiProvider === "openai"
    ? callOpenAi(input)
    : callAnthropic(input);
}
