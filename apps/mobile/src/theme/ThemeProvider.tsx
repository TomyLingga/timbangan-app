// The theme follows the phone setting unless the person chose dark or light in Profil (kept in AsyncStorage).

import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { useColorScheme } from "react-native";
import { dark, light, type Palette, type ThemeMode } from "./tokens";

const KEY = "theme-mode";

interface ThemeValue {
  colors: Palette;
  isDark: boolean;
  mode: ThemeMode;
  setMode(mode: ThemeMode): void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>("system");

  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((stored) => {
        if (stored === "dark" || stored === "light" || stored === "system") setModeState(stored);
      })
      .catch(() => undefined);
  }, []);

  const value = useMemo<ThemeValue>(() => {
    const isDark = mode === "system" ? scheme !== "light" : mode === "dark";
    return {
      colors: isDark ? dark : light,
      isDark,
      mode,
      setMode(next) {
        setModeState(next);
        AsyncStorage.setItem(KEY, next).catch(() => undefined);
      },
    };
  }, [mode, scheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme outside ThemeProvider");
  return value;
}
