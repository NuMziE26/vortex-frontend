import { CHAINS, DST_TOKENS, SRC_TOKENS } from "@/lib/marketData";
import type { FeedItem, IntentStatus } from "@/lib/types";
import {
  addUtcBucket,
  autoGranularity,
  startOfUtcBucket,
  utcBucketKey,
  type Granularity,
} from "@/lib/time";

export type AnalyticsBreakdownEntry = {
  label: string;
  value: number;
  percent: number;
  color: string;
};

export type AnalyticsRouteEntry = {
  sourceChain: string;
  destinationToken: string;
  value: number;
  count: number;
  color: string;
};

export type AnalyticsVolumePoint = {
  date: string;
  totalVolumeUsd: number;
};

export type AnalyticsSummary = {
  totalIntents: number;
  totalVolumeUsd: number;
  rollingVolumeUsd: number;
  averageVolumeUsd: number;
  statusCounts: Record<IntentStatus, number>;
  chainBreakdown: AnalyticsBreakdownEntry[];
  destinationTokenBreakdown: AnalyticsBreakdownEntry[];
  routeBreakdown: AnalyticsRouteEntry[];
  volumeOverTime: AnalyticsVolumePoint[];
  granularity: Granularity;
  from: string;
  to: string;
  ignoredRows: number;
};

export type ComputeAnalyticsOptions = {
  from: Date;
  to: Date;
  granularity: Granularity;
  now: Date;
};

/**
 * Incremental delta applied to the aggregator. `insert` adds a new intent,
 * `update` replaces an existing intent (e.g. status change) and `remove`
 * evicts an intent by id. Deltas are keyed by `intent.id` so ordering across
 * messages does not matter as long as each id is applied at most once per
 * state transition.
 */
export type AnalyticsDelta =
  | { type: "insert"; intent: FeedItem }
  | { type: "update"; intent: FeedItem }
  | { type: "remove"; id: string };

const STATUS_KEYS: IntentStatus[] = ["pending", "accepted", "filled", "failed"];

function getTokenPriceUsd(srcChain: string, tokenSymbol: string): number {
  const chainTokens = SRC_TOKENS[srcChain] ?? [];
  const exactMatch = chainTokens.find((token) => token.symbol === tokenSymbol);
  if (exactMatch) return exactMatch.priceUSD;

  const dstToken = DST_TOKENS.find((token) => token.symbol === tokenSymbol);
  if (dstToken) return dstToken.priceUSD;

  return 1;
}

function getChainColor(chainId: string): string {
  return CHAINS.find((chain) => chain.id === chainId)?.color ?? "#4CEBA8";
}

function emptyStatusCounts(): Record<IntentStatus, number> {
  return { pending: 0, accepted: 0, filled: 0, failed: 0 };
}

/**
 * Incremental analytics aggregator. Both the synchronous `computeAnalytics`
 * helper and the Web Worker wrap this class so that incremental updates stay
 * equivalent to a full recompute. The class keeps per-intent contributions so
 * that `update`/`remove` can subtract the previous contribution before adding
 * the new one.
 */
export class AnalyticsAggregator {
  private readonly options: ComputeAnalyticsOptions;
  private readonly granularity: Granularity;
  private readonly fromMs: number;
  private readonly toMs: number;
  private readonly nowMs: number;
  private readonly sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  private readonly intents = new Map<string, FeedItem>();
  private readonly contributions = new Map<string, number>();

  private statusCounts: Record<IntentStatus, number> = emptyStatusCounts();
  private readonly chainMap = new Map<string, number>();
  private readonly destinationTokenMap = new Map<string, number>();
  private readonly routeMap = new Map<
    string,
    { sourceChain: string; destinationToken: string; value: number; count: number; color: string }
  >();
  private readonly volumeByBucket = new Map<string, number>();

  private totalVolumeUsd = 0;
  private rollingVolumeUsd = 0;
  private ignoredRows = 0;

  constructor(intents: FeedItem[], options: ComputeAnalyticsOptions) {
    this.options = options;
    this.granularity = autoGranularity(options.from, options.to, options.granularity);
    this.fromMs = options.from.getTime();
    this.toMs = options.to.getTime();
    this.nowMs = options.now.getTime();

    for (const intent of intents) {
      this.add(intent);
    }
  }

  /** Apply a single delta. Returns true when the aggregator state changed. */
  apply(delta: AnalyticsDelta): boolean {
    switch (delta.type) {
      case "insert":
        return this.add(delta.intent);
      case "update":
        return this.update(delta.intent);
      case "remove":
        return this.remove(delta.id);
      default:
        return false;
    }
  }

  /** Apply a batch of deltas in order. */
  applyAll(deltas: AnalyticsDelta[]): void {
    for (const delta of deltas) {
      this.apply(delta);
    }
  }

  add(intent: FeedItem): boolean {
    if (this.intents.has(intent.id)) {
      return this.update(intent);
    }

    const createdAtMs = new Date(intent.createdAt).getTime();
    if (!Number.isFinite(createdAtMs)) {
      this.ignoredRows += 1;
      this.intents.set(intent.id, intent);
      this.contributions.set(intent.id, 0);
      return true;
    }

    const amount = Number.parseFloat(intent.srcAmount ?? "0");
    const tokenPriceUsd = getTokenPriceUsd(intent.srcChain, intent.srcToken);
    const volumeUsd = Number.isFinite(amount) ? amount * tokenPriceUsd : 0;

    this.intents.set(intent.id, intent);
    this.contributions.set(intent.id, volumeUsd);

    this.totalVolumeUsd += volumeUsd;

    if (createdAtMs >= this.fromMs && createdAtMs <= this.toMs) {
      const bucketKey = utcBucketKey(new Date(createdAtMs), this.granularity);
      this.volumeByBucket.set(bucketKey, (this.volumeByBucket.get(bucketKey) ?? 0) + volumeUsd);
    }

    if (this.nowMs - createdAtMs <= this.sevenDaysMs) {
      this.rollingVolumeUsd += volumeUsd;
    }

    this.statusCounts[intent.status] += 1;

    this.chainMap.set(intent.srcChain, (this.chainMap.get(intent.srcChain) ?? 0) + volumeUsd);
    this.destinationTokenMap.set(
      intent.dstToken,
      (this.destinationTokenMap.get(intent.dstToken) ?? 0) + volumeUsd,
    );

    const routeKey = `${intent.srcChain}:${intent.dstToken}`;
    const routeEntry = this.routeMap.get(routeKey) ?? {
      sourceChain: intent.srcChain,
      destinationToken: intent.dstToken,
      value: 0,
      count: 0,
      color: getChainColor(intent.srcChain),
    };

    routeEntry.value += volumeUsd;
    routeEntry.count += 1;
    this.routeMap.set(routeKey, routeEntry);

    return true;
  }

  update(intent: FeedItem): boolean {
    const previous = this.intents.get(intent.id);
    if (!previous) {
      return this.add(intent);
    }

    this.remove(intent.id);
    return this.add(intent);
  }

  remove(id: string): boolean {
    const intent = this.intents.get(id);
    if (!intent) {
      return false;
    }

    const volumeUsd = this.contributions.get(id) ?? 0;
    const createdAtMs = new Date(intent.createdAt).getTime();

    this.intents.delete(id);
    this.contributions.delete(id);

    if (!Number.isFinite(createdAtMs)) {
      this.ignoredRows = Math.max(0, this.ignoredRows - 1);
      return true;
    }

    this.totalVolumeUsd -= volumeUsd;

    if (createdAtMs >= this.fromMs && createdAtMs <= this.toMs) {
      const bucketKey = utcBucketKey(new Date(createdAtMs), this.granularity);
      const next = (this.volumeByBucket.get(bucketKey) ?? 0) - volumeUsd;
      if (next === 0) {
        this.volumeByBucket.delete(bucketKey);
      } else {
        this.volumeByBucket.set(bucketKey, next);
      }
    }

    if (this.nowMs - createdAtMs <= this.sevenDaysMs) {
      this.rollingVolumeUsd -= volumeUsd;
    }

    this.statusCounts[intent.status] = Math.max(0, this.statusCounts[intent.status] - 1);

    const chainNext = (this.chainMap.get(intent.srcChain) ?? 0) - volumeUsd;
    if (chainNext === 0) {
      this.chainMap.delete(intent.srcChain);
    } else {
      this.chainMap.set(intent.srcChain, chainNext);
    }

    const tokenNext = (this.destinationTokenMap.get(intent.dstToken) ?? 0) - volumeUsd;
    if (tokenNext === 0) {
      this.destinationTokenMap.delete(intent.dstToken);
    } else {
      this.destinationTokenMap.set(intent.dstToken, tokenNext);
    }

    const routeKey = `${intent.srcChain}:${intent.dstToken}`;
    const routeEntry = this.routeMap.get(routeKey);
    if (routeEntry) {
      routeEntry.value -= volumeUsd;
      routeEntry.count -= 1;
      if (routeEntry.count <= 0) {
        this.routeMap.delete(routeKey);
      }
    }

    return true;
  }

  /** Produce an immutable snapshot equivalent to a full recompute. */
  snapshot(): AnalyticsSummary {
    const { from, to } = this.options;
    const totalVolumeUsd = this.totalVolumeUsd;

    const chainBreakdown = [...this.chainMap.entries()]
      .map(([label, value]) => ({
        label,
        value,
        percent: totalVolumeUsd > 0 ? (value / totalVolumeUsd) * 100 : 0,
        color: getChainColor(label),
      }))
      .sort((a, b) => b.value - a.value);

    const destinationTokenBreakdown = [...this.destinationTokenMap.entries()]
      .map(([label, value]) => ({
        label,
        value,
        percent: totalVolumeUsd > 0 ? (value / totalVolumeUsd) * 100 : 0,
        color: DST_TOKENS.find((token) => token.symbol === label)?.symbol === "XLM"
          ? "#4CEBA8"
          : "#A78BFA",
      }))
      .sort((a, b) => b.value - a.value);

    const routeBreakdown = [...this.routeMap.values()]
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)
      .map((entry) => ({
        ...entry,
        color: entry.color,
      }));

    const volumeOverTime = buildVolumeSeries(this.volumeByBucket, from, to, this.granularity);
    const totalIntents = this.intents.size;

    return {
      totalIntents,
      totalVolumeUsd,
      rollingVolumeUsd: this.rollingVolumeUsd,
      averageVolumeUsd: totalIntents > 0 ? totalVolumeUsd / totalIntents : 0,
      statusCounts: { ...this.statusCounts },
      chainBreakdown,
      destinationTokenBreakdown,
      routeBreakdown,
      volumeOverTime,
      granularity: this.granularity,
      from: from.toISOString(),
      to: to.toISOString(),
      ignoredRows: this.ignoredRows,
    };
  }
}

/**
 * Pure analytics computation. Time is injected via `options.now`; no Date.now()
 * is called internally. Buckets are computed in UTC and empty buckets are
 * filled with zeros. Rows with invalid timestamps are ignored and counted.
 *
 * Delegates to `AnalyticsAggregator` so the synchronous path and the worker
 * path share the same core and stay equivalent.
 */
export function computeAnalytics(
  intents: FeedItem[],
  options: ComputeAnalyticsOptions,
): AnalyticsSummary {
  return new AnalyticsAggregator(intents, options).snapshot();
}

function buildVolumeSeries(
  volumeByBucket: Map<string, number>,
  from: Date,
  to: Date,
  granularity: Granularity,
): AnalyticsVolumePoint[] {
  if (to.getTime() < from.getTime()) {
    return [];
  }

  const points: AnalyticsVolumePoint[] = [];
  let cursor = startOfUtcBucket(from, granularity);
  const end = to.getTime();

  while (cursor.getTime() <= end) {
    const key = utcBucketKey(cursor, granularity);
    points.push({
      date: key,
      totalVolumeUsd: volumeByBucket.get(key) ?? 0,
    });
    cursor = addUtcBucket(cursor, granularity);
  }

  return points;
}

export function getStatusChartColors() {
  return {
    pending: "#FBBF24",
    accepted: "#60A5FA",
    filled: "#4CEBA8",
    failed: "#F87171",
  } as const;
}

export function getStatusDistributionEntries(statusCounts: Record<IntentStatus, number>) {
  const total = STATUS_KEYS.reduce((sum, status) => sum + statusCounts[status], 0);

  return STATUS_KEYS.map((status) => ({
    status,
    count: statusCounts[status],
    percent: total > 0 ? (statusCounts[status] / total) * 100 : 0,
    color: getStatusChartColors()[status],
  }));
}
