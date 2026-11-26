// Settings › Teamwork: whether bots can ask each other for help, here or on another computer in the
// person's profile (the other computer asks for approval). The computer's own switch.
import { useSettings } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { Group, Page, Row } from "@/ui";

export default function Teamwork() {
  const settings = useSettings();
  return (
    <Page title="Teamwork">
      <Group>
        <Row
          title="Teamwork"
          subtitle="Bots can ask for help here or on another computer in your profile. The other computer asks for your approval."
          subtitleLines={3}
          toggled={settings?.teamwork !== false}
          disabled={!settings}
          onToggle={(teamwork) => void attempt(api.setPreferences({ teamwork }))}
        />
      </Group>
    </Page>
  );
}
