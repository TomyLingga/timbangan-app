import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import type { PermissionLevel } from "../src/api/types";
import { LEVEL_LABELS, MODULE_LABELS } from "../src/auth/permissions";
import { clockTime } from "../src/lib/format";
import type { QueueItem } from "../src/queue/queue";
import { useQueue } from "../src/state/queue";
import { useSession } from "../src/state/session";
import { useTheme } from "../src/theme/ThemeProvider";
import { radius, space } from "../src/theme/tokens";
import { MainScreen } from "../src/ui/chrome";
import { SignedIn } from "../src/ui/guard";
import { Badge, Banner, Button, Choices, Panel, Plate, Rows, T } from "../src/ui/kit";

export default function ProfilScreen() {
  return (
    <SignedIn>
      <Profil />
    </SignedIn>
  );
}

const THEMES = [
  { value: "system", label: "Ikuti ponsel" },
  { value: "dark", label: "Gelap" },
  { value: "light", label: "Terang" },
];

function Profil() {
  const { user, logout } = useSession();
  const { mode, setMode } = useTheme();
  const queue = useQueue();
  const [leaving, setLeaving] = useState(false);
  const open = queue.items.filter((item) => item.status !== "sent");
  const sent = queue.items.filter((item) => item.status === "sent").slice(-5).reverse();
  const waiting = open.filter((item) => item.status === "waiting" || item.status === "sending").length;
  // the phone may have signal while the server cannot be reached; the last failed send says so
  const unreachable = open.some((item) => item.status === "waiting" && item.lastError?.status === 0);
  const modules = Object.entries(user?.permissions ?? {}).filter((entry): entry is [string, PermissionLevel] => !!entry[1]);

  return (
    <MainScreen testID="screen-profil">
      <T kind="title">Profil</T>
      <Panel>
        <T kind="big">{user?.fullName ?? ""}</T>
        <T kind="muted">{user?.username ?? ""}</T>
        <Rows rows={modules.map(([code, level]) => ({ label: MODULE_LABELS[code] ?? code, value: LEVEL_LABELS[level] }))} />
      </Panel>

      <Panel>
        <T kind="heading">Tampilan</T>
        <Choices options={THEMES} value={mode} onChange={(value) => setMode(value as typeof mode)} columns={1} testID="theme-choice" />
      </Panel>

      <Panel testID="queue-panel">
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
          <T kind="heading">Kiriman</T>
          {!queue.online ? (
            <Badge label="Tanpa sinyal" tone="warn" icon="wifi-off" />
          ) : unreachable ? (
            <Badge label="Server tidak terjangkau" tone="warn" icon="wifi-off" />
          ) : (
            <Badge label="Sinyal ada" tone="ok" icon="wifi" />
          )}
        </View>
        {queue.paused && waiting > 0 ? (
          <Banner tone="warn" icon="pause-circle" title="Pengiriman berhenti">
            Sesi berakhir. Masuk lagi supaya kiriman dikirim.
          </Banner>
        ) : null}
        {open.length === 0 ? <T kind="muted">Semua kiriman sudah sampai di server.</T> : null}
        {open.map((item) => (
          <QueueRow key={item.clientUuid} item={item} onDiscard={() => void queue.discard(item.clientUuid)} />
        ))}
        {waiting > 0 ? <Button label="Kirim sekarang" icon="refresh-cw" kind="secondary" onPress={queue.retryNow} testID="queue-retry" /> : null}
        {sent.length > 0 ? (
          <View style={{ gap: space.sm }}>
            <T kind="muted">Terkirim terakhir</T>
            {sent.map((item) => (
              <QueueRow key={item.clientUuid} item={item} />
            ))}
          </View>
        ) : null}
      </Panel>

      {waiting > 0 ? <T kind="small">Keluar baru bisa setelah semua kiriman terkirim.</T> : null}
      <Button
        label="Keluar"
        icon="log-out"
        kind="secondary"
        disabled={waiting > 0}
        busy={leaving}
        onPress={async () => {
          setLeaving(true);
          await logout();
          setLeaving(false);
          router.replace("/masuk");
        }}
        testID="logout"
      />
    </MainScreen>
  );
}

function QueueRow({ item, onDiscard }: { item: QueueItem; onDiscard?: () => void }) {
  const { colors } = useTheme();
  const status = {
    waiting: { label: "Menunggu terkirim", tone: "warn" as const, icon: "upload-cloud" as const },
    sending: { label: "Sedang dikirim", tone: "plain" as const, icon: "loader" as const },
    failed: { label: "Ditolak server", tone: "bad" as const, icon: "x-octagon" as const },
    sent: { label: "Terkirim", tone: "ok" as const, icon: "check-circle" as const },
  }[item.status];
  return (
    <View
      testID={`queue-item-${item.status}`}
      style={{ gap: space.sm, padding: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: item.status === "failed" ? colors.danger : colors.border, backgroundColor: colors.surface }}
    >
      <Plate size="medium">{item.label.plate}</Plate>
      <Badge label={status.label} tone={status.tone} icon={status.icon} />
      <T kind="label">{item.label.form}</T>
      <T kind="muted">
        Disimpan {clockTime(item.createdAt)}
        {item.status === "sent" && item.sentAt ? ` · terkirim ${clockTime(item.sentAt)}` : ""}
        {item.status === "waiting" && item.attempts > 0 ? ` · sudah dicoba ${item.attempts} kali` : ""}
      </T>
      {item.lastError && item.status !== "sent" ? <T kind="small">{item.lastError.message}</T> : null}
      {item.status === "failed" ? (
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Button
            label="Buka lagi"
            icon="edit-3"
            style={{ flex: 1 }}
            onPress={() => router.push({ pathname: "/langkah/[id]", params: { id: String(item.label.stepId), ulang: item.clientUuid } })}
            testID="queue-reopen"
          />
          <Button label="Hapus" icon="trash-2" kind="secondary" style={{ flex: 1 }} onPress={onDiscard} />
        </View>
      ) : null}
    </View>
  );
}
