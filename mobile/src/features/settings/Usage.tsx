import { ChartColumn, Download } from "lucide-react-native";
import { useEffect, useState } from "react";
import { View } from "react-native";
import type { UsageReport } from "@/link/types";
import { shareFrom } from "@/state/files";
import { useBots, useCapability, useOnline } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { compactNumber } from "@/state/time";
import { BotAvatar, Button, EmptyState, Group, Label, Loading, Page, Row, Segmented, space, T, useTheme } from "@/ui";
import { useProviderUsage } from "@/state/providerUsage";
import { Limits } from "./Limits";
import { shareLine, tokens, type UsageDay, usageDays } from "./computer";
import { Card } from "./shared";

type Range = "7" | "30" | "90";
const RANGES: { value: Range; label: string }[] = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];

const money = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const localToday = () => {
  const now = new Date();
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
};

type Measure = "turns" | "tokens";
const MEASURES: { value: Measure; label: string }[] = [
  { value: "turns", label: "Turns" },
  { value: "tokens", label: "Tokens" },
];

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <Card style={{ flex: 1, gap: 2, paddingVertical: space.lg }}>
      <View accessible accessibilityLabel={label + ", " + value + (note ? ", " + note : "")}>
        <T variant="footnote" color="muted" numberOfLines={1}>
          {label}
        </T>
        <T variant="title3" numberOfLines={1} adjustsFontSizeToFit>
          {value}
        </T>
        {!!note && (
          <T variant="caption" color="muted" numberOfLines={1}>
            {note}
          </T>
        )}
      </View>
    </Card>
  );
}

/** Turns or tokens per day. Tokens show input with output stacked on top, as on the computer. */
function Chart({ report, days, measure }: { report: UsageReport; days: number; measure: Measure }) {
  const { colors } = useTheme();
  const series = usageDays(report, days, localToday());
  const amount = (day: UsageDay) => (measure === "turns" ? day.turns : day.input + day.output);
  const max = Math.max(1, ...series.map(amount));
  const busiest = series.reduce((best, day) => (amount(day) > amount(best) ? day : best), series[0]);
  const unit = measure === "turns" ? " turns" : " tokens";
  const summary =
    (measure === "turns" ? "Turns" : "Tokens") + " per day over " + days + " days. " + (amount(busiest) > 0 ? "Busiest: " + shortDate.format(busiest.time) + ", " + (measure === "turns" ? busiest.turns : tokens(amount(busiest))) + unit + "." : "Nothing yet.");
  const corner = days > 30 ? 1 : days > 7 ? 3 : 6;
  return (
    <Card style={{ padding: space.lg, gap: space.sm }}>
      <View accessible accessibilityRole="image" accessibilityLabel={summary} style={{ height: 128, flexDirection: "row", alignItems: "flex-end", gap: days > 30 ? 1 : days > 7 ? 3 : 8 }}>
        {series.map((day) => {
          const value = amount(day);
          const height = value > 0 ? Math.max(4, (value / max) * 128) : 3;
          return (
            <View key={day.time} style={{ flex: 1, height, borderRadius: corner, overflow: "hidden", backgroundColor: value > 0 ? colors.accent : colors.line, justifyContent: "flex-start" }}>
              {measure === "tokens" && value > 0 && <View style={{ height: (day.output / value) * height, backgroundColor: colors.ink2 }} />}
            </View>
          );
        })}
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <T variant="caption" color="muted">
          {shortDate.format(series[0].time)}
        </T>
        {measure === "tokens" && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: colors.accent }} />
            <T variant="caption" color="muted">
              Input
            </T>
            <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: colors.ink2, marginLeft: space.xs }} />
            <T variant="caption" color="muted">
              Output
            </T>
          </View>
        )}
        <T variant="caption" color="muted">
          Today
        </T>
      </View>
    </Card>
  );
}

/** How much the bots did: turns, tokens and cost over a range, by day, model and bot. */
export default function Usage() {
  const online = useOnline();
  const bots = useBots();
  const [range, setRange] = useState<Range>("7");
  const [measure, setMeasure] = useState<Measure>("turns");
  const [tries, setTries] = useState(0);
  const [result, setResult] = useState<{ key: string; report?: UsageReport }>();
  const days = Number(range);
  const key = range + ":" + tries;
  const limits = useProviderUsage();
  const [pulling, setPulling] = useState(false);
  // "Export CSV": the computer hands the table over and the phone's share sheet saves or sends it.
  const canExport = useCapability("files-v1");
  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    setExporting(true);
    await shareFrom(api.exportUsageText(days), "Exported.");
    setExporting(false);
  };
  // Pulling down reads both again: the providers' limits and the report.
  const pull = async () => {
    setPulling(true);
    setTries((n) => n + 1);
    if (limits.supported) await limits.refresh();
    setPulling(false);
  };

  useEffect(() => {
    if (!online) return;
    let live = true;
    void attempt(api.usage(days)).then((report) => live && setResult({ key, report }));
    return () => {
      live = false;
    };
  }, [online, days, key]);

  const loaded = result?.key === key ? result : undefined;
  const report = loaded?.report;
  const totals = report?.totals;

  return (
    <Page title="Usage" onRefresh={online ? pull : undefined} refreshing={pulling}>
      <Limits view={limits} />
      <Segmented options={RANGES} value={range} onChange={setRange} />
      {!loaded ? (
        <Loading />
      ) : !report || !totals ? (
        <EmptyState icon={ChartColumn} title="Couldn't load usage" action="Try again" onAction={() => setTries((n) => n + 1)} />
      ) : (
        <>
          <View style={{ gap: space.md }}>
            <View style={{ flexDirection: "row", gap: space.md }}>
              <Metric label="Turns" value={compactNumber(totals.turns)} />
              <Metric label="Cost" value={totals.priced > 0 ? money.format(totals.cost) : "—"} note={totals.priced > 0 && totals.priced < totals.turns ? "From " + totals.priced + " priced turns" : undefined} />
            </View>
            <View style={{ flexDirection: "row", gap: space.md }}>
              <Metric label="Input tokens" value={tokens(totals.input)} note={totals.cacheRead > 0 ? tokens(totals.cacheRead) + " from cache" : undefined} />
              <Metric label="Output tokens" value={tokens(totals.output)} />
            </View>
          </View>

          <View style={{ gap: space.md }}>
            <Segmented options={MEASURES} value={measure} onChange={setMeasure} />
            <Chart report={report} days={days} measure={measure} />
          </View>

          {report.byModel.length > 0 && (
            <View>
              <Label>By model</Label>
              <Group>
                {report.byModel.map((item) => (
                  <Row key={item.model} title={item.model} subtitle={shareLine(item)} value={item.priced > 0 ? money.format(item.cost) : undefined} />
                ))}
              </Group>
            </View>
          )}

          {report.byBot.length > 0 && (
            <View>
              <Label>By bot</Label>
              <Group>
                {report.byBot.map((item) => (
                  <Row
                    key={item.botId}
                    leading={<BotAvatar bot={bots.find((bot) => bot.id === item.botId) ?? { id: item.botId }} size={32} badge={false} />}
                    title={item.name}
                    subtitle={shareLine(item)}
                    value={item.priced > 0 ? money.format(item.cost) : undefined}
                  />
                ))}
              </Group>
            </View>
          )}

          <View style={{ gap: space.sm }}>
            <Button title="Export CSV" icon={Download} variant="secondary" loading={exporting} disabled={!canExport || !online || !totals.turns} onPress={() => void exportCsv()} />
            {!canExport && (
              <T variant="footnote" color="muted" center>
                Update the app on your computer
              </T>
            )}
          </View>
        </>
      )}
    </Page>
  );
}
