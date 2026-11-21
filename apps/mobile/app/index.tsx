import { Redirect } from "expo-router";
import { View } from "react-native";
import { useSession } from "../src/state/session";
import { useTheme } from "../src/theme/ThemeProvider";
import { Loading } from "../src/ui/kit";

export default function Start() {
  const { status } = useSession();
  const { colors } = useTheme();
  if (status === "loading") {
    return (
      <View style={{ flex: 1, justifyContent: "center", backgroundColor: colors.background }}>
        <Loading />
      </View>
    );
  }
  return <Redirect href={status === "signedIn" ? "/beranda" : "/masuk"} />;
}
