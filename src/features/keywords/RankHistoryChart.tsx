import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { absoluteTime, shortDate } from "@/lib/dates";
import type { RankSnapshotRow } from "@/lib/rank-tracking";
import { CHART_COLORS } from "@/components/charts/chart-colors";
import { EmptyState } from "@/components/ui/empty-state";
import { LineChart as LineChartIcon } from "lucide-react";

/**
 * Observed-rank history for one tracked keyword. The Y axis is reversed
 * (rank 1 at the top) since a lower rank number is a better result - a plain
 * ascending axis would make "improving" look like "getting worse".
 */
export function RankHistoryChart({
  history,
  height = 180,
}: {
  history: RankSnapshotRow[];
  height?: number;
}) {
  const points = history.filter((h) => h.observedRank != null);
  if (points.length === 0) {
    return (
      <EmptyState
        icon={LineChartIcon}
        title="No observations yet"
        description="Record a rank observation to start building this chart."
      />
    );
  }

  const data = points.map((h) => ({
    date: h.checkedAt,
    rank: h.observedRank,
    source: h.source,
  }));

  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer>
        <LineChart
          data={data}
          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <XAxis
            dataKey="date"
            tickFormatter={(d: string) => shortDate(d)}
            tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
            minTickGap={24}
            stroke="hsl(var(--border))"
          />
          <YAxis
            reversed
            allowDecimals={false}
            tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
            width={32}
            stroke="hsl(var(--border))"
            tickFormatter={(v: number) => `#${v}`}
          />
          <Tooltip
            labelFormatter={(d) => absoluteTime(String(d))}
            formatter={(value: number, _name, item) => [
              `#${value} (${item.payload.source === "manual" ? "manual check" : "observed SERP"})`,
              "Rank",
            ]}
            contentStyle={{
              background: "hsl(var(--card))",
              border: "1px solid hsl(var(--border))",
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <Line
            type="monotone"
            dataKey="rank"
            name="Observed rank"
            stroke={CHART_COLORS.primary}
            strokeWidth={2}
            dot={{ r: 3 }}
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
