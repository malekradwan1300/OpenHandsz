import React from "react";
import EventService from "#/api/event-service/event-service.api";
import { useUserConversation } from "#/hooks/query/use-user-conversation";
import { useEventStore } from "#/stores/use-event-store";
import {
  INITIAL_HISTORY_PAGE_SIZE,
  useConversationHistory,
} from "#/hooks/query/use-conversation-history";
import { isTaskConversationId } from "#/utils/conversation-local-storage";
import { seedModelSwitchesFromHistory } from "#/hooks/chat/record-model-switch-message";
import type { OpenHandsEvent } from "#/types/agent-server/core";
import {
  compactRestHistoryEvents,
  countConversationMessages,
} from "#/utils/handle-event-for-ui";

const getEventTimestamp = (event: OpenHandsEvent): string | undefined =>
  "timestamp" in event ? event.timestamp : undefined;

/** Number of user/AI messages visible after the initial background fill. */
export const INITIAL_CONVERSATION_MESSAGE_COUNT = 10;

interface UseLoadOlderEventsResult {
  /** True while a "load older" request is in flight. */
  isLoading: boolean;
  /**
   * Whether the server may have more events older than what we currently
   * have in the store. Starts `true` and flips to `false` after the server
   * returns a short page (i.e. it ran out of older events).
   */
  hasMore: boolean;
  /**
   * Load older pages until the requested number of logical user/AI messages is
   * present. With no target, one logical batch is loaded for a manual scroll.
   */
  loadOlder: (targetMessageCount?: number) => Promise<void>;
}

/**
 * REST-side companion to `useConversationHistory`: paginates older events
 * (`timestamp < oldest known`) into the event store on demand. Used by the
 * chat scroll handler to lazily backfill history when the user scrolls up.
 *
 * Server dependency: cloud pagination requires the timestamp comparison
 * fix from OpenHands/OpenHands#14399. The `EventService.searchEvents`
 * cloud path includes a fallback that returns an empty page to stop
 * pagination if the full request fails, so older-event pages will
 * gracefully degrade to a no-op on unpatched backends rather than
 * surfacing errors.
 */
export const useLoadOlderEvents = (
  conversationId?: string | null,
): UseLoadOlderEventsResult => {
  const isTaskConversation =
    !!conversationId && isTaskConversationId(conversationId);
  const realConversationId = isTaskConversation ? undefined : conversationId;

  const { data: conversation } = useUserConversation(conversationId ?? null);
  const { data: initialHistory, isFetched: isInitialHistoryFetched } =
    useConversationHistory(realConversationId ?? undefined);
  const addEvents = useEventStore((state) => state.addEvents);
  const uiEvents = useEventStore((state) => state.uiEvents);

  const [isLoading, setIsLoading] = React.useState(false);
  const [hasMore, setHasMore] = React.useState(true);
  const isLoadingRef = React.useRef(false);
  const hasMoreRef = React.useRef(true);
  const nextPageIdRef = React.useRef<string | null>(null);
  const lastRequestKeyRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    isLoadingRef.current = false;
    nextPageIdRef.current = null;
    lastRequestKeyRef.current = null;
    setIsLoading(false);

    if (isTaskConversation) {
      hasMoreRef.current = false;
      setHasMore(false);
      return;
    }

    hasMoreRef.current = true;
    setHasMore(true);
  }, [conversationId, isTaskConversation]);

  // Prefer the server cursor returned by the initial tail page. Cloud uses an
  // opaque page id (for example "25") for its event stream; using it avoids
  // timestamp parsing/filtering on the App API and prevents fetching the same
  // tail repeatedly. The timestamp path remains a compatibility fallback for
  // older/local servers that do not return a cursor.
  React.useEffect(() => {
    if (isTaskConversation || !initialHistory) return;
    nextPageIdRef.current = initialHistory.nextPageId;
    lastRequestKeyRef.current = null;
  }, [initialHistory, isTaskConversation]);

  // Mirror the initial REST page: if the tail fetch already returned
  // everything, don't auto-trigger an older-events request on short chats.
  React.useEffect(() => {
    if (isTaskConversation || !isInitialHistoryFetched || !initialHistory) {
      return;
    }
    if (!initialHistory.hasMore) {
      hasMoreRef.current = false;
      setHasMore(false);
    }
  }, [
    isTaskConversation,
    isInitialHistoryFetched,
    initialHistory?.hasMore,
    realConversationId,
  ]);

  const loadOlder = React.useCallback(
    async (targetMessageCount?: number) => {
      if (
        !conversationId ||
        isTaskConversationId(conversationId) ||
        isLoadingRef.current ||
        !hasMoreRef.current
      ) {
        return;
      }

      // Cloud/local metadata (runtime URL, session key) isn't available on
      // start-task placeholder routes and may still be loading right after
      // redirect from `/conversations/task-{uuid}`.
      if (!conversation) {
        return;
      }

      const desiredMessageCount =
        targetMessageCount ??
        countConversationMessages(useEventStore.getState().uiEvents) +
          INITIAL_CONVERSATION_MESSAGE_COUNT;

      isLoadingRef.current = true;
      setIsLoading(true);
      const bufferedOlderEvents: OpenHandsEvent[] = [];

      try {
        while (
          hasMoreRef.current &&
          countConversationMessages([
            ...useEventStore.getState().uiEvents,
            ...bufferedOlderEvents,
          ]) < desiredMessageCount
        ) {
          const { events } = useEventStore.getState();
          const oldest = events[0];

          // No anchor yet — defer until the initial REST load has populated the
          // store (avoids fetching twice with the same `TIMESTAMP_DESC` window).
          if (!oldest) {
            // REST has not seeded the store yet. Keep pagination available and
            // let the next history update provide the anchor.
            break;
          }

          const oldestTimestamp = getEventTimestamp(oldest);
          if (!oldestTimestamp) {
            // Nothing paginate-able — treat as exhausted rather than surfacing an
            // error banner on brand-new conversations.
            hasMoreRef.current = false;
            setHasMore(false);
            return;
          }

          const requestKey = nextPageIdRef.current
            ? `page:${nextPageIdRef.current}`
            : `timestamp:${oldestTimestamp}`;
          if (lastRequestKeyRef.current === requestKey) {
            hasMoreRef.current = false;
            setHasMore(false);
            break;
          }
          lastRequestKeyRef.current = requestKey;

          const page = await EventService.searchEvents(
            conversationId,
            conversation?.conversation_url ?? null,
            conversation?.session_api_key ?? null,
            {
              limit: INITIAL_HISTORY_PAGE_SIZE,
              sortOrder: "TIMESTAMP_DESC",
              ...(nextPageIdRef.current
                ? { pageId: nextPageIdRef.current }
                : { timestampLt: oldestTimestamp }),
            },
          );

          if (!Array.isArray(page.items)) {
            throw new Error(
              "Invalid older-events response: expected page.items to be an array.",
            );
          }

          const older = compactRestHistoryEvents([...page.items].reverse());
          if (older.length > 0) {
            // Keep pagination network-bound but commit the complete logical batch
            // in one store update. This prevents one React/Zustand render per
            // page while the background collector assembles the visible window.
            bufferedOlderEvents.push(...older);
          }
          // A cursor is authoritative when supplied. Without a cursor, a short
          // page is the compatibility signal that timestamp pagination is done.
          nextPageIdRef.current = page.next_page_id ?? null;
          const exhausted =
            !nextPageIdRef.current &&
            page.items.length < INITIAL_HISTORY_PAGE_SIZE;
          if (exhausted) {
            hasMoreRef.current = false;
            setHasMore(false);
          }
        }

        if (bufferedOlderEvents.length > 0) {
          addEvents(bufferedOlderEvents);
          // The initial preload only seeds switches from the tail page; a switch
          // in an older page is hidden as a card but never seeded — silently lost.
          // Reseed once over the merged `uiEvents` so it still surfaces.
          seedModelSwitchesFromHistory(
            conversationId,
            useEventStore.getState().uiEvents,
          );
        }
      } finally {
        isLoadingRef.current = false;
        setIsLoading(false);
      }
    },
    [
      conversationId,
      conversation,
      conversation?.conversation_url,
      conversation?.session_api_key,
      addEvents,
      initialHistory,
    ],
  );

  // Fill the first visible window in the background. The initial REST query
  // already renders its newest page; this effect only follows older cursors
  // until ten logical user/AI messages are available, so opening a chat never
  // waits for the whole transcript.
  React.useEffect(() => {
    if (
      isTaskConversation ||
      !isInitialHistoryFetched ||
      !initialHistory?.hasMore ||
      countConversationMessages(uiEvents) >= INITIAL_CONVERSATION_MESSAGE_COUNT
    ) {
      return;
    }

    void loadOlder(INITIAL_CONVERSATION_MESSAGE_COUNT);
  }, [
    isTaskConversation,
    isInitialHistoryFetched,
    initialHistory?.hasMore,
    uiEvents.length,
    loadOlder,
  ]);

  return { isLoading, hasMore, loadOlder };
};
