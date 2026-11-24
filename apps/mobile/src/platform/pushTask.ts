// Loaded by index.ts before the app (and alone, when Android starts the JavaScript in the background for a
// data-only push). expo-notifications asks for the task to be defined and registered in module scope of a module
// required early; the task runs for every push that reaches onMessageReceived: in the foreground, and in the
// background for data-only pushes. Android shows a push with a notification part by itself while the app is in
// the background, without this task.

import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { EXCEPTION_CLOSED, parsePushData, pushEvents } from "../notifications/push";
import { dismissForException, installForegroundHandler, setupChannels } from "./push";

export const PUSH_TASK = "timbangan-push";

TaskManager.defineTask<Notifications.NotificationTaskPayload>(PUSH_TASK, async ({ data }) => {
  // on Android the task also runs for a tap on an action button; taps are handled by the app
  if (!data || "actionIdentifier" in data) return;
  const push = parsePushData(data.data);
  if (!push) return;
  if (push.type === EXCEPTION_CLOSED && push.exceptionId !== null) await dismissForException(push.exceptionId).catch(() => undefined);
  pushEvents.emit(push);
});

installForegroundHandler();
void setupChannels().catch(() => undefined);
void Notifications.registerTaskAsync(PUSH_TASK).catch(() => undefined);
