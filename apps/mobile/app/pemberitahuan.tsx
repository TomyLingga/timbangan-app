import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { errorMessage } from "../src/api/messages";
import type { NotificationItem } from "../src/api/types";
import { dayTime } from "../src/lib/format";
import {
  appendPage,
  cursorOf,
  EMPTY_INBOX,
  firstPage,
  type InboxState,
  itemTarget,
  loadPage,
  markAllRead,
  markRead,
  requestBadge,
  withAllRead,
  withRead,
} from "../src/notifications/inbox";
import { useNotifications } from "../src/state/notifications";
import { useSession } from "../src/state/session";
import { useTheme } from "../src/theme/ThemeProvider";
import { fontSize, radius, space } from "../src/theme/tokens";
import { SignedIn } from "../src/ui/guard";
import { goToMain } from "../src/ui/nav";
import { Badge, Banner, Button, Header, Loading, Screen, T } from "../src/ui/kit";

export default function PemberitahuanScreen() {
  return (
    <SignedIn>
      <Inbox />
    </SignedIn>
  );
}

const back = () => (router.canGoBack() ? router.back() : goToMain("/beranda"));

function Inbox() {
  const { api } = useSession();
  const { colors } = useTheme();
  const { pushVersion, setUnreadCount } = useNotifications();
  const [inbox, setInbox] = useState<InboxState>(EMPTY_INBOX);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const generation = useRef(0);

  const update = useCallback(
    (next: InboxState) => {
      setInbox(next);
      setUnreadCount(next.unreadCount);
    },
    [setUnreadCount],
  );

  const reload = useCallback(
    async (manual: boolean) => {
      const mine = ++generation.current;
      if (manual) setRefreshing(true);
      try {
        const answer = await loadPage(api);
        if (mine !== generation.current) return;
        update(firstPage(answer));
        setError(null);
      } catch (caught) {
        if (mine === generation.current) setError(caught);
      } finally {
        if (mine === generation.current) {
          setLoaded(true);
          setRefreshing(false);
        }
      }
    },
    [api, update],
  );

  useEffect(() => {
    void reload(false);
  }, [reload, pushVersion]);

  const loadMore = async () => {
    if (loadingMore || !inbox.hasMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    try {
      const answer = await loadPage(api, cursorOf(inbox));
      if (mine === generation.current) update(appendPage(inbox, answer));
      setError(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoadingMore(false);
    }
  };

  const open = async (item: NotificationItem) => {
    const target = itemTarget(item);
    if (target !== null) router.push({ pathname: "/keputusan/[id]", params: { id: String(target) } });
    if (item.readAt !== null) return;
    setInbox((current) => withRead(current, item.id, null));
    try {
      const answer = await markRead(api, item.id);
      setInbox((current) => {
        const next = withRead(current, item.id, answer);
        setUnreadCount(next.unreadCount);
        return next;
      });
    } catch {
      // shown as read here; the next reload brings the server's state
    }
  };

  const readAll = async () => {
    setMarkingAll(true);
    try {
      await markAllRead(api);
      update(withAllRead(inbox));
      setError(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setMarkingAll(false);
    }
  };

  const header = (
    <View style={{ gap: space.md, paddingBottom: space.sm }}>
      <Header title="Pemberitahuan" onBack={back} />
      {inbox.unreadCount > 0 ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
          <View>
            <Badge label={`${inbox.unreadCount} belum dibaca`} tone="warn" />
          </View>
          <Button label="Tandai semua dibaca" icon="check" kind="ghost" busy={markingAll} onPress={() => void readAll()} testID="inbox-read-all" />
        </View>
      ) : null}
      {error ? <Banner tone="bad" icon="alert-circle" title="Pemberitahuan tidak bisa diambil">{errorMessage(error)}</Banner> : null}
    </View>
  );

  return (
    <Screen scroll={false} testID="screen-pemberitahuan">
      <FlatList
        data={inbox.items}
        keyExtractor={(item) => String(item.id)}
        ListHeaderComponent={header}
        contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xl * 2 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.primary} colors={[colors.primary]} />}
        ListEmptyComponent={
          !loaded ? (
            <Loading />
          ) : error ? undefined : (
            <View style={{ alignItems: "center", padding: space.xl, gap: space.sm }}>
              <Feather name="bell-off" size={36} color={colors.muted} />
              <T kind="label">Belum ada pemberitahuan.</T>
            </View>
          )
        }
        ListFooterComponent={
          inbox.hasMore ? <Button label="Muat yang lebih lama" icon="chevron-down" kind="secondary" busy={loadingMore} onPress={() => void loadMore()} testID="inbox-more" /> : undefined
        }
        renderItem={({ item }) => <InboxRow item={item} onPress={() => void open(item)} />}
      />
    </Screen>
  );
}

function InboxRow({ item, onPress }: { item: NotificationItem; onPress(): void }) {
  const { colors } = useTheme();
  const unread = item.readAt === null;
  const badge = requestBadge(item);
  const opens = itemTarget(item) !== null;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${unread ? "Belum dibaca, " : ""}${item.title}`}
      testID={`inbox-item-${item.id}`}
      style={({ pressed }) => ({
        backgroundColor: pressed ? colors.surface : colors.card,
        borderRadius: radius.xl,
        borderWidth: unread ? 2 : 1,
        borderColor: unread ? colors.signal : colors.border,
        padding: space.lg,
        gap: space.sm,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
        {unread ? <View testID={`inbox-unread-${item.id}`} style={{ width: 12, height: 12, borderRadius: 6, marginTop: 7, backgroundColor: colors.signal }} /> : null}
        <Text style={{ flex: 1, fontSize: fontSize.body, fontWeight: unread ? "800" : "600", color: colors.foreground }}>{item.title}</Text>
        {opens ? <Feather name="chevron-right" size={24} color={colors.muted} /> : null}
      </View>
      {item.body ? <T kind="small">{item.body}</T> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
        <T kind="muted">{dayTime(item.createdAt)}</T>
        {badge ? <Badge label={badge.label} tone={badge.tone} icon={badge.tone === "warn" ? "clock" : undefined} /> : null}
      </View>
    </Pressable>
  );
}
