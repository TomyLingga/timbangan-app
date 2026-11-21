// The parts around the content: the bottom tab bar, the network strip, the truck block on top of a form.

import { Feather } from "@expo/vector-icons";
import { usePathname } from "expo-router";
import { goToMain } from "./nav";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { WorkTruck } from "../api/types";
import { seesDecisions } from "../auth/permissions";
import { clockTime, flowLabel, plateOf } from "../lib/format";
import { useQueue } from "../state/queue";
import { useSession } from "../state/session";
import { useTheme } from "../theme/ThemeProvider";
import { fontSize, radius, space } from "../theme/tokens";
import { type IconName, Panel, Plate, Rows, Screen, T } from "./kit";

interface Tab {
  href: "/beranda" | "/cari" | "/keputusan" | "/profil";
  label: string;
  icon: IconName;
}

export function TabBar() {
  const { colors } = useTheme();
  const { user } = useSession();
  const { items } = useQueue();
  const pathname = usePathname();
  const waiting = items.filter((item) => item.status === "waiting" || item.status === "sending" || item.status === "failed").length;
  const tabs: Tab[] = [
    { href: "/beranda", label: "Beranda", icon: "home" },
    { href: "/cari", label: "Cari", icon: "search" },
    ...(seesDecisions(user) ? [{ href: "/keputusan" as const, label: "Keputusan", icon: "check-square" as const }] : []),
    { href: "/profil", label: "Profil", icon: "user" },
  ];
  return (
    <View style={{ flexDirection: "row", paddingHorizontal: space.sm, paddingTop: 6, paddingBottom: 6 }} accessibilityRole="tablist">
      {tabs.map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Pressable
            key={tab.href}
            onPress={() => goToMain(tab.href)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={tab.label}
            style={{ flex: 1, minHeight: 60, alignItems: "center", justifyContent: "center", gap: 3, borderRadius: radius.lg, backgroundColor: active ? colors.primarySubtle : "transparent" }}
          >
            <View>
              <Feather name={tab.icon} size={24} color={active ? colors.primaryInk : colors.muted} />
              {tab.href === "/profil" && waiting > 0 ? (
                <View style={{ position: "absolute", top: -6, right: -12, minWidth: 20, height: 20, borderRadius: 10, backgroundColor: colors.signal, alignItems: "center", justifyContent: "center", paddingHorizontal: 4 }}>
                  <Text style={{ color: colors.signalFg, fontSize: 13, fontWeight: "800" }}>{waiting}</Text>
                </View>
              ) : null}
            </View>
            <Text style={{ fontSize: 14, fontWeight: active ? "800" : "600", color: active ? colors.primaryInk : colors.muted }}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A main screen: content plus the tab bar. */
export function MainScreen({ children, scroll = true, testID }: { children: ReactNode; scroll?: boolean; testID?: string }) {
  return (
    <Screen scroll={scroll} footer={<TabBar />} testID={testID}>
      {children}
    </Screen>
  );
}

/** "Tidak ada sinyal" strip, with the time of the data that is shown instead. */
export function NetStrip({ fetchedAt, stale }: { fetchedAt: Date | null; stale: boolean }) {
  const { colors } = useTheme();
  const { online } = useQueue();
  if (online && !stale) return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, backgroundColor: colors.signalSubtle, borderColor: colors.signal, borderWidth: 1, borderRadius: radius.lg, padding: space.md }}>
      <Feather name="wifi-off" size={20} color={colors.signalInk} />
      <Text style={{ flex: 1, color: colors.foreground, fontSize: fontSize.small, fontWeight: "600" }}>
        {fetchedAt ? `Tidak tersambung ke server. Data pukul ${clockTime(fetchedAt)}.` : "Tidak tersambung ke server."}
      </Text>
    </View>
  );
}

/** The read-only truck block on top of a form. */
export function TruckBlock({ truck, stepName }: { truck: WorkTruck; stepName?: string }) {
  const { colors } = useTheme();
  return (
    <Panel testID="truck-block">
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
        <View style={{ backgroundColor: colors.surface, borderColor: colors.lineStrong, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm, flexShrink: 1 }}>
          <Plate>{plateOf(truck)}</Plate>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={{ color: truck.direction === "IN" ? colors.primaryInk : colors.info, fontSize: fontSize.small, fontWeight: "800" }}>{flowLabel(truck.flowCode)}</Text>
          {stepName ? <T kind="muted">{stepName}</T> : null}
        </View>
      </View>
      <Rows
        rows={[
          { label: truck.direction === "IN" ? "Pemasok" : "Pelanggan", value: truck.partner.name },
          { label: "Transporter", value: truck.transporter?.name ?? "–" },
          { label: "Produk", value: truck.product?.name ?? "–" },
          { label: "Supir", value: truck.driverName ?? "–" },
          { label: "No Trip", value: truck.tripNo ?? "–" },
        ]}
      />
    </Panel>
  );
}
