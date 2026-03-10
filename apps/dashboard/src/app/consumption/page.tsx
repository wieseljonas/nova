import { getConsumptionData } from "./actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConsumptionCharts } from "./consumption-charts";

export const dynamic = "force-dynamic";

function formatCost(cost: number): string {
  return cost < 0.01 ? "< $0.01" : `$${cost.toFixed(2)}`;
}

export default async function ConsumptionPage() {
  const data = await getConsumptionData();

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold tracking-tight">Consumption</h1>

      <div className="grid gap-3 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Tokens (30d)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{data.totals.totalTokens.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Estimated Cost (30d)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{formatCost(data.totals.totalCost)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Messages with Usage</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{data.totals.totalMessages.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Avg Daily Tokens</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{data.totals.avgDaily.toLocaleString()}</div>
          </CardContent>
        </Card>
      </div>

      <ConsumptionCharts data={data} />
    </div>
  );
}
