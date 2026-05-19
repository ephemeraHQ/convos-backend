/**
 * Maximum number of consecutive push notification failures before logging warnings
 * Note: Does not auto-disable devices; threshold is for monitoring only
 */
export const MAX_PUSH_FAILURES = 50;

// APNS standard alert payload limit (Apple spec).
export const APNS_MAX_PAYLOAD_BYTES = 4096;

// FCM HTTP v1 total message size limit (Google spec).
export const FCM_MAX_PAYLOAD_BYTES = 4096;

// Safety margin for HTTP/2 headers, JSON encoding overhead, JWT growth.
// 296 = ~JWT baseline (~700 B) growth headroom + field add headroom + JSON quote/escape.
// Strip threshold = limit - margin = 3800 B. Conservative so reactive retry ~never fires.
export const PUSH_PAYLOAD_STRIP_MARGIN_BYTES = 296;
