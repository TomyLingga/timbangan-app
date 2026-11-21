import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueueProvider } from "../src/state/queue";
import { SessionProvider } from "../src/state/session";
import { ThemeProvider, useTheme } from "../src/theme/ThemeProvider";

function Navigator() {
  const { colors, isDark } = useTheme();
  return (
    <>
      <StatusBar style={isDark ? "light" : "dark"} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background }, animation: "fade" }} />
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <SessionProvider>
          <QueueProvider>
            <Navigator />
          </QueueProvider>
        </SessionProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
