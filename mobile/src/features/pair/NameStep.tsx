import { router } from "expo-router";
import { useEffect, useState } from "react";
import { keep, readKept } from "@/state/keep";
import { Button, Field, Sheet, space, T } from "@/ui";
import { answerPersonName } from "./askName";
import { cleanPerson, PERSON_KEY, PERSON_MAX, personProblem } from "./person";

/**
 * "Your name": asked before this phone pairs with a computer or asks to join a team, so the
 * computer's owner sees "Jordan" and not only "iPhone". One field, filled with the last name given.
 */
export default function NameStep() {
  const [name, setName] = useState("");
  useEffect(() => {
    void readKept(PERSON_KEY).then(
      (saved) => saved && setName((current) => current || saved),
      () => {},
    );
    // Closed with a swipe or the close button: nothing is sent.
    return () => answerPersonName(null);
  }, []);
  const problem = personProblem(name);
  const tooLong = cleanPerson(name).length > PERSON_MAX;
  const submit = () => {
    if (problem) return;
    const clean = cleanPerson(name);
    void keep(PERSON_KEY, clean).catch(() => {});
    answerPersonName(clean);
    router.back();
  };
  return (
    <Sheet title="Your name">
      <T variant="callout" color="muted" style={{ paddingHorizontal: space.xs }}>
        Shown to the computer's owner, beside this phone.
      </T>
      <Field
        label="Your name"
        placeholder="Jordan"
        value={name}
        onChangeText={setName}
        autoCapitalize="words"
        autoComplete="name"
        textContentType="name"
        maxLength={PERSON_MAX}
        returnKeyType="done"
        onSubmitEditing={submit}
        error={tooLong ? (problem ?? undefined) : undefined}
        autoFocus
      />
      <Button title="Continue" size="lg" wide disabled={!!problem} onPress={submit} />
    </Sheet>
  );
}
