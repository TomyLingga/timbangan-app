import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { errorMessage } from "../../src/api/messages";
import type { ExceptionListResponse, ExceptionView } from "../../src/api/types";
import { canView, seesDecisions } from "../../src/auth/permissions";
import { typeLabel } from "../../src/decisions/decision";
import { readyFor, signedKg } from "../../src/lib/format";
import { useSession } from "../../src/state/session";
import { useRemote } from "../../src/state/useRemote";
import { useTheme } from "../../src/theme/ThemeProvider";
import { fontSize, radius, space } from "../../src/theme/tokens";
import { MainScreen, NetStrip } from "../../src/ui/chrome";
import { SignedIn } from "../../src/ui/guard";
import { Badge, Banner, Loading, Plate, T } from "../../src/ui/kit";

export default function KeputusanScreen() {
  return (
    <SignedIn>
      <Inbox />
    </SignedIn>
  );
}

function Inbox() {
  const { api, user } = useSession();
  const { colors } = useTheme();
  const remote = useRemote(() => api.request<ExceptionListResponse>("/api/exceptions", { query: { status: "PENDING", limit: 50 } }), [], { intervalMs: 5_000 });
  const items = (remote.data?.items ?? []).filter((item) => canView(user, item.approverModule));

  if (!seesDecisions(user)) {
    return (
      <MainScreen>
        <T kind="title">Keputusan</T>
        <Banner tone="warn" icon="lock" title="Akun ini tidak memegang keputusan." />
      </MainScreen>
    );
  }

  return (
    <MainScreen testID="screen-keputusan">
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <T kind="title">Keputusan</T>
        <Badge label={`${items.length} menunggu`} tone={items.length > 0 ? "warn" : "ok"} />
      </View>
      <T kind="muted">Diperbarui tiap 5 detik selama layar ini terbuka.</T>
      <NetStrip fetchedAt={remote.fetchedAt} stale={remote.stale} />
      {remote.loading && !remote.data ? <Loading /> : null}
      {remote.error && !remote.data ? <Banner tone="bad" icon="alert-circle" title="Daftar tidak bisa diambil">{errorMessage(remote.error)}</Banner> : null}
      {remote.data && items.length === 0 ? (
        <View style={{ alignItems: "center", padding: space.xl, gap: space.sm }}>
          <Feather name="check-circle" size={36} color={colors.success} />
          <T kind="label">Tidak ada permintaan yang menunggu.</T>
        </View>
      ) : null}
      {items.map((item) => (
        <RequestCard key={item.id} item={item} />
      ))}
    </MainScreen>
  );
}

function RequestCard({ item }: { item: ExceptionView }) {
  const { colors } = useTheme();
  const qc = item.type === "QC_HOLD";
  return (
    <Pressable
      onPress={() => router.push({ pathname: "/keputusan/[id]", params: { id: String(item.id) } })}
      accessibilityRole="button"
      accessibilityLabel={`${typeLabel(item.type)}, ${item.trip.plateDisplay ?? item.trip.plateNo ?? ""}`}
      testID={`request-${item.id}`}
      style={({ pressed }) => ({ backgroundColor: pressed ? colors.surface : colors.card, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.signal, padding: space.lg, gap: space.sm })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Badge label={typeLabel(item.type)} tone="warn" icon={qc ? "droplet" : "alert-triangle"} />
        <Feather name="chevron-right" size={26} color={colors.muted} />
      </View>
      <Plate>{item.trip.plateDisplay ?? item.trip.plateNo ?? "Tanpa plat"}</Plate>
      <Text style={{ fontSize: fontSize.body, color: colors.foreground, fontWeight: "600" }}>
        {qc ? "QC pass" : (item.station?.name ?? "Timbangan")}
        {item.diffValue !== null ? ` · selisih ${signedKg(item.diffValue)}` : ""}
      </Text>
      <T kind="muted">Menunggu {readyFor(item.raisedAt)}</T>
    </Pressable>
  );
}
