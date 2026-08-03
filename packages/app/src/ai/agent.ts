/**
 * The Copilot agent loop. Runs entirely in the browser against the Anthropic
 * API with the user's own key (no backend — this is a static app). It's a
 * manual tool-use loop: ask Claude, execute any tool calls against the live
 * document (ai/execute.ts), feed the results plus a refreshed snapshot of the
 * document back, and repeat until Claude stops calling tools.
 *
 * The full assistant `content` (including thinking blocks) is echoed back each
 * turn, as the API requires for multi-turn tool use on the same model.
 */

import Anthropic from "@anthropic-ai/sdk";
import { useDocumentStore } from "../stores/documentStore";
import { useGeometryStore } from "../stores/geometryStore";
import { executeTool } from "./execute";
import { SYSTEM_PROMPT, buildContext, craftbitTools } from "./tools";

const MAX_TURNS = 40;

export interface AgentCallbacks {
  onText(text: string): void;
  onTool(tool: string, summary: string, ok: boolean): void;
  onError(message: string): void;
}

function snapshot(): string {
  return buildContext(useDocumentStore.getState().doc, useGeometryStore.getState().result);
}

export async function runAgent(
  userText: string,
  opts: { apiKey: string; model: string } & AgentCallbacks,
): Promise<void> {
  const client = new Anthropic({ apiKey: opts.apiKey, dangerouslyAllowBrowser: true });

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `${userText}\n\nCurrent document state:\n${snapshot()}` },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: opts.model,
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        tools: craftbitTools,
        messages,
      });
    } catch (e) {
      opts.onError(errorMessage(e));
      return;
    }

    // Surface any assistant prose.
    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) opts.onText(block.text.trim());
    }

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") return; // done (end_turn / refusal / max_tokens)

    // Execute every tool call, collect results, then hand them all back at once.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const result = await executeTool(block.name, block.input as Record<string, unknown>);
      opts.onTool(block.name, result.text, result.ok);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result.text,
        is_error: !result.ok,
      });
    }

    messages.push({
      role: "user",
      content: [...toolResults, { type: "text", text: `Current document state:\n${snapshot()}` }],
    });
  }

  opts.onError(
    "Reached the step limit for one request. Ask me to continue if the model isn't finished.",
  );
}

function errorMessage(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError)
    return "Invalid API key — check it in the ⚙ settings.";
  if (e instanceof Anthropic.RateLimitError)
    return "Rate limited by Anthropic — wait a moment and retry.";
  if (e instanceof Anthropic.APIError) return `Anthropic API error ${e.status ?? ""}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
