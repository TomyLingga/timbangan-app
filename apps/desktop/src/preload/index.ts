// The only door between the window and the main process. Runs sandboxed with context isolation, so it may use
// nothing but `contextBridge` and `ipcRenderer`; each function maps to one IPC channel the main process checks.
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import type { CctvFrame, DesktopBridge, ScreenView, SettingsInput, UnlockPurpose } from "../shared/bridge";

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const bridge: DesktopBridge = {
  onView: (listener) => subscribe<ScreenView>("station:view", listener),
  onSpeak: (listener) => subscribe<string[]>("station:speak", listener),
  onCctv: (listener) => subscribe<CctvFrame>("station:cctv", listener),
  ready: () => ipcRenderer.invoke("station:ready"),
  speechAudio: (text: string) => ipcRenderer.invoke("speech:audio", text),
  settingsNeedPin: () => ipcRenderer.invoke("settings:needPin"),
  unlock: (pin: string, purpose: UnlockPurpose) => ipcRenderer.invoke("pin:unlock", pin, purpose),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (input: SettingsInput) => ipcRenderer.invoke("settings:save", input),
  setManualPlate: (plate: string | null) => ipcRenderer.invoke("plate:manual", plate),
  endException: () => ipcRenderer.invoke("exception:end"),
  reset: () => ipcRenderer.invoke("station:reset"),
  toggleTheme: () => ipcRenderer.invoke("theme:toggle"),
  setTyping: (active: boolean) => ipcRenderer.send("input:typing", active),
};

contextBridge.exposeInMainWorld("desktop", bridge);
