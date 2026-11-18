# ChatGPT chat limits (research, 2026-11-18)

## Question

Can Walder show ChatGPT chat limits (messages left in the ChatGPT app), not only Codex limits?

## Verdict

The earlier statement ("separate from Codex, not readable") is partly correct.

- Today, ordinary ChatGPT chat limits are separate from the Codex/Work allowance. The Codex pricing
  page says ChatGPT Work and Codex share pricing, credits and usage limits; plain chat is not part of
  that.
- No endpoint exposes remaining chat messages.

## Evidence

- **CodexBar issue #3436** (steipete/CodexBar, 5 Sep to 7 Oct 2026). `POST
  /backend-api/conversation/init` returns `blocked_features` / `model_limits` only once a cap is
  already used up. `wham/usage` is the Codex quota and leaves chat out. The maintainer closed it as
  not planned: the allowance is not exposed by any endpoint the app can read.
- Open-source trackers (for example the Greasy Fork "ChatGPT rate limit" script) only count messages
  locally against limits typed in by hand.

## Expected change (secondhand)

help.openai.com answered 403, so this is from search snippets and ARY News (3 Nov 2026). An OpenAI
help article, "Understanding ChatGPT and Codex usage limits" (updated about 31 Oct to 2 Nov 2026),
says that from December 2026:

- Plus, Pro and Business get one shared ChatGPT + Codex allowance.
- Instant chat does not draw from it.
- ChatGPT Settings > Usage shows the remaining usage and reset times.

## Walder today

- `src/providers/chatgpt-codex.ts` reads `GET chatgpt.com/backend-api/wham/usage`, shown as Codex
  5-hour and Codex weekly.
- `src/providers/chatgpt-web.ts` tries `wham/usage`, `conversation_limit` and `models`.
- `DISCOVERY_RE` (`src/providers/endpoint-discovery.ts`) does not match
  `/backend-api/conversation/init`, and should not be changed to: it is a POST that imitates the chat
  client, says something only after the cap is used up, and carries the most terms-of-service risk.

## Plan

1. Build no chat counter now.
2. After the December change ships, open ChatGPT Settings > Usage in Walder's login window, so
   discovery records any new usage path.
3. Check whether `wham/usage` `used_percent` moves after a few advanced-model chats. If it does,
   relabel the Codex rows as the shared ChatGPT + Codex allowance.

The `WARNING_BANNER`-only answer on the web route (F23, in the QA 0.2.8 reports) is a separate bug
and is tracked under Fixes in `docs/OPEN_ITEMS.md`.

## Sources

- https://github.com/steipete/CodexBar/issues/3436
- https://learn.chatgpt.com/docs/pricing
- https://arynews.tv/openai-to-combine-chatgpt-and-codex-usage-limits-for-premium-subscribers
- https://help.openai.com/en/articles/20001625-understanding-chatgpt-and-codex-usage-limits (403;
  seen through search snippets)
- https://greasyfork.org/en/scripts/523365-chatgpt-rate-limit-backend
