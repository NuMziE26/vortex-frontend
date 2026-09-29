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

/**
 * Pure analytics computation. Time is injected via `options.now`; no Date.now()
 * is called internally. Buckets are computed in UTC and empty buckets are
 * filled with zeros. Rows with invalid timestamps are ignored and counted.
 */
export function computeAnalytics(
  intents: FeedItem[],
  options: ComputeAnalyticsOptions,
): AnalyticsSummary {
  const { from, to, now } = options;
  const granularity = autoGranularity(from, to, options.granularity);

  const statusCounts: Record<IntentStatus, number> = {
    pending: 0,
    accepted: 0,
    filled: 0,
    failed: 0,
  };

  const chainMap = new Map<string, number>();
  const destinationTokenMap = new Map<string, number>();
  const routeMap = new Map<string, { sourceChain: string; destinationToken: string; value: number; count: number; color: string }>();
  const volumeByBucket = new Map<string, number>();

  const fromMs = from.getTime();
  const toMs = to.getTime();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const nowMs = now.getTime();

  let totalVolumeUsd = 0;
  let rollingVolumeUsd = 0;
  let ignoredRows = 0;

  for (const intent of intents) {
    const createdAtMs = new Date(intent.createdAt).getTime();
    if (!Number.isFinite(createdAtMs)) {
      ignoredRows += 1;
      continue;
    }

    const amount = Number.parseFloat(intent.srcAmount ?? "0");
    const tokenPriceUsd = getTokenPriceUsd(intent.srcChain, intent.srcToken);
    const volumeUsd = Number.isFinite(amount) ? amount * tokenPriceUsd : 0;

    totalVolumeUsd += volumeUsd;

    if (createdAtMs >= fromMs && createdAtMs <= toMs) {
      const bucketKey = utcBucketKey(new Date(createdAtMs), granularity);
      volumeByBucket.set(bucketKey, (volumeByBucket.get(bucketKey) ?? 0) + volumeUsd);
    }

    if (nowMs - createdAtMs <= sevenDaysMs) {
      rollingVolumeUsd += volumeUsd;
    }

    statusCounts[intent.status] += 1;

    chainMap.set(intent.srcChain, (chainMap.get(intent.srcChain) ?? 0) + volumeUsd);
    destinationTokenMap.set(
      intent.dstToken,
      (destinationTokenMap.get(intent.dstToken) ?? 0) + volumeUsd,
    );

    const routeKey = `${intent.srcChain}:${intent.dstToken}`;
    const routeEntry = routeMap.get(routeKey) ?? {
      sourceChain: intent.srcChain,
      destinationToken: intent.dstToken,
      value: 0,
      count: 0,
      color: getChainColor(intent.srcChain),
    };

    routeEntry.value += volumeUsd;
    routeEntry.count += 1;
    routeMap.set(routeKey, routeEntry);
  }

  const chainBreakdown = [...chainMap.entries()]
    .map(([label, value]) => ({
      label,
      value,
      percent: totalVolumeUsd > 0 ? (value / totalVolumeUsd) * 100 : 0,
      color: getChainColor(label),
    }))
    .sort((a, b) => b.value - a.value);

  const destinationTokenBreakdown = [...destinationTokenMap.entries()]
    .map(([label, value]) => ({
      label,
      value,
      percent: totalVolumeUsd > 0 ? (value / totalVolumeUsd) * 100 : 0,
      color: DST_TOKENS.find((token) => token.symbol === label)?.symbol === "XLM"
        ? "#4CEBA8"
        : "#A78BFA",
    }))
    .sort((a, b) => b.value - a.value);

  const routeBreakdown = [...routeMap.values()]
    .sort((a, b) => b.value - a.value)
    .slice(0, 8)
    .map((entry) => ({
      ...entry,
      color: entry.color,
    }));

  const volumeOverTime = buildVolumeSeries(volumeByBucket, from, to, granularity);

  return {
    totalIntents: intents.length,
    totalVolumeUsd,
    rollingVolumeUsd,
    averageVolumeUsd: intents.length > 0 ? totalVolumeUsd / intents.length : 0,
    statusCounts,
    chainBreakdown,
    destinationTokenBreakdown,
    routeBreakdown,
    volumeOverTime,
    granularity,
    from: from.toISOString(),
    to: to.toISOString(),
    ignoredRows,
  };
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
