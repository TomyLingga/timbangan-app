// Screens behind the sign-in: wait while the stored session is read, go to Masuk without one.

import { Redirect } from "expo-router";
import type { ReactNode } from "react";
import { View } from "react-native";
import { useSession } from "../state/session";
import { useTheme } from "../theme/ThemeProvider";
import { Loading } from "./kit";

export function SignedIn({ children }: { children: ReactNode }) {
  const { status } = useSession();
  const { colors } = useTheme();
  if (status === "loading") {
    return (
      <View style={{ flex: 1, justifyContent: "center", backgroundColor: colors.background }}>
        <Loading />
      </View>
    );
  }
  if (status === "signedOut") return <Redirect href="/masuk" />;
  return <>{children}</>;
}
