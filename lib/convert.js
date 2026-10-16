import { requestId } from "./log.js";

/** Anthropic Messages request body -> OpenAI chat messages + tools. */
export function anthropicToOpenAI(body) {
  const messages = [];
  if (body.system) {
    const sys =
      typeof body.system === "string"
        ? body.system
        : Array.isArray(body.system)
          ? body.system.map((b) => b.text || "").join("\n")
          : "";
    if (sys) messages.push({ role: "system", content: sys });
  }
  for (const msg of body.messages || []) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const text = msg.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const toolUses = msg.content.filter((b) => b.type === "tool_use");
      if (toolUses.length && msg.role === "assistant") {
        messages.push({
          role: "assistant",
          content: text || null,
          tool_calls: toolUses.map((t) => ({
            id: t.id,
            type: "function",
            function: { name: t.name, arguments: JSON.stringify(t.input || {}) },
          })),
        });
      } else if (msg.content.some((b) => b.type === "tool_result")) {
        for (const b of msg.content.filter((b) => b.type === "tool_result")) {
          const resultText =
            typeof b.content === "string"
              ? b.content
              : Array.isArray(b.content)
                ? b.content.map((c) => c.text || "").join("\n")
                : "";
          messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: resultText });
        }
      } else {
        messages.push({ role: msg.role, content: text });
      }
    }
  }

  const tools = (body.tools || []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || {},
    },
  }));

  return { messages, tools: tools.length ? tools : undefined };
}

/** OpenAI chat completion JSON -> Anthropic message JSON. */
export function openAIToAnthropic(oaiResp, model, inputTokens) {
  const choice = oaiResp.choices?.[0];
  if (!choice) {
    return {
      id: requestId("msg"),
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "" }],
      model,
      stop_reason: "end_turn",
      usage: {
        input_tokens: inputTokens || 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    };
  }

  const content = [];
  if (choice.message?.content) {
    content.push({ type: "text", text: choice.message.content });
  }
  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input = {};
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        /* keep {} */
      }
      content.push({
        type: "tool_use",
        id: tc.id || requestId("toolu"),
        name: tc.function.name,
        input,
      });
    }
  }
  if (!content.length) content.push({ type: "text", text: "" });

  let stopReason = "end_turn";
  if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
  else if (choice.finish_reason === "length") stopReason = "max_tokens";
  else if (choice.finish_reason === "stop") stopReason = "end_turn";

  return {
    id: requestId("msg"),
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    usage: {
      input_tokens: oaiResp.usage?.prompt_tokens || inputTokens || 0,
      output_tokens: oaiResp.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

/**
 * Translate one OpenAI SSE `data:` payload into Anthropic SSE event strings.
 * Stateful via `state`. Returns array of wire strings (may be empty).
 * Pure function — no buffering of the whole stream; caller keeps leftover line buffer.
 */
export function translateOpenAIDelta(parsed, state) {
  const out = [];
  const send = (event, data) =>
    out.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const delta = parsed.choices?.[0]?.delta;
  if (!delta && !parsed.choices?.[0]?.finish_reason) return out;

  if (!state.headersSent) {
    state.headersSent = true;
    send("message_start", {
      type: "message_start",
      message: {
        id: state.msgId,
        type: "message",
        role: "assistant",
        content: [],
        model: state.model,
        stop_reason: null,
        usage: {
          input_tokens: state.inputTokens || 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
  }

  if (delta?.content) {
    if (state.contentIdx === 0 && state.toolIdx === -1) {
      send("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      state.contentIdx = 1;
    }
    send("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: delta.content },
    });
    state.outputTokens += Math.ceil(delta.content.length / 4);
  }

  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      if (idx > state.toolIdx) {
        if (state.toolIdx === -1 && state.contentIdx > 0) {
          send("content_block_stop", { type: "content_block_stop", index: 0 });
        }
        state.toolIdx = idx;
        const blockIdx = state.contentIdx > 0 ? idx + 1 : idx;
        send("content_block_start", {
          type: "content_block_start",
          index: blockIdx,
          content_block: {
            type: "tool_use",
            id: tc.id || requestId("toolu"),
            name: tc.function?.name || "",
          },
        });
      }
      if (tc.function?.arguments) {
        const blockIdx = state.contentIdx > 0 ? idx + 1 : idx;
        send("content_block_delta", {
          type: "content_block_delta",
          index: blockIdx,
          delta: { type: "input_json_delta", partial_json: tc.function.arguments },
        });
        state.outputTokens += Math.ceil(tc.function.arguments.length / 4);
      }
    }
  }

  const fr = parsed.choices?.[0]?.finish_reason;
  if (fr) {
    const totalBlocks =
      (state.contentIdx > 0 ? 1 : 0) + (state.toolIdx >= 0 ? state.toolIdx + 1 : 0);
    for (let i = 0; i < totalBlocks; i++) {
      send("content_block_stop", { type: "content_block_stop", index: i });
    }
    let stopReason = "end_turn";
    if (fr === "tool_calls") stopReason = "tool_use";
    else if (fr === "length") stopReason = "max_tokens";
    send("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason },
      usage: { output_tokens: state.outputTokens },
    });
    send("message_stop", { type: "message_stop" });
  }
  return out;
}

export function newAnthropicStreamState(model, inputTokens) {
  return {
    msgId: requestId("msg"),
    model,
    inputTokens: inputTokens || 0,
    headersSent: false,
    contentIdx: 0,
    toolIdx: -1,
    outputTokens: 0,
  };
}
