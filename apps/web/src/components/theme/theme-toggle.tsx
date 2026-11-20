"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  applyTheme,
  readThemePreference,
  setThemePreference,
  subscribeTheme,
  type ThemePreference,
} from "@/lib/theme";

const OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "Ikuti perangkat" },
  { value: "light", label: "Terang" },
  { value: "dark", label: "Gelap" },
];

function isThemePreference(value: string): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function ThemeToggle() {
  const preference = useSyncExternalStore<ThemePreference>(subscribeTheme, readThemePreference, () => "system");

  // In development React resets <html> attributes on the Strict Mode remount,
  // which removes the class the head script set. Production does not need this.
  useLayoutEffect(() => {
    applyTheme();
  }, []);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Tema tampilan">
          <Sun className="size-5 dark:hidden" aria-hidden="true" />
          <Moon className="hidden size-5 dark:block" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuLabel>Tema tampilan</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={preference}
          onValueChange={(value) => {
            if (isThemePreference(value)) setThemePreference(value);
          }}
        >
          {OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} className="min-h-10">
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
