// Small stroke icons (24x24) so the nav never depends on emoji or glyph fonts.
const PATHS = {
  home: "M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z",
  orders: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6",
  shipments: "M3 7h11v9H3zM14 10h4l3 3v3h-7M7 19a1.6 1.6 0 1 0 0-.01M17 19a1.6 1.6 0 1 0 0-.01",
  products: "M12 11c-2-3-1-6 0-7 1 1 2 4 0 7zM12 11c3-1 5 1 5 3-2 1-4 0-5-3zM12 11c-3-1-5 1-5 3 2 1 4 0 5-3zM12 12v9",
  categories: "M4 5h7l9 9-6 6-9-9zM8 9h.01",
  shippingMethods: "M3 8l9-4 9 4v8l-9 4-9-4zM3 8l9 4 9-4M12 12v8",
  members: "M9 11a3.5 3.5 0 1 0 0-.01M3 20c0-3.3 2.7-5 6-5s6 1.7 6 5M17 8.5a3 3 0 0 1 0 5.5M18 15c2 .5 3 2 3 5",
  reports: "M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-3",
  team: "M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  logout: "M10 4H5v16h5M15 8l4 4-4 4M19 12H9",
  back: "M15 5l-7 7 7 7",
  up: "M6 14l6-6 6 6",
  down: "M6 10l6 6 6-6",
  left: "M14 6l-6 6 6 6",
  right: "M10 6l6 6-6 6",
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6L6 18",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M9 9h.01",
  content: "M6 3h9l4 4v14H6zM14 3v5h5M9 12h6M9 16h6",
};

export function icon(name, size = 22) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", PATHS[name] || PATHS.more);
  svg.append(p);
  return svg;
}

export const ICON_NAMES = Object.keys(PATHS);
