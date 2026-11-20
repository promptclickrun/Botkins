import { Check, Monitor } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Linking, View } from "react-native";
import { formatCode, normalizeHost } from "@/link/pairing";
import { isRelayHost } from "@/link/relay";
import { canLookNearby, useNearby } from "@/state/nearby";
import { Button, Field, Group, IconTile, Label, Row, Sheet, space, T, useTheme } from "@/ui";
import { usePairing } from "./usePairing";

/**
 * Pairing with the code alone. The phone finds the computers on this network by itself; the
 * person picks theirs (one is picked for them) and types the code it shows. Typing an address is
 * the way out when the computer can't be found: another network, or a build that can't look.
 */
export default function Manual() {
  const { colors } = useTheme();
  const [typing, setTyping] = useState(!canLookNearby);
  const [address, setAddress] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const { busy, error, errorCode, start, clear } = usePairing();
  const { computers, looking, blocked } = useNearby(!typing);

  // After a few seconds with nothing found, say what to check.
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    setWaited(false);
    if (typing) return;
    const timer = setTimeout(() => setWaited(true), 6000);
    return () => clearTimeout(timer);
  }, [typing]);

  // One computer nearby is the one; with several, the person says which.
  const chosen = computers.find((computer) => computer.name === picked) ?? (computers.length === 1 ? computers[0] : undefined);
  // A typed address is direct only: a relay address comes from the QR code.
  const typed = normalizeHost(address);
  const host = typing ? (typed && !isRelayHost(typed) ? typed : null) : (chosen?.host ?? null);
  const clean = code.replace(/[^0-9A-Za-z]/g, "");
  const ready = !!host && clean.length >= 8;
  const submit = () => {
    if (!ready || !host) return;
    void start({ hosts: [host], code: clean, ...(!typing && chosen?.id && { serverId: chosen.id }) });
  };
  // A typed address without a port falls back on the usual one, which a computer may not be using.
  const portless = typing && !/:\d+\s*$/.test(address);
  const problem = error && errorCode === "not-found" && portless ? "Your computer didn't answer. Add the port it shows after the address." : error;

  return (
    <Sheet title="Enter code">
      {typing ? (
        <View style={{ gap: space.sm }}>
          <Field
            label="Address"
            placeholder="192.168.1.20:47610"
            value={address}
            onChangeText={(text) => {
              setAddress(text);
              clear();
            }}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="numbers-and-punctuation"
            returnKeyType="next"
            autoFocus
          />
          <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
            Your computer shows its address and port next to the code.
          </T>
        </View>
      ) : (
        <View>
          <Label>Your computer</Label>
          <Group>
            {computers.map((computer) => (
              <Row
                key={computer.name}
                leading={<IconTile icon={Monitor} />}
                title={computer.name}
                subtitle={computer.host ? undefined : "Finding its address…"}
                trailing={chosen?.name === computer.name ? <Check size={20} color={colors.accentText} strokeWidth={2.6} accessibilityLabel="Chosen" /> : undefined}
                onPress={() => {
                  setPicked(computer.name);
                  clear();
                }}
              />
            ))}
            {computers.length === 0 &&
              (blocked ? (
                <Row key="blocked" title="Allow local network access" subtitle="Botkins needs it to find your computer" chevron onPress={() => void Linking.openSettings()} />
              ) : (
                <Row
                  key="looking"
                  leading={looking ? <ActivityIndicator color={colors.muted} /> : undefined}
                  title={waited ? "No computer found yet" : "Looking for your computer…"}
                  subtitle={waited ? "Turn on phone access in Botkins on your computer" : undefined}
                  subtitleLines={2}
                />
              ))}
          </Group>
        </View>
      )}
      <Field
        label="Code"
        placeholder="XXXX-XXXX-XXXX"
        value={formatCode(code)}
        onChangeText={(text) => {
          setCode(text);
          clear();
        }}
        autoCapitalize="characters"
        autoCorrect={false}
        mono
        maxLength={14}
        returnKeyType="go"
        onSubmitEditing={submit}
        error={problem ?? undefined}
        autoFocus={!typing}
      />
      <Button title="Pair" size="lg" wide loading={busy} disabled={!ready} onPress={submit} />
      {canLookNearby && (
        <Button
          title={typing ? "Look for it nearby" : "Type an address instead"}
          variant="ghost"
          size="sm"
          wide
          disabled={busy}
          onPress={() => {
            setTyping(!typing);
            clear();
          }}
        />
      )}
    </Sheet>
  );
}
