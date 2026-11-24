// App entry (expo-router "custom entry point"): the push task and the notification handler are set up before
// the root layout loads, and also when Android runs the JavaScript in the background for a push.
import "./src/platform/pushTask";
// Expo Router registers the app; it stays the last import.
import "expo-router/entry";
