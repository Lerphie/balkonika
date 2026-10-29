// UILayout.js — the game's UI layout: every HUD element, placed and styled in the editor (UI tab).
// The editor rewrites the whole file (POST /api/save-ui) — keep the format. Drawn by js/UI.js;
// game code takes an element by id: UI.get('score').setText('10') — and never positions HUD itself.
//   kind — 'text' | 'panel' | 'bar' | 'button'; anchor — one of 9 screen points ('top-left' …
//   'bottom-right'): x, y go from it to the same point of the element (inward from an edge,
//   signed from the center); w, h — px; numbers are px of a screen UI_REF_HEIGHT tall;
//   parent (optional) — id of the element this one sits in: anchor, x, y then count from the
//   parent's box, the parent clips it and hides it together with itself;
//   stretch (optional) — 'h' | 'v' | 'both': fills the container on that axis, x (y) — the inset
//   from both edges, w (h) is ignored;
//   colors — '#rrggbb', '' — none; visible: 0 — hidden until the game calls show().
//   Records go in drawing order: later — on top.
// schema-version: 1
/** @type {UIRecord[]} */
const UI_LAYOUT = [
    { id: 'brand', kind: 'text', anchor: 'top-left', x: 24, y: 24, text: "Балконика", fontSize: 22, color: '#203c38', shadow: '', alpha: 1, visible: 1 },
    { id: 'settings', kind: 'panel', anchor: 'top-right', x: 24, y: 80, w: 360, h: 852, fill: '#ffffff', border: '', radius: 16, alpha: 1, visible: 1 },
    { id: 'eyebrow', kind: 'text', anchor: 'top-left', parent: 'settings', x: 24, y: 24, text: "КОНСТРУКТОР ОТДЕЛКИ", fontSize: 11, color: '#54716b', shadow: '', alpha: 1, visible: 1 },
    { id: 'heading', kind: 'text', anchor: 'top-left', parent: 'settings', x: 24, y: 52, text: "Выберите отделку вашего балкона", fontSize: 25, color: '#202e2b', shadow: '', alpha: 1, visible: 1 },
    { id: 'intro', kind: 'text', anchor: 'top-left', parent: 'settings', x: 24, y: 108, text: "Сочетайте материалы и смотрите, как они выглядят вместе.", fontSize: 14, color: '#54645f', shadow: '', alpha: 1, visible: 1 },
    { id: 'walls_label', kind: 'text', anchor: 'top-left', parent: 'settings', x: 24, y: 160, text: "Стены", fontSize: 17, color: '#202e2b', shadow: '', alpha: 1, visible: 1 },
    { id: 'wall_white', kind: 'button', anchor: 'top-left', parent: 'settings', x: 24, y: 188, w: 310, h: 50, text: "Белые", fontSize: 15, color: '#263b35', fill: '#ffffff', border: '#c4cfca', radius: 9, alpha: 1, visible: 1, ariaLabel: "Стены: белые" },
    { id: 'wall_beige', kind: 'button', anchor: 'top-left', parent: 'settings', x: 24, y: 244, w: 310, h: 50, text: "Бежевые", fontSize: 15, color: '#263b35', fill: '#ffffff', border: '#c4cfca', radius: 9, alpha: 1, visible: 1, ariaLabel: "Стены: бежевые" },
    { id: 'wall_lightGray', kind: 'button', anchor: 'top-left', parent: 'settings', x: 24, y: 300, w: 310, h: 50, text: "Светло-серые", fontSize: 15, color: '#263b35', fill: '#ffffff', border: '#c4cfca', radius: 9, alpha: 1, visible: 1, ariaLabel: "Стены: светло-серые" },
    { id: 'floor_label', kind: 'text', anchor: 'top-left', parent: 'settings', x: 24, y: 370, text: "Пол", fontSize: 17, color: '#202e2b', shadow: '', alpha: 1, visible: 1 },
    { id: 'floor_lightWood', kind: 'button', anchor: 'top-left', parent: 'settings', x: 24, y: 398, w: 310, h: 50, text: "Светлое дерево", fontSize: 15, color: '#263b35', fill: '#ffffff', border: '#c4cfca', radius: 9, alpha: 1, visible: 1, ariaLabel: "Пол: светлое дерево" },
    { id: 'floor_darkWood', kind: 'button', anchor: 'top-left', parent: 'settings', x: 24, y: 454, w: 310, h: 50, text: "Тёмное дерево", fontSize: 15, color: '#263b35', fill: '#ffffff', border: '#c4cfca', radius: 9, alpha: 1, visible: 1, ariaLabel: "Пол: тёмное дерево" },
    { id: 'floor_grayTile', kind: 'button', anchor: 'top-left', parent: 'settings', x: 24, y: 510, w: 310, h: 50, text: "Серая плитка", fontSize: 15, color: '#263b35', fill: '#ffffff', border: '#c4cfca', radius: 9, alpha: 1, visible: 1, ariaLabel: "Пол: серая плитка" },
    { id: 'floor_herringbone', kind: 'button', anchor: 'top-left', parent: 'settings', x: 24, y: 566, w: 310, h: 50, text: "Дерево ёлочкой", fontSize: 15, color: '#263b35', fill: '#ffffff', border: '#c4cfca', radius: 9, alpha: 1, visible: 1, ariaLabel: "Пол: дерево ёлочкой" },
    { id: 'floor_warmTile', kind: 'button', anchor: 'top-left', parent: 'settings', x: 24, y: 622, w: 310, h: 50, text: "Светлая плитка", fontSize: 15, color: '#263b35', fill: '#ffffff', border: '#c4cfca', radius: 9, alpha: 1, visible: 1, ariaLabel: "Пол: светлая плитка" },
    { id: 'selection_label', kind: 'text', anchor: 'top-left', parent: 'settings', x: 24, y: 692, text: "ВАШ ВЫБОР", fontSize: 11, color: '#54716b', shadow: '', alpha: 1, visible: 1 },
    { id: 'selection', kind: 'text', anchor: 'top-left', parent: 'settings', x: 24, y: 712, text: "Стены: белые. Пол: светлое дерево", fontSize: 14, color: '#263b35', shadow: '', alpha: 1, visible: 1 },
    { id: 'reset', kind: 'button', anchor: 'top-left', parent: 'settings', x: 24, y: 772, w: 310, h: 48, text: "Сбросить", fontSize: 15, color: '#284d43', fill: '#edf2ef', border: '', radius: 9, alpha: 1, visible: 1 },
];
