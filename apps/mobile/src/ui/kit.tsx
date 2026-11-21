// The building blocks of every screen. Built for gloves and sunlight: every control is at least 56 dp tall,
// two-choice fields are two big buttons side by side, text is never small or pale.

import { Feather } from "@expo/vector-icons";
import type { ComponentProps, ReactNode, Ref } from "react";
import type { TextInputInstance } from "react-native";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  type StyleProp,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ChoiceOption, SummaryRow, Tone } from "../forms/shared";
import { useTheme } from "../theme/ThemeProvider";
import { fontSize, type Palette, radius, space, TOUCH } from "../theme/tokens";

export type IconName = ComponentProps<typeof Feather>["name"];

export const mono = Platform.select({ web: "ui-monospace, 'Cascadia Mono', Consolas, monospace", android: "monospace", default: "Menlo" });

export function toneColors(colors: Palette, tone: Tone | undefined): { fg: string; bg: string; line: string } {
  switch (tone) {
    case "ok":
      return { fg: colors.success, bg: colors.successSubtle, line: colors.success };
    case "warn":
      return { fg: colors.signalInk, bg: colors.signalSubtle, line: colors.signal };
    case "bad":
      return { fg: colors.danger, bg: colors.dangerSubtle, line: colors.danger };
    default:
      return { fg: colors.foreground, bg: colors.fill, line: colors.lineStrong };
  }
}

// --- text ---

type TextKind = "title" | "heading" | "body" | "label" | "muted" | "small" | "big";

export function T({ kind = "body", style, children, numberOfLines, testID }: { kind?: TextKind; style?: StyleProp<TextStyle>; children: ReactNode; numberOfLines?: number; testID?: string }) {
  const { colors } = useTheme();
  const base: TextStyle = ({
    title: { fontSize: fontSize.title, fontWeight: "700", color: colors.foreground },
    heading: { fontSize: fontSize.label, fontWeight: "700", color: colors.foreground, letterSpacing: 0.2 },
    body: { fontSize: fontSize.body, color: colors.foreground },
    label: { fontSize: fontSize.label, fontWeight: "600", color: colors.foreground },
    muted: { fontSize: fontSize.small, color: colors.muted },
    small: { fontSize: fontSize.small, color: colors.foreground },
    big: { fontSize: fontSize.big, fontWeight: "800", color: colors.foreground },
  } satisfies Record<TextKind, TextStyle>)[kind];
  return (
    <Text style={[base, style]} numberOfLines={numberOfLines} testID={testID}>
      {children}
    </Text>
  );
}

export function Plate({ children, size = "large" }: { children: ReactNode; size?: "large" | "medium" }) {
  const { colors } = useTheme();
  return (
    <Text
      style={{ fontFamily: mono, fontWeight: "800", fontSize: size === "large" ? fontSize.plate : 21, color: colors.foreground, letterSpacing: 1 }}
      numberOfLines={1}
    >
      {children}
    </Text>
  );
}

// --- layout ---

/** A screen: canvas colour, safe area at the top, an optional bottom bar. */
export function Screen({ children, scroll = true, footer, testID }: { children: ReactNode; scroll?: boolean; footer?: ReactNode; testID?: string }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.background }} behavior={Platform.OS === "ios" ? "padding" : undefined} testID={testID}>
      <View style={{ height: insets.top, backgroundColor: colors.background }} />
      {scroll ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xl * 2 }} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View style={{ flex: 1 }}>{children}</View>
      )}
      {footer ? <View style={{ paddingBottom: insets.bottom, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border }}>{footer}</View> : null}
    </KeyboardAvoidingView>
  );
}

export function Header({ title, onBack, right }: { title: string; onBack?: () => void; right?: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: TOUCH }}>
      {onBack ? (
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Kembali"
          style={({ pressed }) => [styles.iconButton, { borderColor: colors.border, backgroundColor: pressed ? colors.fill : colors.card }]}
        >
          <Feather name="arrow-left" size={24} color={colors.foreground} />
        </Pressable>
      ) : null}
      <View style={{ flex: 1 }}>
        <T kind="title" numberOfLines={2}>
          {title}
        </T>
      </View>
      {right}
    </View>
  );
}

export function Panel({ children, style, tone, testID }: { children: ReactNode; style?: StyleProp<ViewStyle>; tone?: Tone; testID?: string }) {
  const { colors } = useTheme();
  const accent = tone && tone !== "plain" ? toneColors(colors, tone) : null;
  return (
    <View
      testID={testID}
      style={[
        { backgroundColor: colors.card, borderColor: accent ? accent.line : colors.border, borderWidth: 1, borderRadius: radius.xl, padding: space.lg, gap: space.md },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return <Text style={{ fontSize: 14, fontWeight: "800", letterSpacing: 1.2, color: colors.muted, textTransform: "uppercase", marginTop: space.sm }}>{children}</Text>;
}

// --- controls ---

type ButtonKind = "primary" | "secondary" | "danger" | "warn" | "ghost";

export function Button({
  label,
  onPress,
  kind = "primary",
  icon,
  disabled,
  busy,
  testID,
  style,
}: {
  label: string;
  onPress?: () => void;
  kind?: ButtonKind;
  icon?: IconName;
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  const palette = {
    primary: { bg: colors.primary, fg: colors.primaryFg, line: colors.primary },
    secondary: { bg: colors.card, fg: colors.foreground, line: colors.lineStrong },
    danger: { bg: colors.danger, fg: colors.card, line: colors.danger },
    warn: { bg: colors.signal, fg: colors.signalFg, line: colors.signal },
    ghost: { bg: "transparent", fg: colors.primaryInk, line: "transparent" },
  }[kind];
  const off = disabled || busy;
  return (
    <Pressable
      testID={testID}
      onPress={off ? undefined : onPress}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: palette.bg, borderColor: palette.line, opacity: off ? 0.5 : pressed ? 0.82 : 1 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={palette.fg} /> : icon ? <Feather name={icon} size={22} color={palette.fg} /> : null}
      <Text style={{ color: palette.fg, fontSize: fontSize.body, fontWeight: "700", textAlign: "center", flexShrink: 1 }}>{label}</Text>
    </Pressable>
  );
}

/** Two or more answers as big buttons side by side (or in a grid with `columns`). */
export function Choices({
  options,
  value,
  onChange,
  columns,
  testID,
  invalid,
}: {
  options: ChoiceOption[];
  value: string | null;
  onChange(value: string): void;
  columns?: number;
  testID?: string;
  invalid?: boolean;
}) {
  const { colors } = useTheme();
  const perRow = columns ?? options.length;
  const rows: ChoiceOption[][] = [];
  for (let at = 0; at < options.length; at += perRow) rows.push(options.slice(at, at + perRow));
  return (
    <View style={{ gap: space.sm }} testID={testID}>
      {rows.map((row, index) => (
        <View key={index} style={{ flexDirection: "row", gap: space.sm }}>
          {row.map((option) => {
            const selected = option.value === value;
            const tone = toneColors(colors, option.tone ?? "plain");
            const selectedColors =
              option.tone && option.tone !== "plain" ? { bg: tone.bg, fg: tone.fg, line: tone.line } : { bg: colors.primarySubtle, fg: colors.primaryInk, line: colors.primary };
            return (
              <Pressable
                key={option.value}
                onPress={() => onChange(option.value)}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                accessibilityLabel={option.label}
                style={({ pressed }) => [
                  styles.choice,
                  {
                    backgroundColor: selected ? selectedColors.bg : pressed ? colors.fill : colors.surface,
                    borderColor: selected ? selectedColors.line : invalid ? colors.danger : colors.lineStrong,
                    borderWidth: selected ? 2 : 1,
                  },
                ]}
              >
                {selected ? <Feather name="check" size={20} color={selectedColors.fg} /> : null}
                <Text style={{ fontSize: fontSize.body, fontWeight: selected ? "800" : "600", color: selected ? selectedColors.fg : colors.foreground, textAlign: "center", flexShrink: 1 }}>
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
          {row.length < perRow ? Array.from({ length: perRow - row.length }, (_, at) => <View key={`pad-${at}`} style={{ flex: 1 }} />) : null}
        </View>
      ))}
    </View>
  );
}

/** A labelled field with its hint and its error. */
export function Field({ label, required, hint, error, children, testID }: { label: string; required?: boolean; hint?: string; error?: string; children: ReactNode; testID?: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: space.sm }} testID={testID}>
      <Text style={{ fontSize: fontSize.label, fontWeight: "700", color: colors.foreground }}>
        {label}
        {required ? <Text style={{ color: colors.danger }}> *</Text> : null}
      </Text>
      {children}
      {hint && !error ? <T kind="muted">{hint}</T> : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </View>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
      <Feather name="alert-circle" size={18} color={colors.danger} style={{ marginTop: 2 }} />
      <Text style={{ color: colors.danger, fontSize: fontSize.small, fontWeight: "600", flex: 1 }}>{children}</Text>
    </View>
  );
}

export function Input({ invalid, style, ref, ...props }: TextInputProps & { invalid?: boolean; ref?: Ref<TextInputInstance> }) {
  const { colors } = useTheme();
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={colors.muted}
      {...props}
      style={[
        {
          minHeight: TOUCH,
          borderWidth: invalid ? 2 : 1,
          borderColor: invalid ? colors.danger : colors.input,
          borderRadius: radius.md,
          paddingHorizontal: space.lg,
          paddingVertical: space.md,
          fontSize: 19,
          color: colors.foreground,
          backgroundColor: colors.surface,
          textAlignVertical: props.multiline ? "top" : "center",
        },
        style,
      ]}
    />
  );
}

export function Badge({ label, tone = "plain", icon }: { label: string; tone?: Tone; icon?: IconName }) {
  const { colors } = useTheme();
  const palette = toneColors(colors, tone);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", backgroundColor: palette.bg, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 5, borderWidth: 1, borderColor: palette.line }}>
      {icon ? <Feather name={icon} size={15} color={palette.fg} /> : null}
      <Text style={{ color: palette.fg, fontSize: 15, fontWeight: "700" }}>{label}</Text>
    </View>
  );
}

export function Banner({ tone, icon, title, children, action }: { tone: Tone; icon: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  const { colors } = useTheme();
  const palette = toneColors(colors, tone);
  return (
    <View style={{ backgroundColor: palette.bg, borderColor: palette.line, borderWidth: 1, borderRadius: radius.lg, padding: space.md, gap: space.sm }}>
      <View style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-start" }}>
        <Feather name={icon} size={22} color={palette.fg} style={{ marginTop: 1 }} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: palette.fg, fontSize: fontSize.body, fontWeight: "800" }}>{title}</Text>
          {children ? <Text style={{ color: colors.foreground, fontSize: fontSize.small }}>{children}</Text> : null}
        </View>
      </View>
      {action}
    </View>
  );
}

export function Rows({ rows, testID }: { rows: SummaryRow[]; testID?: string }) {
  const { colors } = useTheme();
  return (
    <View testID={testID}>
      {rows.map((row, index) => {
        const palette = row.tone && row.tone !== "plain" ? toneColors(colors, row.tone) : null;
        return (
          <View
            key={`${row.label}-${index}`}
            style={{ flexDirection: "row", gap: space.md, paddingVertical: 10, borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth, borderTopColor: colors.lineStrong }}
          >
            <Text style={{ flex: 1.1, color: colors.muted, fontSize: fontSize.small, fontWeight: "600" }}>{row.label}</Text>
            <Text style={{ flex: 1, color: palette ? palette.fg : colors.foreground, fontSize: fontSize.body, fontWeight: "700", textAlign: "right" }}>{row.value}</Text>
          </View>
        );
      })}
    </View>
  );
}

/** A sheet from the bottom, for summaries and pickers. */
export function Sheet({ visible, onClose, title, children, footer, testID }: { visible: boolean; onClose(): void; title: string; children: ReactNode; footer?: ReactNode; testID?: string }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Tutup" />
        <View
          testID={testID}
          style={{ backgroundColor: colors.card, borderTopLeftRadius: radius.xl + 4, borderTopRightRadius: radius.xl + 4, borderWidth: 1, borderColor: colors.border, maxHeight: "88%", paddingBottom: insets.bottom }}
        >
          <View style={{ alignItems: "center", paddingTop: 10 }}>
            <View style={{ width: 44, height: 5, borderRadius: 3, backgroundColor: colors.lineStrong }} />
          </View>
          <View style={{ paddingHorizontal: space.lg, paddingTop: space.md }}>
            <T kind="title">{title}</T>
          </View>
          <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
          {footer ? <View style={{ padding: space.lg, paddingTop: space.sm, gap: space.sm, borderTopWidth: 1, borderTopColor: colors.border }}>{footer}</View> : null}
        </View>
      </View>
    </Modal>
  );
}

export function Loading({ label = "Memuat…" }: { label?: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ padding: space.xl, alignItems: "center", gap: space.md }}>
      <ActivityIndicator size="large" color={colors.primary} />
      <T kind="muted">{label}</T>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: TOUCH,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: space.xl,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  choice: {
    flex: 1,
    minHeight: TOUCH,
    borderRadius: radius.md,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  iconButton: {
    width: TOUCH,
    height: TOUCH,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
