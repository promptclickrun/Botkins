// Your computer's window: how the app on the computer looks (its Settings › Appearance and
// Settings › Side menu). Each control shows only when the computer sends its field; an older one
// sends fewer. The theme and font lists are the desktop's, by the same ids as the phone's.
import { MenuView } from "@react-native-menu/menu";
import { type Href, router } from "expo-router";
import { ArrowDown, ArrowUp, Check, ChevronsUpDown, Link, PanelLeft, Volume2 } from "lucide-react-native";
import { StyleSheet, View } from "react-native";
import type { Appearance, Preferences } from "@/link/types";
import { useOnline, usePart, useSettings } from "@/state/hooks";
import { api } from "@/state/link";
import { BACKDROPS, backdropById, brand, Group, IconButton, IconTile, Label, Loading, Page, radius, Row, Segmented, space, T, THEMES, type ThemeDef, themeById, useTheme } from "@/ui";
import { useSpacesOn } from "@/features/spaces/data";
import { DESKTOP_TEXT_SIZES, desktopFonts, desktopFontShown, isUsualMenu, menuOf, pinsPlaces, type Place, placeMoved, PLACES_BEFORE, placeShown, type Sidebar, spacesShown, usualMenu } from "./computer";
import { useHeld } from "./shared";

const MODES: { value: Appearance["theme"]; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** A theme as the desktop's card draws it: its page, a line of ink, your bubble and its action color. */
function Swatch({ theme, dark }: { theme: ThemeDef; dark: boolean }) {
  const look = theme[dark ? "dark" : "light"];
  return (
    <View style={{ width: 36, height: 36, borderRadius: radius.sm, overflow: "hidden", backgroundColor: look.canvas, borderWidth: StyleSheet.hairlineWidth, borderColor: look.lineStrong, padding: 5, gap: 3 }}>
      <View style={{ width: "70%", height: 3, borderRadius: 2, backgroundColor: look.ink }} />
      <View style={{ alignSelf: "flex-end", width: "55%", height: 8, borderRadius: 3, backgroundColor: look.bubble }} />
      <View style={{ marginTop: "auto", height: 5, borderRadius: 3, backgroundColor: look.accent }} />
    </View>
  );
}

export default function Window() {
  const { colors, dark } = useTheme();
  const online = useOnline();
  const settings = useSettings();
  const platform = usePart("meta")?.platform;
  const [look, holdLook] = useHeld(settings?.appearance);
  const [prefs, holdPrefs] = useHeld(settings && { linkPreviews: settings.linkPreviews, readAloud: settings.readAloud });
  const [sidebar, holdSidebar] = useHeld<Sidebar>(settings?.sidebar);
  // With spaces, Today is a space on the computer, and its menu has a section of spaces.
  const spaces = useSpacesOn();
  if (!settings || !look || !prefs)
    return (
      <Page title="Your computer's window">
        <Loading />
      </Page>
    );

  const setLook = (patch: Partial<Appearance>) => void holdLook(patch, () => api.setPreferences({ appearance: patch }));
  const setPref = (patch: Pick<Preferences, "linkPreviews" | "readAloud">) => void holdPrefs(patch, () => api.setPreferences(patch));
  // The side menu takes part of its setting: the order alone, the places off it alone, or icons only alone.
  const setSidebar = (patch: Partial<Sidebar>) => void holdSidebar(patch, () => api.setPreferences({ sidebar: patch as NonNullable<Preferences["sidebar"]> }));

  // Which half of a theme the computer shows: "System" follows the computer, shown here as this phone's.
  const showDark = look.theme === "dark" || (look.theme === "system" && dark);
  const fonts = desktopFonts(platform);
  const font = look.font !== undefined ? fonts.find((item) => item.id === desktopFontShown(look.font, platform)) : undefined;
  // The places on the computer's menu, in its order, then the ones it keeps on its All page. A
  // computer from before places could be taken off the menu has its six, all on it.
  const pins = pinsPlaces(sidebar);
  const { menu, off } = menuOf(sidebar, spaces);
  const move = (place: Place, by: -1 | 1) => {
    const next = placeMoved(sidebar, spaces, place, by);
    if (next) setSidebar(next);
  };
  const show = (place: Place, on: boolean) => setSidebar(placeShown(sidebar, spaces, place, on));

  return (
    <Page title="Your computer's window" caption="How Botkins looks on your computer">
      {look.colorTheme !== undefined && (
        <View>
          <Label>Theme</Label>
          <Group>
            {THEMES.map((theme) => {
              const on = theme.id === themeById(look.colorTheme).id;
              return (
                <Row
                  key={theme.id}
                  leading={<Swatch theme={theme} dark={showDark} />}
                  title={theme.name}
                  trailing={on ? <Check size={18} color={colors.accentText} strokeWidth={2.6} /> : undefined}
                  disabled={!online}
                  onPress={on ? undefined : () => setLook({ colorTheme: theme.id })}
                />
              );
            })}
          </Group>
        </View>
      )}

      <View style={{ gap: space.md }}>
        <Label style={{ marginBottom: 0 }}>Light or dark</Label>
        <Segmented options={MODES} value={look.theme} onChange={(theme) => setLook({ theme })} />
      </View>

      {look.backdrop !== undefined && (
        <View style={{ gap: space.md }}>
          <Label style={{ marginBottom: 0 }}>Backdrop</Label>
          <Segmented
            options={BACKDROPS.map((item) => ({ value: item.id, label: item.name }))}
            value={backdropById(look.backdrop).id}
            onChange={(backdrop) => setLook({ backdrop })}
          />
        </View>
      )}

      {(font || look.textSize !== undefined) && (
        <View style={{ gap: space.md }}>
          <Label style={{ marginBottom: 0 }}>Text</Label>
          {font && (
            <Group>
              <MenuView
                actions={fonts.map((item) => ({ id: item.id, title: item.name, state: item.id === font.id ? "on" : "off" }))}
                onPressAction={({ nativeEvent }) => nativeEvent.event !== font.id && setLook({ font: nativeEvent.event })}
                isAnchoredToRight
              >
                <View accessible accessibilityRole="button" accessibilityLabel={"Font, " + font.name} accessibilityHint="Opens the choices">
                  <Row title="Font" value={font.name} trailing={<ChevronsUpDown size={16} color={colors.faint} strokeWidth={2.2} />} />
                </View>
              </MenuView>
            </Group>
          )}
          {look.textSize !== undefined && <Segmented options={DESKTOP_TEXT_SIZES} value={look.textSize} onChange={(textSize) => setLook({ textSize })} />}
        </View>
      )}

      {look.avatarAnimations !== undefined && (
        <View>
          <Label>Avatars</Label>
          <Group>
            <Row
              title="Avatar animations"
              toggled={look.avatarAnimations}
              disabled={!online}
              onToggle={(avatarAnimations) => setLook({ avatarAnimations })}
            />
          </Group>
        </View>
      )}

      <View>
        <Label>Your messages</Label>
        <Group>
          <Row title="Use the theme's color" toggled={look.bubble === "theme"} disabled={!online} onToggle={(on) => setLook({ bubble: on ? "theme" : themeById(look.colorTheme)[showDark ? "dark" : "light"].bubble })} />
          {look.bubble !== "theme" && (
            <Row
              title="Bubble color"
              leading={<View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: look.bubble, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong }} />}
              value={look.bubble.toUpperCase()}
              chevron
              disabled={!online}
              onPress={() => router.push("/settings/bubble" as Href)}
            />
          )}
        </Group>
      </View>

      {(prefs.linkPreviews !== undefined || prefs.readAloud !== undefined) && (
        <View>
          <Label>Conversations</Label>
          <Group>
            {prefs.linkPreviews !== undefined && <Row leading={<IconTile icon={Link} color={brand.rose} />} title="Show link previews" subtitle="Never a private or local link" toggled={prefs.linkPreviews} disabled={!online} onToggle={(linkPreviews) => setPref({ linkPreviews })} />}
            {prefs.readAloud !== undefined && <Row leading={<IconTile icon={Volume2} color={brand.rose} />} title="Read replies aloud" subtitle="Each new reply in the open chat" toggled={prefs.readAloud} disabled={!online} onToggle={(readAloud) => setPref({ readAloud })} />}
          </Group>
        </View>
      )}

      {sidebar && (
        <View style={{ gap: space.md }}>
          <View>
            <Label>Side menu</Label>
            <Group>
              <Row leading={<IconTile icon={PanelLeft} color={brand.rose} />} title="Show icons only" toggled={sidebar.collapsed} disabled={!online} onToggle={(collapsed) => setSidebar({ collapsed })} />
            </Group>
          </View>
          <View>
            <Label>On the side menu</Label>
            <Group>
              {menu.map((place, index) => (
                <Row
                  key={place}
                  title={place}
                  trailing={
                    <View style={{ flexDirection: "row", gap: space.xs }}>
                      <IconButton icon={ArrowUp} label={"Move " + place + " up"} size={36} color={index === 0 ? colors.faint : colors.ink2} disabled={!online || index === 0} onPress={() => move(place, -1)} />
                      <IconButton icon={ArrowDown} label={"Move " + place + " down"} size={36} color={index === menu.length - 1 ? colors.faint : colors.ink2} disabled={!online || index === menu.length - 1} onPress={() => move(place, 1)} />
                    </View>
                  }
                  {...(pins ? { toggled: true, disabled: !online, onToggle: (on: boolean) => show(place, on) } : {})}
                />
              ))}
              {pins && spaces && <Row title="Your spaces" subtitle="Under the places" toggled={spacesShown(sidebar)} disabled={!online} onToggle={(on) => show("Spaces", on)} />}
              <Row
                title={pins ? "Reset to the usual menu" : "Reset to the usual order"}
                tone="accent"
                disabled={!online || isUsualMenu(sidebar, spaces)}
                onPress={() => setSidebar(pins ? usualMenu() : { order: [...PLACES_BEFORE] })}
              />
            </Group>
          </View>
          {pins && off.length > 0 && (
            <View>
              <Label>On the All page</Label>
              <Group>
                {off.map((place) => (
                  <Row key={place} title={place} toggled={false} disabled={!online} onToggle={(on) => show(place, on)} />
                ))}
              </Group>
              <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs, paddingTop: space.xs }}>
                Switch a place on to pin it to the side menu. On the computer, you can also drag a tile from All onto the menu.
              </T>
            </View>
          )}
        </View>
      )}

      {!sidebar && (
        <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
          Update the app on your computer to arrange its side menu.
        </T>
      )}
    </Page>
  );
}
