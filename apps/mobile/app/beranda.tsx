import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { goToMain } from "../src/ui/nav";
import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { errorMessage } from "../src/api/messages";
import type { WorkListResponse, WorkRow } from "../src/api/types";
import { fieldModulesOf, MODULE_LABELS } from "../src/auth/permissions";
import { flowLabel, plateOf, readyFor } from "../src/lib/format";
import { useQueue } from "../src/state/queue";
import { useSession } from "../src/state/session";
import { useRemote } from "../src/state/useRemote";
import { useTheme } from "../src/theme/ThemeProvider";
import { fontSize, radius, space } from "../src/theme/tokens";
import { MainScreen, NetStrip } from "../src/ui/chrome";
import { SignedIn } from "../src/ui/guard";
import { Badge, Banner, Button, Input, Loading, Plate, T } from "../src/ui/kit";

export default function BerandaScreen() {
  return (
    <SignedIn>
      <Beranda />
    </SignedIn>
  );
}

function useDebounced(value: string, ms: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

function Beranda() {
  const { api, user } = useSession();
  const { colors } = useTheme();
  const { pendingFor, items: queued } = useQueue();
  const [module, setModule] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 350);
  const modules = fieldModulesOf(user);

  const remote = useRemote(
    () => api.request<WorkListResponse>("/api/work/steps", { query: { q, limit: 50 } }),
    [q],
    { cacheKey: q ? null : "work-steps", intervalMs: 30_000, enabled: modules.length > 0 },
  );
  const rows = remote.data?.items ?? [];
  const counts = useMemo(() => {
    const found: Record<string, number> = {};
    for (const row of rows) if (row.module) found[row.module] = (found[row.module] ?? 0) + 1;
    return found;
  }, [rows]);
  const shown = module ? rows.filter((row) => row.module === module) : rows;
  const failed = queued.filter((item) => item.status === "failed").length;

  const header = (
    <View style={{ gap: space.md, paddingBottom: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <View style={{ flex: 1 }}>
          <T kind="muted">Halo, {user?.fullName ?? ""}</T>
          <T kind="title">Daftar kerja</T>
        </View>
      </View>
      <NetStrip fetchedAt={remote.fetchedAt} stale={remote.stale} />
      {failed > 0 ? (
        <Banner tone="bad" icon="alert-octagon" title={`${failed} kiriman ditolak server`} action={<Button label="Lihat di Profil" kind="secondary" onPress={() => goToMain("/profil")} />}>
          Buka lagi form itu, perbaiki, lalu kirim ulang.
        </Banner>
      ) : null}
      {modules.length === 0 ? (
        <Banner tone="warn" icon="lock" title="Belum ada langkah lapangan untuk akun ini">
          Minta admin memberi modul Security, QC, Bongkar, Muat, atau Segel.
        </Banner>
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }} testID="module-chips">
          <ModuleChip label="Semua" count={rows.length} active={module === null} onPress={() => setModule(null)} />
          {modules.map((code) => (
            <ModuleChip key={code} label={MODULE_LABELS[code] ?? code} count={counts[code] ?? 0} active={module === code} onPress={() => setModule(module === code ? null : code)} />
          ))}
        </View>
      )}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Input value={search} onChangeText={setSearch} placeholder="Cari plat, misalnya 0001" autoCapitalize="characters" style={{ flex: 1 }} testID="work-search" accessibilityLabel="Cari plat" />
      </View>
      {remote.error && !remote.data ? <Banner tone="bad" icon="alert-circle" title="Daftar kerja tidak bisa diambil">{errorMessage(remote.error)}</Banner> : null}
    </View>
  );

  return (
    <MainScreen scroll={false} testID="screen-beranda">
      <FlatList
        data={modules.length === 0 ? [] : shown}
        keyExtractor={(row) => String(row.id)}
        ListHeaderComponent={header}
        contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xl }}
        refreshControl={<RefreshControl refreshing={remote.refreshing} onRefresh={() => void remote.reload()} tintColor={colors.primary} colors={[colors.primary]} />}
        ListEmptyComponent={
          modules.length === 0 ? undefined : remote.loading && !remote.data ? (
            <Loading />
          ) : (
            <View style={{ alignItems: "center", padding: space.xl, gap: space.sm }}>
              <Feather name="check-circle" size={36} color={colors.success} />
              <T kind="label">{q ? `Tidak ada truk dengan plat "${q}".` : "Tidak ada truk yang menunggu."}</T>
            </View>
          )
        }
        renderItem={({ item }) => <WorkRowCard row={item} pending={pendingFor(item.id)} />}
      />
    </MainScreen>
  );
}

function ModuleChip({ label, count, active, onPress }: { label: string; count: number; active: boolean; onPress(): void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${label}, ${count} siap`}
      style={({ pressed }) => ({
        minHeight: 56,
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        paddingHorizontal: space.lg,
        borderRadius: radius.pill,
        borderWidth: active ? 2 : 1,
        borderColor: active ? colors.primary : colors.lineStrong,
        backgroundColor: active ? colors.primarySubtle : pressed ? colors.fill : colors.card,
      })}
    >
      <Text style={{ fontSize: fontSize.body, fontWeight: "700", color: active ? colors.primaryInk : colors.foreground }}>{label}</Text>
      <View style={{ minWidth: 30, height: 30, borderRadius: 15, paddingHorizontal: 8, alignItems: "center", justifyContent: "center", backgroundColor: count > 0 ? colors.signal : colors.fill }}>
        <Text style={{ fontSize: 16, fontWeight: "800", color: count > 0 ? colors.signalFg : colors.muted }}>{count}</Text>
      </View>
    </Pressable>
  );
}

function WorkRowCard({ row, pending }: { row: WorkRow; pending: boolean }) {
  const { colors } = useTheme();
  const running = row.status === "IN_PROGRESS";
  const held = row.result === "HOLD";
  return (
    <Pressable
      onPress={() => router.push({ pathname: "/langkah/[id]", params: { id: String(row.id) } })}
      accessibilityRole="button"
      accessibilityLabel={`${plateOf(row.truck)}, ${row.name}`}
      testID={`work-row-${row.id}`}
      style={({ pressed }) => ({
        backgroundColor: pressed ? colors.surface : colors.card,
        borderRadius: radius.xl,
        borderWidth: 1,
        borderColor: pending ? colors.signal : colors.border,
        padding: space.lg,
        gap: space.sm,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
        <View style={{ flexShrink: 1 }}>
          <Plate>{plateOf(row.truck)}</Plate>
        </View>
        <Feather name="chevron-right" size={26} color={colors.muted} />
      </View>
      <Text style={{ fontSize: fontSize.body, fontWeight: "800", color: colors.primaryInk }}>{row.name}</Text>
      <T kind="small">
        {flowLabel(row.truck.flowCode)} · {row.truck.partner.name}
      </T>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center" }}>
        {held ? (
          <Badge label="Menunggu keputusan QC" tone="warn" icon="pause-circle" />
        ) : running ? (
          <Badge label={`Sedang dikerjakan ${readyFor(row.startedAt)}`} tone="plain" icon="play-circle" />
        ) : (
          <Badge label={`Siap ${readyFor(row.readyAt)}`} tone="plain" icon="clock" />
        )}
        {pending ? <Badge label="Menunggu terkirim" tone="warn" icon="upload-cloud" /> : null}
      </View>
    </Pressable>
  );
}
