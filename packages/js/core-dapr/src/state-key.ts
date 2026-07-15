/**
 * Dapr's state HTTP API carries the key in the URL PATH on get/delete (`/v1.0/state/<store>/<key>`),
 * while save/getBulk carry keys in the body. A key containing `/` — e.g. a repo segment
 * ("owner/name") inside `wf:owner/name:slug:workflow` or `cron:sub:owner/name:…` — therefore breaks
 * ONLY the path-position calls: the sidecar's router splits on the raw slash and misreads the
 * request as a service invocation, failing with 404 ERR_DIRECT_INVOKE ("failed getting app id").
 * Found live 2026-07-15: `wf:` rows saved fine (body) while the cron store's idempotency read of
 * the very same identity 404'd (path) — no `cron:sub:*` row had ever landed for a slashed repo.
 *
 * Percent-encoding fixes it: the sidecar URL-decodes the path segment before using it as the state
 * key, so the STORED key stays the raw form and body-position writes and encoded path reads meet on
 * the same Redis key. Encode EVERY path-position key with this — the `@dapr/dapr` client does not.
 */
export const pathStateKey = (key: string): string => encodeURIComponent(key);
