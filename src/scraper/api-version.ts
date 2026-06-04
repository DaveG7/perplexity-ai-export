/**
 * Perplexity versions its REST endpoints via a `?version=X.Y` query param
 * (e.g. `/rest/thread/list_ask_threads?version=2.18`). Both library discovery
 * and conversation extraction hit `/rest/` endpoints, so they share this default
 * to keep the version in one place rather than duplicating the literal.
 */
export const DEFAULT_API_VERSION = '2.18'
