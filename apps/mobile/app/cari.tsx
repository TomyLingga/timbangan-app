import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { isApiError } from "../src/api/client";
import { errorMessage } from "../src/api/messages";
import type { FindResponse } from "../src/api/types";
import { readyFor } from "../src/lib/format";
import { useQueue } from "../src/state/queue";
import { useSession } from "../src/state/session";
import { useTheme } from "../src/theme/ThemeProvider";
import { fontSize, radius, space } from "../src/theme/tokens";
import { MainScreen, TruckBlock } from "../src/ui/chrome";
import { SignedIn } from "../src/ui/guard";
import { Badge, Banner, Button, Field, Input, T } from "../src/ui/kit";
import { ScanButton } from "../src/ui/Scanner";

export default function CariScreen() {
  return (
    <SignedIn>
      <Cari />
    </SignedIn>
  );
}

function Cari() {
  const { api } = useSession();
  const { colors } = useTheme();
  const { pendingFor } = useQueue();
  const [plate, setPlate] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FindResponse | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const find = async (query: { plate?: string; barcode?: string }) => {
    setBusy(true);
    setProblem(null);
    setResult(null);
    try {
      setResult(await api.request<FindResponse>("/api/work/find", { query }));
    } catch (error) {
      setProblem(isApiError(error) && error.status === 404 ? "Truk tidak ditemukan di dalam pabrik." : errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const submitPlate = () => {
    if (plate.trim().length < 3) {
      setProblem("Ketik plat lengkap, misalnya ZZ 0001 CTH.");
      return;
    }
    void find({ plate: plate.trim() });
  };

  return (
    <MainScreen testID="screen-cari">
      <T kind="title">Cari truk</T>
      <Field label="Plat nomor">
        <Input
          value={plate}
          onChangeText={setPlate}
          placeholder="ZZ 0001 CTH"
          autoCapitalize="characters"
          autoCorrect={false}
          returnKeyType="search"
          onSubmitEditing={submitPlate}
          testID="find-plate"
          accessibilityLabel="Plat nomor"
        />
      </Field>
      <Button label="Cari" icon="search" onPress={submitPlate} busy={busy} testID="find-submit" />
      <ScanButton onScanned={(code) => void find({ barcode: code })} />
      {problem ? (
        <Banner tone="warn" icon="alert-triangle" title={problem} />
      ) : null}
      {result ? (
        <View style={{ gap: space.md }}>
          <TruckBlock truck={result.truck} />
          <T kind="heading">Langkah yang siap untuk Anda</T>
          {result.steps.length === 0 ? <T kind="muted">Tidak ada langkah truk ini yang menunggu Anda.</T> : null}
          {result.steps.map((step) => (
            <Pressable
              key={step.id}
              onPress={() => router.push({ pathname: "/langkah/[id]", params: { id: String(step.id) } })}
              accessibilityRole="button"
              accessibilityLabel={step.name}
              style={({ pressed }) => ({
                minHeight: 64,
                flexDirection: "row",
                alignItems: "center",
                gap: space.md,
                padding: space.lg,
                borderRadius: radius.xl,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: pressed ? colors.surface : colors.card,
              })}
            >
              <View style={{ flex: 1, gap: 6 }}>
                <Text style={{ fontSize: fontSize.body, fontWeight: "800", color: colors.primaryInk }}>{step.name}</Text>
                <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
                  <Badge label={`Siap ${readyFor(step.readyAt)}`} icon="clock" />
                  {pendingFor(step.id) ? <Badge label="Menunggu terkirim" tone="warn" icon="upload-cloud" /> : null}
                </View>
              </View>
              <Feather name="chevron-right" size={26} color={colors.muted} />
            </Pressable>
          ))}
        </View>
      ) : null}
    </MainScreen>
  );
}
