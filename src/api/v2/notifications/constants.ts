/**
 * Maximum number of consecutive push notification failures before logging warnings
 * Note: Does not auto-disable devices; threshold is for monitoring only
 */
export const MAX_PUSH_FAILURES = 50;

// APNS standard alert payload limit (Apple spec — measured as JSON body bytes,
// HTTP/2 headers separate). Authorization JWT is in headers, NOT counted.
export const APNS_MAX_PAYLOAD_BYTES = 4096;

// FCM HTTP v1 message size limit (Google spec — measured as the message envelope
// including data, android, and the apiJWT field which IS in the body).
export const FCM_MAX_PAYLOAD_BYTES = 4096;

// Safety margin absorbed by the strip threshold.
// Covers: JSON encoding deltas, future field additions, JWT claim growth (the
// in-body apiJWT is ~363 B today; bound for ~600 B). Strip threshold = limit - margin.
// Conservative so reactive retry ~never fires.
export const PUSH_PAYLOAD_STRIP_MARGIN_BYTES = 296;
