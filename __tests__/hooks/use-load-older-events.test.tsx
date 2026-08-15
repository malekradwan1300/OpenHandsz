import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useLoadOlderEvents } from "#/hooks/use-load-older-events";
import EventService from "#/api/event-service/event-service.api";
import { useUserConversation } from "#/hooks/query/use-user-conversation";
import { useConversationHistory } from "#/hooks/query/use-conversation-history";
import { useEventStore } from "#/stores/use-event-store";
import { useModelStore } from "#/stores/model-store";
import { INITIAL_HISTORY_PAGE_SIZE } from "#/hooks/query/use-conversation-history";
import type { Conversation } from "#/api/open-hands.types";
import type { OpenHandsEvent } from "#/types/agent-server/core";
import type { EventSearchPage } from "#/api/event-service/event-service.types";

vi.mock("#/api/event-service/event-service.api");
vi.mock("#/hooks/query/use-user-conversation");
vi.mock("#/hooks/query/use-conversation-history", async () => {
  const actual = await vi.importActual<
    typeof import("#/hooks/query/use-conversation-history")
  >("#/hooks/query/use-conversation-history");
  return {
    ...actual,
    useConversationHistory: vi.fn(() => ({
      data: undefined,
      isFetched: false,
    })),
  };
});

function makeConversation(): Conversation {
  // Cast: `useUserConversation` actually returns an `AppConversation` whose
  // event-host URL lives on `conversation_url` (not the `Conversation.url`
  // declared above). We mirror that shape here so the hook's call to
  // `conversation.conversation_url` resolves.
  return {
    conversation_id: "conv-test",
    title: "Test Conversation",
    selected_repository: null,
    selected_branch: null,
    git_provider: null,
    last_updated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    status: "RUNNING",
    runtime_status: null,
    url: null,
    conversation_url: "https://example.com/conv-test",
    session_api_key: "secret",
    conversation_version: "V1",
  } as unknown as Conversation;
}

function makeEvent(id: string, timestamp: string): OpenHandsEvent {
  return { id, timestamp } as unknown as OpenHandsEvent;
}

function makeMessage(
  id: string,
  timestamp: string,
  source: "user" | "agent",
): OpenHandsEvent {
  return {
    id,
    timestamp,
    source,
    llm_message: {
      role: source === "user" ? "user" : "assistant",
      content: [{ type: "text", text: `${source}-${id}` }],
    },
    activated_microagents: [],
    extended_content: [],
  } as unknown as OpenHandsEvent;
}

function makePage(
  items: OpenHandsEvent[],
  nextPageId: string | null = null,
): EventSearchPage<OpenHandsEvent> {
  return { items, next_page_id: nextPageId };
}

describe("useLoadOlderEvents", () => {
  let queryClient: QueryClient;
  let wrapper: ({
    children,
  }: {
    children: React.ReactNode;
  }) => React.ReactElement;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    wrapper = ({ children }) =>
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        children,
      );

    // Reset event store between tests so prior tests don't leak state.
    act(() => {
      useEventStore.getState().clearEvents();
      useModelStore.getState().clearAll();
    });

    vi.mocked(useUserConversation).mockReturnValue({
      data: makeConversation(),
      isLoading: false,
      isPending: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any);

    vi.mocked(useConversationHistory).mockReturnValue({
      data: undefined,
      isFetched: false,
    } as ReturnType<typeof useConversationHistory>);
  });

  afterEach(() => {
    queryClient.clear();
    vi.clearAllMocks();
  });

  it("loads pages until the requested number of logical messages is present", async () => {
    act(() => {
      useEventStore
        .getState()
        .addEvents([
          makeMessage("tail-user", "2024-06-01T00:00:00Z", "user"),
          makeMessage("tail-agent", "2024-06-01T00:01:00Z", "agent"),
        ]);
    });
    vi.mocked(useConversationHistory).mockReturnValue({
      data: { events: [], hasMore: true, nextPageId: "page-1" },
      isFetched: true,
    } as unknown as ReturnType<typeof useConversationHistory>);
    const firstPage = [
      makeMessage("p1-user-1", "2024-05-01T00:00:00Z", "user"),
      makeMessage("p1-agent-1", "2024-05-01T00:01:00Z", "agent"),
      makeMessage("p1-user-2", "2024-05-01T00:02:00Z", "user"),
      makeMessage("p1-agent-2", "2024-05-01T00:03:00Z", "agent"),
    ];
    const secondPage = [
      makeMessage("p2-user-1", "2024-04-01T00:00:00Z", "user"),
      makeMessage("p2-agent-1", "2024-04-01T00:01:00Z", "agent"),
      makeMessage("p2-user-2", "2024-04-01T00:02:00Z", "user"),
      makeMessage("p2-agent-2", "2024-04-01T00:03:00Z", "agent"),
    ];
    const spy = vi
      .spyOn(EventService, "searchEvents")
      .mockResolvedValueOnce(makePage([...firstPage].reverse(), "page-2"))
      .mockResolvedValueOnce(makePage([...secondPage].reverse(), "page-3"));

    const { result } = renderHook(() => useLoadOlderEvents("conv-1"), {
      wrapper,
    });
    await act(async () => {
      await result.current.loadOlder(10);
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(
      useEventStore
        .getState()
        .uiEvents.filter(
          (event) => event.source === "user" || event.source === "agent",
        ),
    ).toHaveLength(10);
  });

  it("does nothing while the store has no anchor (REST hasn't seeded yet)", async () => {
    const spy = vi.spyOn(EventService, "searchEvents");
    const { result } = renderHook(() => useLoadOlderEvents("conv-1"), {
      wrapper,
    });

    await act(async () => {
      await result.current.loadOlder();
    });

    expect(spy).not.toHaveBeenCalled();
    expect(result.current.hasMore).toBe(true);
  });

  it("paginates older events using timestamp__lt of the oldest known event", async () => {
    // Seed the store with a single recent event so the hook has an anchor.
    const recent = makeEvent("evt-recent", "2024-06-01T00:00:00Z");
    act(() => {
      useEventStore.getState().addEvent(recent);
    });

    const olderPage = [
      makeEvent("evt-older-1", "2024-05-01T00:00:00Z"),
      makeEvent("evt-older-2", "2024-05-15T00:00:00Z"),
    ];
    const spy = vi
      .spyOn(EventService, "searchEvents")
      .mockResolvedValue(makePage(olderPage, null));

    const { result } = renderHook(() => useLoadOlderEvents("conv-1"), {
      wrapper,
    });

    await act(async () => {
      await result.current.loadOlder();
    });

    expect(spy).toHaveBeenCalledWith(
      "conv-1",
      "https://example.com/conv-test",
      "secret",
      {
        limit: INITIAL_HISTORY_PAGE_SIZE,
        sortOrder: "TIMESTAMP_DESC",
        timestampLt: "2024-06-01T00:00:00Z",
      },
    );

    // Older events landed in the store, in chronological order.
    expect(useEventStore.getState().events.map((e) => (e as any).id)).toEqual([
      "evt-older-1",
      "evt-older-2",
      "evt-recent",
    ]);

    // Server returned a short page → no more pages to load.
    await waitFor(() => {
      expect(result.current.hasMore).toBe(false);
    });
  });

  it("uses the initial Cloud cursor for the next older page", async () => {
    act(() => {
      useEventStore
        .getState()
        .addEvent(makeEvent("evt-recent", "2024-06-01T00:00:00Z"));
    });
    vi.mocked(useConversationHistory).mockReturnValue({
      data: { events: [], hasMore: true, nextPageId: "25" },
      isFetched: true,
      isPending: false,
      isLoading: false,
      isError: false,
      error: null,
      isFetching: false,
      isSuccess: true,
      status: "success",
    } as unknown as ReturnType<typeof useConversationHistory>);

    const spy = vi
      .spyOn(EventService, "searchEvents")
      .mockResolvedValue(
        makePage([makeEvent("evt-old", "2024-05-01T00:00:00Z")], null),
      );

    const { result } = renderHook(() => useLoadOlderEvents("conv-1"), {
      wrapper,
    });

    await act(async () => {
      await result.current.loadOlder();
    });

    expect(spy).toHaveBeenCalledWith(
      "conv-1",
      "https://example.com/conv-test",
      "secret",
      {
        limit: INITIAL_HISTORY_PAGE_SIZE,
        sortOrder: "TIMESTAMP_DESC",
        pageId: "25",
      },
    );
  });

  it("seeds inline model-switch messages for switches in a paginated older page", async () => {
    // A successful SwitchLLMObservation is hidden as a card and surfaced via an
    // inline "Switched to" message seeded from history. The initial preload only
    // seeds the tail page; a switch in an older page must be seeded when that
    // page paginates in, or it vanishes from the transcript entirely.
    const recent = makeEvent("evt-recent", "2024-06-01T00:00:00Z");
    act(() => {
      useEventStore.getState().addEvent(recent);
    });

    // Older page (server returns TIMESTAMP_DESC; the hook reverses it): a user
    // message followed by the agent's successful model switch.
    const userMsg = {
      id: "evt-user-old",
      timestamp: "2024-05-01T00:00:00Z",
      source: "user",
      llm_message: { role: "user", content: [{ type: "text", text: "hi" }] },
      activated_microagents: [],
      extended_content: [],
    } as unknown as OpenHandsEvent;
    const switchObs = {
      id: "evt-switch-old",
      timestamp: "2024-05-02T00:00:00Z",
      source: "environment",
      action_id: "action-switch-old",
      tool_name: "switch_llm",
      tool_call_id: "call-switch-old",
      observation: {
        kind: "SwitchLLMObservation",
        content: [{ type: "text", text: "Switched to fast-opus" }],
        is_error: false,
        profile_name: "fast-opus",
        reason: null,
        active_model: null,
      },
    } as unknown as OpenHandsEvent;

    vi.spyOn(EventService, "searchEvents").mockResolvedValue(
      // Descending order, as the server returns it.
      makePage([switchObs, userMsg], null),
    );

    const { result } = renderHook(() => useLoadOlderEvents("conv-1"), {
      wrapper,
    });

    await act(async () => {
      await result.current.loadOlder();
    });

    // The switch is seeded (idempotent id derived from the observation event),
    // anchored to the renderable user message that precedes it.
    const entries = useModelStore.getState().entriesByConversation["conv-1"];
    expect(entries).toEqual([
      expect.objectContaining({
        id: "history-switch:evt-switch-old",
        switchedTo: "fast-opus",
        anchorEventId: "evt-user-old",
      }),
    ]);
  });

  it("keeps paginating while the server keeps returning full pages", async () => {
    act(() => {
      useEventStore
        .getState()
        .addEvent(makeEvent("evt-recent", "2024-06-01T00:00:00Z"));
    });

    const fullPage: OpenHandsEvent[] = Array.from(
      { length: INITIAL_HISTORY_PAGE_SIZE },
      (_, i) =>
        makeMessage(
          `evt-page1-${i}`,
          // Descending timestamps within the page so newest-first works.
          new Date(2024, 4, 30 - i).toISOString(),
          i % 2 === 0 ? "user" : "agent",
        ),
    );

    vi.spyOn(EventService, "searchEvents").mockResolvedValue(
      makePage(fullPage, "next-page"),
    );

    const { result } = renderHook(() => useLoadOlderEvents("conv-1"), {
      wrapper,
    });

    await act(async () => {
      await result.current.loadOlder();
    });

    // Full page + next_page_id present → still has more.
    expect(result.current.hasMore).toBe(true);
  });

  it("coalesces repeated loadOlder calls while a page request is already in flight", async () => {
    act(() => {
      useEventStore
        .getState()
        .addEvent(makeEvent("evt-recent", "2024-06-01T00:00:00Z"));
    });

    let resolvePage!: (page: EventSearchPage<OpenHandsEvent>) => void;
    const pendingPage = new Promise<EventSearchPage<OpenHandsEvent>>(
      (resolve) => {
        resolvePage = resolve;
      },
    );

    const spy = vi
      .spyOn(EventService, "searchEvents")
      .mockReturnValue(pendingPage);

    const { result } = renderHook(() => useLoadOlderEvents("conv-1"), {
      wrapper,
    });

    let firstLoad!: Promise<void>;
    let secondLoad!: Promise<void>;
    await act(async () => {
      firstLoad = result.current.loadOlder();
      secondLoad = result.current.loadOlder();
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      resolvePage(
        makePage([makeEvent("evt-older", "2024-05-01T00:00:00Z")], null),
      );
      await Promise.all([firstLoad, secondLoad]);
    });

    expect(result.current.isLoading).toBe(false);
  });

  it("cleans up loading state and rethrows when the page request fails", async () => {
    act(() => {
      useEventStore
        .getState()
        .addEvent(makeEvent("evt-recent", "2024-06-01T00:00:00Z"));
    });

    vi.spyOn(EventService, "searchEvents").mockRejectedValue(
      new Error("request failed"),
    );

    const { result } = renderHook(() => useLoadOlderEvents("conv-1"), {
      wrapper,
    });

    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.loadOlder();
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("request failed");
    expect(result.current.isLoading).toBe(false);
    expect(result.current.hasMore).toBe(true);
  });

  it("throws a descriptive error when searchEvents returns malformed items", async () => {
    act(() => {
      useEventStore
        .getState()
        .addEvent(makeEvent("evt-recent", "2024-06-01T00:00:00Z"));
    });

    vi.spyOn(EventService, "searchEvents").mockResolvedValue({
      items: { bad: true },
      next_page_id: null,
    } as unknown as EventSearchPage<OpenHandsEvent>);

    const { result } = renderHook(() => useLoadOlderEvents("conv-1"), {
      wrapper,
    });

    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.loadOlder();
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      "Invalid older-events response: expected page.items to be an array.",
    );
    expect(result.current.isLoading).toBe(false);
    expect(result.current.hasMore).toBe(true);
  });

  it("stops paginating silently when the oldest loaded event is missing a timestamp", async () => {
    act(() => {
      useEventStore
        .getState()
        .addEvent({ id: "evt-missing-ts" } as OpenHandsEvent);
    });

    const spy = vi.spyOn(EventService, "searchEvents");
    const { result } = renderHook(() => useLoadOlderEvents("conv-1"), {
      wrapper,
    });

    await act(async () => {
      await result.current.loadOlder();
    });

    expect(spy).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(result.current.hasMore).toBe(false);
    });
  });

  it("does not paginate on start-task placeholder conversation ids", async () => {
    act(() => {
      useEventStore
        .getState()
        .addEvent(makeEvent("evt-recent", "2024-06-01T00:00:00Z"));
    });

    const spy = vi.spyOn(EventService, "searchEvents");
    const { result } = renderHook(() => useLoadOlderEvents("task-abc"), {
      wrapper,
    });

    expect(result.current.hasMore).toBe(false);

    await act(async () => {
      await result.current.loadOlder();
    });

    expect(spy).not.toHaveBeenCalled();
  });

  it("mirrors initial REST history hasMore=false so short chats do not backfill", async () => {
    vi.mocked(useConversationHistory).mockReturnValue({
      data: {
        events: [makeEvent("evt-only", "2024-06-01T00:00:00Z")],
        hasMore: false,
        nextPageId: null,
      },
      isFetched: true,
    } as ReturnType<typeof useConversationHistory>);

    act(() => {
      useEventStore
        .getState()
        .addEvent(makeEvent("evt-only", "2024-06-01T00:00:00Z"));
    });

    const spy = vi.spyOn(EventService, "searchEvents");
    const { result } = renderHook(() => useLoadOlderEvents("conv-1"), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.hasMore).toBe(false);
    });

    await act(async () => {
      await result.current.loadOlder();
    });

    expect(spy).not.toHaveBeenCalled();
  });
});
