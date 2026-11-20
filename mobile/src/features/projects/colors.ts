// A project's color name, as a color on the page: the kit's bot palettes, so projects sit with the bots.
import { PALETTES } from "@/data/botLook";
import type { ProjectColor } from "@/link/types";
import { brand, type Theme } from "@/ui";

const swatch = (id: string, fallback: string) => PALETTES.find((palette) => palette.id === id)?.swatch ?? fallback;

const COLORS: Record<Exclude<ProjectColor, "gray">, string> = {
  coral: swatch("terracotta", brand.clay),
  amber: swatch("honey", brand.honey),
  green: swatch("fern", brand.fern),
  teal: swatch("tidepool", brand.tide),
  blue: swatch("bluebell", brand.tide),
  violet: swatch("fig", brand.rose),
  pink: brand.rose,
};

export const PROJECT_COLORS: { value: ProjectColor; label: string }[] = [
  { value: "coral", label: "Coral" },
  { value: "amber", label: "Amber" },
  { value: "green", label: "Green" },
  { value: "teal", label: "Teal" },
  { value: "blue", label: "Blue" },
  { value: "violet", label: "Violet" },
  { value: "pink", label: "Pink" },
  { value: "gray", label: "Gray" },
];

export const projectColor = (color: ProjectColor | undefined, theme: Theme) => (!color || color === "gray" ? theme.colors.muted : COLORS[color]);
