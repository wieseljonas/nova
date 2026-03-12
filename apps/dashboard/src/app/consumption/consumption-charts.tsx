"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

interface ConsumptionData {
  dailyUsage: Array<{
    date: string;
    totalInput: number;
    totalOutput: number;
    totalTokens: number;
    messageCount: number;
    estimatedCost: number;
  }>;
  perUser: Array<{
    userId: string;
    displayName: string | null;
    totalInput: number;
    totalOutput: number;
    totalTokens: number;
    messageCount: number;
    estimatedCost: number;
  }>;
  perJob: Array<{
    jobId: string | null;
    jobName: string | null;
    totalTokens: number;
    executionCount: number;
    estimatedCost: number;
  }>;
  totals: {
    totalTokens: number;
    totalMessages: number;
    avgDaily: number;
    totalCost: number;
  };
}

function formatCost(cost: number): string {
  return cost < 0.01 ? "< $0.01" : `$${cost.toFixed(2)}`;
}

export function ConsumptionCharts({ data }: { data: ConsumptionData }) {
  const chartData = data.dailyUsage.map((d) => ({
    date: d.date.slice(5),
    input: d.totalInput,
    output: d.totalOutput,
    cost: Number(d.estimatedCost.toFixed(4)),
  }));

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Daily Token Usage (30 days)</CardTitle>
        </CardHeader>
        <CardContent>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="date" className="text-xs" />
                <YAxis yAxisId="tokens" className="text-xs" />
                <YAxis yAxisId="cost" orientation="right" className="text-xs" tickFormatter={(v) => `$${v}`} />
                <Tooltip
                  contentStyle={{
                    background: "var(--bg)",
                    border: "1px solid var(--col-border)",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                  formatter={(value: number, name: string) =>
                    name === "Cost ($)" ? [`$${value.toFixed(4)}`, name] : [value.toLocaleString(), name]
                  }
                />
                <Legend />
                <Line yAxisId="tokens" type="monotone" dataKey="input" stroke="#3b82f6" name="Input" strokeWidth={2} dot={false} />
                <Line yAxisId="tokens" type="monotone" dataKey="output" stroke="#8b5cf6" name="Output" strokeWidth={2} dot={false} />
                <Line yAxisId="cost" type="monotone" dataKey="cost" stroke="#f59e0b" name="Cost ($)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No token usage data yet. Usage will appear after messages are processed.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">By User</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead>Messages</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.perUser.map((u) => (
                  <TableRow key={u.userId}>
                    <TableCell className="font-medium">{u.displayName || u.userId}</TableCell>
                    <TableCell>{u.totalTokens.toLocaleString()}</TableCell>
                    <TableCell>{formatCost(u.estimatedCost)}</TableCell>
                    <TableCell>{u.messageCount}</TableCell>
                  </TableRow>
                ))}
                {data.perUser.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-4">No data</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">By Job</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead>Executions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.perJob.map((j, i) => (
                  <TableRow key={j.jobId || i}>
                    <TableCell className="font-medium">{j.jobName || j.jobId || "Unknown"}</TableCell>
                    <TableCell>{j.totalTokens.toLocaleString()}</TableCell>
                    <TableCell>{formatCost(j.estimatedCost)}</TableCell>
                    <TableCell>{j.executionCount}</TableCell>
                  </TableRow>
                ))}
                {data.perJob.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-4">No data</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
