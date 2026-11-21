// Scanning the SPJ barcode with the phone camera. The SPJ carries a QR code and a Code 128 (apps/web prints both).
// The web build has no scanner (Scanner.web.tsx).

import { CameraView, useCameraPermissions } from "expo-camera";
import { useRef, useState } from "react";
import { Modal, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme/ThemeProvider";
import { space } from "../theme/tokens";
import { Banner, Button, T } from "./kit";

export function ScanButton({ onScanned }: { onScanned(code: string): void }) {
  const [open, setOpen] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [refused, setRefused] = useState(false);
  const handled = useRef(false);
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();

  const start = async () => {
    const granted = permission?.granted || (await requestPermission()).granted;
    if (!granted) {
      setRefused(true);
      return;
    }
    setRefused(false);
    handled.current = false;
    setOpen(true);
  };

  return (
    <>
      <Button label="Scan barcode SPJ" icon="maximize" kind="secondary" onPress={() => void start()} testID="scan-open" />
      {refused ? (
        <Banner tone="warn" icon="camera-off" title="Izin kamera ditolak">
          Izinkan kamera di pengaturan ponsel, atau ketik platnya.
        </Banner>
      ) : null}
      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={{ flex: 1, backgroundColor: "#000000" }}>
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr", "code128"] }}
            onBarcodeScanned={(result) => {
              if (handled.current || !result.data) return;
              handled.current = true;
              setOpen(false);
              onScanned(result.data);
            }}
          />
          <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: space.lg, paddingBottom: insets.bottom + space.lg, gap: space.md, backgroundColor: colors.background }}>
            <T kind="label">Arahkan kamera ke barcode di SPJ.</T>
            <Button label="Batal" kind="secondary" onPress={() => setOpen(false)} />
          </View>
        </View>
      </Modal>
    </>
  );
}
