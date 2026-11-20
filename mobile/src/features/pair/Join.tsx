import { router, useLocalSearchParams } from "expo-router";
import { Check, Users } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, AppState, View } from "react-native";
import type { JoinAttempt, JoinTarget, Pairing } from "@/link/client";
import { checkTeamJoin, findTeamInvite, joinWithPairing, startTeamJoin } from "@/state/link";
import { forget, keep, readKept } from "@/state/keep";
import { askPersonName } from "./askName";
import { useApp } from "@/state/store";
import { Button, EmptyState, Field, haptic, IconTile, Sheet, space, T, useOnShow, useTheme } from "@/ui";
import {
  JOIN_ATTEMPT_KEY,
  type JoinViewState,
  joinErrorState,
  joinRouteParams,
  joinState,
  parseInviteInput,
  pollJoinState,
  readJoinResume,
} from "./joinLogic";

type ScreenView = { phase: "entry" | "finding" | "confirm" | "sending" } | JoinViewState;

export default function Join() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<Record<string, string>>();
  const pairings = useApp((state) => state.pairings);
  const visible = useOnShow();
  const [view, setView] = useState<ScreenView>({ phase: "entry" });
  const [code, setCode] = useState("");
  const [serverKey, setServerKey] = useState<string>();
  const [target, setTarget] = useState<JoinTarget>();
  const [computerName, setComputerName] = useState<string>();
  const [attempt, setAttempt] = useState<JoinAttempt>();
  const checking = useRef(false);
  const started = useRef(false);
  const leaving = useRef(false);

  const teamName = () => view.phase === "pending" ? view.team.name : target?.name || "that team";

  async function approved(pairing: Pairing) {
    if (leaving.current) return;
    leaving.current = true;
    await joinWithPairing(pairing);
    await forget(JOIN_ATTEMPT_KEY).catch(() => {});
    setView({ phase: "approved", pairing, teamName: target?.name });
    haptic.success();
    setTimeout(() => router.dismissTo("/"), 1200);
  }

  async function receive(next: JoinViewState) {
    if (next.phase === "approved") return approved(next.pairing);
    if (next.phase === "pending") setTarget((current) => current ? { ...current, name: next.team.name } : current);
    setView(next);
    if (next.phase === "denied" || next.phase === "closed") await forget(JOIN_ATTEMPT_KEY).catch(() => {});
  }

  async function poll() {
    if (!attempt || checking.current) return;
    checking.current = true;
    const next = await pollJoinState(attempt, checkTeamJoin);
    checking.current = false;
    await receive(next);
  }

  async function find(value = code, expected = serverKey) {
    const input = parseInviteInput(value);
    const clean = input.code.replace("-", "");
    if (clean.length !== 10) {
      setView({ phase: "error", message: "Enter the ten-character invite code." });
      return;
    }
    setCode(input.code);
    setServerKey(input.serverKey ?? expected);
    setView({ phase: "finding" });
    try {
      const found = await findTeamInvite(clean, input.serverKey ?? expected);
      setTarget(found.target);
      setComputerName(found.computerName);
      setView({ phase: "confirm" });
    } catch (error) {
      await receive(joinErrorState(error));
    }
  }

  async function send() {
    if (!target || view.phase === "sending") return;
    const begin = async () => {
      // The owner approves a person, not "iPhone": the name goes with the request.
      const person = await askPersonName();
      if (!person) return;
      setView({ phase: "sending" });
      try {
        const outcome = await startTeamJoin(target, person);
        setAttempt(outcome.attempt);
        if (outcome.result.status === "pending") await keep(JOIN_ATTEMPT_KEY, JSON.stringify(outcome.attempt));
        await receive(joinState(outcome.result));
      } catch (error) {
        await receive(joinErrorState(error));
      }
    };
    const existing = pairings.some((pairing) => pairing.serverId === target.serverId);
    if (existing) {
      Alert.alert("Replace this computer's pairing?", "Your current pairing with " + (computerName || target.name || "this computer") + " will be replaced by your team access.", [
        { text: "Cancel", style: "cancel" },
        { text: "Continue", onPress: () => void begin() },
      ]);
    } else await begin();
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      const linked = joinRouteParams(params);
      if (linked) {
        setCode(linked.code);
        setServerKey(linked.serverKey);
        await find(linked.code, linked.serverKey);
        return;
      }
      if (params.resume !== "1") return;
      const resumed = await readJoinResume(() => readKept(JOIN_ATTEMPT_KEY), checkTeamJoin);
      if (!resumed) {
        setView({ phase: "entry" });
        return;
      }
      setAttempt(resumed.attempt);
      setTarget(resumed.attempt.target);
      setCode(parseInviteInput(resumed.attempt.target.code).code);
      await receive(resumed.state);
    })();
  }, [params, receive]);

  useEffect(() => {
    if (!visible || view.phase !== "pending" || AppState.currentState !== "active" || !attempt) return;
    const timer = setInterval(() => void poll(), 10_000);
    return () => clearInterval(timer);
  }, [visible, view.phase, attempt, poll]);

  useEffect(() => {
    if (!attempt || view.phase !== "pending") return;
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active" && visible) void poll();
    });
    return () => subscription.remove();
  }, [attempt, view.phase, visible, poll]);

  const changeCode = (text: string) => {
    const input = parseInviteInput(text);
    setCode(input.code);
    setServerKey(input.serverKey);
    if (view.phase !== "entry") setView({ phase: "entry" });
  };
  const clean = code.replace(/-/g, "");

  if (view.phase === "approved") {
    return (
      <Sheet title="Join a team">
        <EmptyState icon={Check} title={"You're in. Welcome to " + (view.teamName || target?.name || "the team") + "."} />
      </Sheet>
    );
  }
  if (view.phase === "denied") {
    return <Sheet title="Join a team"><EmptyState title="The owner didn't approve this request." action="Close" onAction={() => router.back()} /></Sheet>;
  }
  if (view.phase === "closed" || view.phase === "wait" || view.phase === "offline" || view.phase === "error") {
    const text =
      view.phase === "closed"
        ? "This invite has expired or was used."
        : view.phase === "wait"
          ? "Too many tries. Wait a minute and try again."
          : view.phase === "offline"
            ? "Can't reach " + teamName() + " right now. Try again when the owner's computer is on."
            : view.message;
    return (
      <Sheet title="Join a team">
        <EmptyState title={text} action={attempt ? "Try again" : "Back"} onAction={() => (attempt ? setView({ phase: "pending", requestId: "", team: { name: teamName() } }) : setView({ phase: "entry" }))} />
        <Button title="Cancel" variant="ghost" wide onPress={() => {
          void forget(JOIN_ATTEMPT_KEY).catch(() => {});
          router.back();
        }} />
      </Sheet>
    );
  }
  if (view.phase === "pending" || view.phase === "sending") {
    return (
      <Sheet title="Join a team">
        <View style={{ alignItems: "center", gap: space.lg, paddingHorizontal: space.lg, paddingTop: space.huge }}>
          <ActivityIndicator size="large" color={colors.muted} />
          <T variant="title3" center>The request has been sent to the owner of the team.</T>
          <T variant="footnote" color="muted" center>Waiting for approval</T>
        </View>
      </Sheet>
    );
  }
  if (view.phase === "finding") {
    return <Sheet title="Join a team"><ActivityIndicator style={{ marginTop: space.huge }} color={colors.muted} /></Sheet>;
  }
  if (view.phase === "confirm" && target) {
    return (
      <Sheet title="Join a team">
        <View style={{ alignItems: "center", gap: space.md, paddingTop: space.lg }}>
          <IconTile icon={Users} size={64} color={colors.accent} />
          <T variant="title1" center>Join {target.name}</T>
          <T variant="subhead" color="muted" center>
            {"Hosted on " + (computerName || "the owner's computer")}
          </T>
        </View>
        <View style={{ gap: space.sm }}>
          <Button title="Accept" size="lg" wide onPress={() => void send()} />
          <Button title="Cancel" variant="ghost" size="lg" wide onPress={() => router.back()} />
        </View>
      </Sheet>
    );
  }

  return (
    <Sheet title="Join a team">
      <View style={{ gap: space.md }}>
        <T variant="callout" color="muted">Enter the code the team owner shared, or paste the whole invite link.</T>
      </View>
      <View style={{ gap: space.sm }}>
        <Field
          label="Invite code"
          placeholder="XXXXX-XXXXX"
          value={code}
          onChangeText={changeCode}
          autoCapitalize="characters"
          autoCorrect={false}
          keyboardType="ascii-capable"
          mono
          returnKeyType="go"
          onSubmitEditing={() => void find()}
          autoFocus
        />
      </View>
      <Button title="Find team" size="lg" wide disabled={clean.length !== 10} onPress={() => void find()} />
    </Sheet>
  );
}
