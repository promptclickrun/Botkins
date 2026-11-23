import { Alert } from "react-native";

export const askReplace = (names: string[]) =>
  new Promise<boolean>((resolve) =>
    Alert.alert(
      "Replace existing skills?",
      names.join(", "),
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: "Replace", style: "destructive", onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    ),
  );
