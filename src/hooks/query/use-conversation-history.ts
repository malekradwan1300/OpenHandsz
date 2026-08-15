import { useQuery } from "@tanstack/react-query";
import EventService from "#/api/event-service/event-service.api";
import { useUserConversation } from "#/hooks/query/use-user-conversation";
import type { OpenHandsEvent } from "#/types/agent-server/core";
import { compactRestHistoryEvents } from "#/utils/handle-event-for-ui";

/**
 * Number of persisted events to load on the initial REST history fetch and on
 * each subsequent "scroll-up" page. Keep this small because the Cloud API
 * stores streamed token deltas as individual events; the UI compacts them
 * before rendering. The agent server caps `limit` at 100.
 */
export const INITIAL_HISTORY_PAGE_SIZE = 10;

export interface ConversationHistoryPage {
  /** Events in chronological (oldest → newest) order. */
  events: OpenHandsEvent[];
  /** True when the server has more events older than this page. */
  hasMore: boolean;
  /** Optional `next_page_id` from the server for keyset pagination. */
  nextPageId: string | null;
}

/**
 * Loads the most recent conversation events via REST. The server query is
 * sorted `TIMESTAMP_DESC`, so the first response is a small tail window and
 * can be rendered without loading the full transcript. We reverse the result
 * to chronological order before handing it to callers.
 *
 * Older events are loaded on demand by `useLoadOlderEvents` once the user
 * scrolls up. The WebSocket then connects with `resend_mode='since'` using
 * the latest event's timestamp so we don't re-receive history we already have.
 */
export const useConversationHistory = (conversationId?: string) => {
  const { data: conversation } = useUserConversation(conversationId ?? null);

  return useQuery<ConversationHistoryPage>({
    queryKey: [
      "conversation-history",
      conversationId,
      // Include the conversation's host + key so a backend swap (or a
      // re-provisioned cloud sandbox with a new URL) re-fetches.
      conversation?.conversation_url ?? null,
      conversation?.session_api_key ?? null,
    ],
    enabled: !!conversationId && !!conversation,
    queryFn: async () => {
      if (!conversationId) {
        return { events: [], hasMore: false, nextPageId: null };
      }

      const page = await EventService.searchEvents(
        conversationId,
        conversation?.conversation_url ?? null,
        conversation?.session_api_key ?? null,
        {
          limit: INITIAL_HISTORY_PAGE_SIZE,
          sortOrder: "TIMESTAMP_DESC",
        },
      );

      if (!Array.isArray(page.items)) {
        throw new Error(
          "Invalid conversation history response: expected page.items to be an array.",
        );
      }

      // Reverse so callers can append in chronological order.
      const events = compactRestHistoryEvents([...page.items].reverse());
      return {
        events,
        hasMore:
          !!page.next_page_id || page.items.length >= INITIAL_HISTORY_PAGE_SIZE,
        nextPageId: page.next_page_id ?? null,
      };
    },
    // Keep the cached tail so returning to a conversation renders immediately.
    // A short stale window avoids firing another search request for every
    // route remount, while the WebSocket still catches up events produced while
    // the user was away. Once stale, React Query refreshes the tail in the
    // background; the cached page remains the first render.
    staleTime: 15 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
  });
};
