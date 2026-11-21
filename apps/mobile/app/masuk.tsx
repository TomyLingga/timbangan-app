import { Redirect, router } from "expo-router";
import { useRef, useState } from "react";
import { type TextInputInstance, View } from "react-native";
import { loginErrorMessage } from "../src/api/messages";
import { currentServer, saveServer, useSession } from "../src/state/session";
import { useTheme } from "../src/theme/ThemeProvider";
import { radius, space } from "../src/theme/tokens";
import { Banner, Button, ErrorText, Field, Input, Panel, Screen, T } from "../src/ui/kit";

export default function Masuk() {
  const { status, login } = useSession();
  const { colors } = useTheme();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [server, setServer] = useState(currentServer());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [portalNote, setPortalNote] = useState(false);
  const passwordRef = useRef<TextInputInstance>(null);

  if (status === "signedIn") return <Redirect href="/beranda" />;

  const submit = async () => {
    if (!server.trim()) {
      setError("Isi alamat server, misalnya 192.168.1.10:3100.");
      return;
    }
    if (!username.trim() || !password) {
      setError("Isi username dan password.");
      return;
    }
    setServer(await saveServer(server));
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
      router.replace("/beranda");
    } catch (caught) {
      setError(loginErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen testID="screen-masuk">
      <View style={{ paddingTop: space.xl * 1.5, paddingBottom: space.lg, gap: space.sm }}>
        <View style={{ width: 12, height: 40, borderRadius: radius.pill, backgroundColor: colors.primary }} />
        <T kind="big">Timbangan Lapangan</T>
        <T kind="muted">Daftar kerja langkah lapangan dan keputusan selisih.</T>
      </View>
      <Panel>
        <Field label="Alamat server">
          <Input
            value={server}
            onChangeText={setServer}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="192.168.1.10:3100"
            testID="login-server"
            accessibilityLabel="Alamat server"
          />
        </Field>
        <Field label="Username">
          <Input
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            returnKeyType="next"
            onSubmitEditing={() => passwordRef.current?.focus()}
            testID="login-username"
            accessibilityLabel="Username"
          />
        </Field>
        <Field label="Password">
          <Input
            ref={passwordRef}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="password"
            returnKeyType="go"
            onSubmitEditing={() => void submit()}
            testID="login-password"
            accessibilityLabel="Password"
          />
        </Field>
        {error ? <ErrorText>{error}</ErrorText> : null}
        <Button label="Masuk" icon="log-in" onPress={() => void submit()} busy={busy} testID="login-submit" />
      </Panel>
      <Button label="Masuk lewat Portal" icon="external-link" kind="secondary" onPress={() => setPortalNote(true)} testID="login-portal" />
      {portalNote ? (
        <Banner tone="warn" icon="info" title="Masuk lewat Portal belum tersedia">
          Untuk sekarang pakai username dan password.
        </Banner>
      ) : null}
    </Screen>
  );
}
