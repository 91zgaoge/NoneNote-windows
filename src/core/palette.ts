/** Android NoteColor order: Lemon, Peach, Rose, Lilac, Sky, Mint, Sand, Slate. */
export const NOTE_COLOR_NAMES = [
  "Lemon",
  "Peach",
  "Rose",
  "Lilac",
  "Sky",
  "Mint",
  "Sand",
  "Slate",
];

export const NOTE_COLORS = [
  "#E0AD08",
  "#E2762A",
  "#DC4570",
  "#7C4DEE",
  "#2280D6",
  "#0E9B6E",
  "#A37B3C",
  "#4E6579",
];

export const NOTE_PAPERS = [
  "#FCE795",
  "#FBCFA6",
  "#FAC4D1",
  "#D9C7FA",
  "#BEDDFA",
  "#B4E8D0",
  "#E3D3B4",
  "#CBD6E2",
];

export const NOTE_INKS = [
  "#3A3008",
  "#422413",
  "#40161F",
  "#2A1B44",
  "#13293A",
  "#0F2E23",
  "#372C18",
  "#1A242E",
];

export function colorIndexByName(name: string): number | null {
  const idx = NOTE_COLOR_NAMES.findIndex((n) => n.toLowerCase() === name.toLowerCase());
  return idx >= 0 ? idx : null;
}
