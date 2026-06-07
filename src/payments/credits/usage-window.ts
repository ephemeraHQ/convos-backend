// Single source of truth for the bucket granularities — the request schema
// builds its enum from this so the two can't drift.
export const USAGE_BUCKETS = ["day", "week", "month"] as const;
export type UsageBucket = (typeof USAGE_BUCKETS)[number];

/**
 * Truncate a date down to the start of its bucket, in UTC. Mirrors Postgres
 * `date_trunc` so the JS zero-fill produces the same bucket keys the SQL
 * aggregation does: weeks start Monday, months start the 1st.
 */
export const truncUtcBucket = (d: Date, bucket: UsageBucket): Date => {
  const x = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  if (bucket === "month") {
    x.setUTCDate(1);
    return x;
  }
  if (bucket === "week") {
    const sinceMonday = (x.getUTCDay() + 6) % 7; // getUTCDay: 0=Sun..6=Sat
    x.setUTCDate(x.getUTCDate() - sinceMonday);
  }
  return x;
};

/** Start of the bucket immediately after `d`'s bucket, in UTC. */
export const nextUtcBucket = (d: Date, bucket: UsageBucket): Date => {
  const x = new Date(d);
  if (bucket === "month") x.setUTCMonth(x.getUTCMonth() + 1);
  else x.setUTCDate(x.getUTCDate() + (bucket === "week" ? 7 : 1));
  return x;
};
