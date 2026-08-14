/* @vitest-environment node */
import { describe, expect, it } from "vitest";
import { compactRestHistoryEvents } from "#/utils/handle-event-for-ui";
import type { MessageEvent, OpenHandsEvent } from "#/types/agent-server/core";
import type { StreamingDeltaEvent } from "#/types/agent-server/core/events/streaming-delta-event";

const userMessage = (id: string, timestamp: string): MessageEvent =>
  ({
    id,
    timestamp,
    source: "user",
    kind: "MessageEvent",
    llm_message: { role: "user", content: [{ type: "text", text: "hello" }] },
    activated_microagents: [],
    extended_content: [],
  }) as MessageEvent;

const agentMessage = (
  id: string,
  timestamp: string,
  reasoningContent: string | null = null,
): MessageEvent =>
  ({
    id,
    timestamp,
    source: "agent",
    kind: "MessageEvent",
    llm_message: {
      role: "assistant",
      content: [{ type: "text", text: "final" }],
      reasoning_content: reasoningContent,
    },
    activated_microagents: [],
    extended_content: [],
  }) as MessageEvent;

const delta = (
  id: string,
  timestamp: string,
  content: string | null,
  reasoningContent: string | null = null,
): StreamingDeltaEvent =>
  ({
    id,
    timestamp,
    source: "agent",
    kind: "StreamingDeltaEvent",
    content,
    reasoning_content: reasoningContent,
  }) as StreamingDeltaEvent;

describe("compactRestHistoryEvents", () => {
  it("drops historical content deltas superseded by a final agent message", () => {
    const events: OpenHandsEvent[] = [
      userMessage("user-1", "2026-08-13T17:29:35.000000"),
      delta("delta-1", "2026-08-13T17:29:36.000000", "hel"),
      delta("delta-2", "2026-08-13T17:29:36.100000", "lo"),
      agentMessage("agent-1", "2026-08-13T17:29:36.200000"),
    ];

    expect(compactRestHistoryEvents(events).map((event) => event.id)).toEqual([
      "user-1",
      "agent-1",
    ]);
  });

  it("keeps live-tail deltas when no final message is present in the page", () => {
    const events: OpenHandsEvent[] = [
      userMessage("user-1", "2026-08-13T17:29:35.000000"),
      delta("delta-1", "2026-08-13T17:29:36.000000", "still "),
      delta("delta-2", "2026-08-13T17:29:36.100000", "streaming"),
    ];

    expect(compactRestHistoryEvents(events).map((event) => event.id)).toEqual([
      "user-1",
      "delta-1",
      "delta-2",
    ]);
  });

  it("preserves reasoning-only history when the final message lacks reasoning", () => {
    const events: OpenHandsEvent[] = [
      userMessage("user-1", "2026-08-13T17:29:35.000000"),
      delta("delta-1", "2026-08-13T17:29:36.000000", "draft", "thinking"),
      agentMessage("agent-1", "2026-08-13T17:29:36.200000"),
    ];

    expect(compactRestHistoryEvents(events)).toMatchObject([
      { id: "user-1" },
      { id: "delta-1", content: null, reasoning_content: "thinking" },
      { id: "agent-1" },
    ]);
  });
});
