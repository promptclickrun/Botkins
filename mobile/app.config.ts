import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "Botkins",
  slug: "botkins",
  version: "0.1.0",
  // The app holds itself upright (src/app/_layout.tsx) and lets go only for the computer's screen.
  orientation: "default",
  icon: "./assets/images/icon.png",
  scheme: "botkins",
  userInterfaceStyle: "automatic",
  ios: {
    bundleIdentifier: "app.botkins.mobile",
    // The extensions (widgets and Live Activities, the notification extension and the notification content extension, in targets/) are signed for the same team.
    appleTeamId: process.env.TEAM_ID,
    // Each upload to TestFlight needs a higher number: scripts/testflight.sh passes it in.
    buildNumber: process.env.BOTKINS_BUILD ?? "1",
    supportsTablet: true,
    infoPlist: {
      // The native stack sets the icon color for the visible screen, including on iOS 27.
      UIViewControllerBasedStatusBarAppearance: true,
      // The desktop link is plain HTTP on the local network (or a tailnet); every message on it
      // is encrypted by the app itself (src/link).
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
      // App Store Connect reads this encryption declaration for each build.
      ITSAppUsesNonExemptEncryption: false,
      NSLocalNetworkUsageDescription: "Botkins finds and connects to your computer on your local network.",
      // What the app may look for on the network: the desktop app's own announcement.
      NSBonjourServices: ["_botkins._tcp"],
      // A chat's running turn shows on the Lock Screen and in the Dynamic Island.
      NSSupportsLiveActivities: true,
      NSSupportsLiveActivitiesFrequentUpdates: true,
      // Where the key for sealed notifications is kept, so the notification extension can read it (modules/botkins-activity).
      BotkinsKeychainGroup: "$(AppIdentifierPrefix)app.botkins.mobile.shared",
      // Where the app saves what the widgets show (src/state/widgetData.ts); the widget extension reads it there.
      BotkinsAppGroup: "group.app.botkins.mobile",
    },
    entitlements: {
      // To let a bot's request break through a Focus, turn on "Time Sensitive Notifications" for the
      // app's identifier in the Apple developer account (it can't be done through the API), remake the
      // profile, and add `"com.apple.developer.usernotifications.time-sensitive": true` here. The
      // computer already marks requests that way; without the entitlement they arrive as ordinary ones.
      // The app's own group stays first, so what it already saved (the pairing) is still found.
      "keychain-access-groups": ["$(AppIdentifierPrefix)app.botkins.mobile", "$(AppIdentifierPrefix)app.botkins.mobile.shared"],
      // Shared with the widget extension: the widgets' snapshot (docs/live-cards.md, section 8).
      "com.apple.security.application-groups": ["group.app.botkins.mobile"],
    },
  },
  android: {
    package: "app.botkins.mobile",
    // Each upload to Google Play needs a higher number: scripts/android-play.sh passes it in.
    versionCode: Number(process.env.BOTKINS_BUILD ?? "1"),
    adaptiveIcon: {
      backgroundColor: "#A83519",
      foregroundImage: "./assets/images/adaptive-foreground.png",
    },
  },
  plugins: [
    "expo-router",
    [
      "expo-splash-screen",
      {
        backgroundColor: "#A83519",
        image: "./assets/images/splash.png",
        imageWidth: 200,
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission: "Botkins uses the camera to scan the pairing code and to take a photo for a message.",
        // The same sentence as the voice plugins below: each plugin that knows the microphone writes its own, and the last one wins.
        microphonePermission: "Botkins uses the microphone when you dictate a message or talk with a bot.",
        recordAudioAndroid: false,
      },
    ],
    [
      "expo-font",
      {
        // The design kit's faces. iOS reads each family's name from its files.
        // Lora is one of the fonts a person can pick in Settings › Appearance; the other choices are the phone's own.
        ios: {
          fonts: [
            "./assets/fonts/DejaVuSerif-Bold.ttf",
            "./assets/fonts/OpenSans-Regular.ttf",
            "./assets/fonts/OpenSans-SemiBold.ttf",
            "./assets/fonts/OpenSans-Bold.ttf",
            "./assets/fonts/Lora-Regular.ttf",
            "./assets/fonts/Lora-Italic.ttf",
            "./assets/fonts/Lora-SemiBold.ttf",
            "./assets/fonts/Lora-Bold.ttf",
          ],
        },
        android: {
          fonts: [
            { fontFamily: "DejaVu Serif", fontDefinitions: [{ path: "./assets/fonts/DejaVuSerif-Bold.ttf", weight: 700 }] },
            {
              fontFamily: "Open Sans",
              fontDefinitions: [
                { path: "./assets/fonts/OpenSans-Regular.ttf", weight: 400 },
                { path: "./assets/fonts/OpenSans-SemiBold.ttf", weight: 600 },
                { path: "./assets/fonts/OpenSans-Bold.ttf", weight: 700 },
              ],
            },
            {
              fontFamily: "Lora",
              fontDefinitions: [
                { path: "./assets/fonts/Lora-Regular.ttf", weight: 400 },
                { path: "./assets/fonts/Lora-Italic.ttf", weight: 400, style: "italic" },
                { path: "./assets/fonts/Lora-SemiBold.ttf", weight: 600 },
                { path: "./assets/fonts/Lora-Bold.ttf", weight: 700 },
              ],
            },
          ],
        },
      },
    ],
    "expo-secure-store",
    ["expo-image-picker", { photosPermission: "Botkins attaches the photos you choose to a message, and shows your bots the photos they ask for when you turn on Photos under Device access.", cameraPermission: "Botkins uses the camera to scan the pairing code and to take a photo for a message.", microphonePermission: "Botkins uses the microphone when you dictate a message or talk with a bot." }],
    ["expo-local-authentication", { faceIDPermission: "Botkins checks it is you before showing your computer's screen or your credentials, and before letting phones use a computer's screen." }],
    "expo-screen-orientation",
    // WebRTC refers to a decoder class it does not ship; R8 fails a release build without these rules.
    ["expo-build-properties", { android: { usesCleartextTraffic: true, extraProguardRules: "-keep class org.webrtc.** { *; }\n-dontwarn org.webrtc.**" } }],
    "@react-native-community/datetimepicker",
    "expo-web-browser",
    // Notifications. A build for TestFlight (scripts/testflight.sh sets BOTKINS_BUILD) uses Apple's production service.
    ["expo-notifications", { mode: process.env.BOTKINS_BUILD ? "production" : "development", enableBackgroundRemoteNotifications: true }],
    // Device access (Tools › Device access): what bots may use on this phone, each switched on by the person.
    ["expo-calendar", { calendarPermission: "Botkins reads and changes your calendar for your bots, when you turn on Calendar under Device access.", remindersPermission: "Botkins reads and changes your reminders for your bots, when you turn on Calendar under Device access." }],
    ["expo-contacts", { contactsPermission: "Botkins looks up and changes your contacts for your bots, when you turn on Contacts under Device access." }],
    ["expo-location", { locationWhenInUsePermission: "Botkins tells your bots where you are, when you turn on Location under Device access.", locationAlwaysPermission: false, locationAlwaysAndWhenInUsePermission: false, isIosBackgroundLocationEnabled: false, isAndroidBackgroundLocationEnabled: false }],
    ["expo-media-library", { photosPermission: "Botkins attaches the photos you choose to a message, and shows your bots the photos they ask for when you turn on Photos under Device access.", savePhotosPermission: "Botkins saves pictures your bots make to your photo library." }],
    "expo-mail-composer",
    ["@kingstinct/react-native-healthkit", { NSHealthShareUsageDescription: "Botkins reads your Health data for your bots, when you turn on Health under Device access.", NSHealthUpdateUsageDescription: "Botkins writes the Health records you ask a bot to log.", background: false }],
    // Voice: dictation, reading replies aloud, and live voice. These come after the camera and photo
    // plugins above, which leave the microphone out, so the microphone's reason is the one set here.
    ["expo-audio", { microphonePermission: "Botkins uses the microphone when you dictate a message or talk with a bot.", enableBackgroundRecording: false, enableBackgroundPlayback: true }],
    ["expo-speech-recognition", { microphonePermission: "Botkins uses the microphone when you dictate a message or talk with a bot.", speechRecognitionPermission: "Botkins turns what you say into the text of a message." }],
    ["@config-plugins/react-native-webrtc", { cameraPermission: "Botkins uses the camera to scan the pairing code and to take a photo for a message.", microphonePermission: "Botkins uses the microphone when you dictate a message or talk with a bot." }],
    // The Live Activities and widgets, the notification extension, and the notification content extension (targets/).
    "@bacons/apple-targets",
    "./plugins/withShortcuts.js",
    // Android release signing with the Play upload key (plugins/withAndroidRelease.js).
    "./plugins/withAndroidRelease.js",
  ],
  experiments: { typedRoutes: true, reactCompiler: true },
};

export default config;
