// The left vertical tool palette: one icon button per tool with a localized
// tooltip and a single-key shortcut. Owns no editing state; the app passes the
// active tool in and receives clicks out.

import { t } from '../ui/i18n';
import { el } from './dom';

export type EditorTool =
  | 'select'
  | 'move'
  | 'rotate'
  | 'scale'
  | 'raise'
  | 'lower'
  | 'smooth'
  | 'flatten'
  | 'paint'
  | 'water'
  | 'place'
  | 'foliage'
  | 'blocker'
  | 'collider'
  | 'camp'
  | 'spawn'
  | 'zone'
  | 'light'
  | 'music'
  | 'region'
  | 'erase';

export interface ToolDef {
  tool: EditorTool;
  /** Single-key shortcut (lowercase); absent = click-only tool (X deletes the
   *  selection and E is reserved for Free-Fly height, so neither picks a tool). */
  key?: string;
  labelKey:
    | 'editor.tool.zone'
    | 'editor.tool.light'
    | 'editor.tool.music'
    | 'editor.tool.select'
    | 'editor.tool.move'
    | 'editor.tool.rotate'
    | 'editor.tool.scale'
    | 'editor.tool.raise'
    | 'editor.tool.lower'
    | 'editor.tool.smooth'
    | 'editor.tool.flatten'
    | 'editor.tool.paint'
    | 'editor.tool.water'
    | 'editor.tool.place'
    | 'editor.tool.foliage'
    | 'editor.tool.blocker'
    | 'editor.tool.collider'
    | 'editor.tool.camp'
    | 'editor.tool.spawn'
    | 'editor.tool.region'
    | 'editor.tool.erase';
  icon: string; // inline SVG path data (24x24, stroke)
}

export const TOOL_DEFS: readonly ToolDef[] = [
  { tool: 'select', key: 'v', labelKey: 'editor.tool.select', icon: 'M6 3l12 9-6 1-3 6z' },
  // Blender-style transform trio: G grab/move, R rotate, S scale.
  {
    tool: 'move',
    key: 'g',
    labelKey: 'editor.tool.move',
    icon: 'M12 2v20M2 12h20M12 2l-2.5 2.5M12 2l2.5 2.5M12 22l-2.5-2.5M12 22l2.5-2.5M2 12l2.5-2.5M2 12l2.5 2.5M22 12l-2.5-2.5M22 12l-2.5 2.5',
  },
  {
    tool: 'rotate',
    key: 'r',
    labelKey: 'editor.tool.rotate',
    icon: 'M20 12a8 8 0 1 1-2.4-5.7M20 3v4.5h-4.5',
  },
  {
    tool: 'scale',
    key: 's',
    labelKey: 'editor.tool.scale',
    icon: 'M4 20L20 4M20 4h-6M20 4v6M4 20h6M4 20v-6',
  },
  {
    tool: 'raise',
    key: 'u',
    labelKey: 'editor.tool.raise',
    icon: 'M3 19h18M6 19c2-6 4-9 6-9s4 3 6 9M12 3v5M9.5 5.5L12 3l2.5 2.5',
  },
  {
    tool: 'flatten',
    key: 'f',
    labelKey: 'editor.tool.flatten',
    icon: 'M4 16h16M8 8v5M8 13l-2-2M8 13l2-2M16 8v5M16 13l-2-2M16 13l2-2',
  },
  {
    tool: 'paint',
    key: 'b',
    labelKey: 'editor.tool.paint',
    icon: 'M12 3c3 4.5 6 7.5 6 11a6 6 0 1 1-12 0c0-3.5 3-6.5 6-11z',
  },
  {
    tool: 'water',
    key: 'w',
    labelKey: 'editor.tool.water',
    icon: 'M3 9c3-3 6-3 9 0s6 3 9 0M3 15c3-3 6-3 9 0s6 3 9 0',
  },
  {
    tool: 'place',
    key: 'p',
    labelKey: 'editor.tool.place',
    icon: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 3v9M4 7.5l8 4.5 8-4.5',
  },
  {
    tool: 'foliage',
    key: 't',
    labelKey: 'editor.tool.foliage',
    icon: 'M12 2l4.5 6h-2.5l4 5h-3.5l3.5 5H6l3.5-5H6l4-5H7.5zM12 18v4',
  },
  {
    tool: 'collider',
    key: 'o',
    labelKey: 'editor.tool.collider',
    icon: 'M4 10h10v10H4zM10 4h10v10h-4M10 4v6M20 4l-6 6',
  },
  {
    tool: 'camp',
    key: 'c',
    labelKey: 'editor.tool.camp',
    icon: 'M12 4L3 20h18zM12 4l4 16M12 4L8 20',
  },
  {
    tool: 'spawn',
    key: 'n',
    labelKey: 'editor.tool.spawn',
    icon: 'M12 21v-8M12 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM8 21h8',
  },
  {
    tool: 'zone',
    key: 'z',
    labelKey: 'editor.tool.zone',
    icon: 'M4 6h12l4 6-4 6H4zM8 12h.01',
  },
  {
    tool: 'light',
    key: 'i',
    labelKey: 'editor.tool.light',
    icon: 'M12 3a6 6 0 0 1 3.5 10.9c-.9.7-1.5 1.6-1.5 2.6h-4c0-1-.6-1.9-1.5-2.6A6 6 0 0 1 12 3zM10 19h4M11 22h2',
  },
  {
    tool: 'music',
    key: 'm',
    labelKey: 'editor.tool.music',
    icon: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  },
  {
    tool: 'region',
    labelKey: 'editor.tool.region',
    icon: 'M4 4h4M10 4h4M16 4h4M4 4v4M4 10v4M4 16v4M4 20h4M10 20h4M16 20h4M20 4v4M20 10v4M20 16v4',
  },
  {
    tool: 'erase',
    labelKey: 'editor.tool.erase',
    icon: 'M4 16l8-8 6 6-6 6H8zM10 22h10M9 11l6 6',
  },
];

export const TOOL_BY_KEY: ReadonlyMap<string, EditorTool> = new Map(
  TOOL_DEFS.filter((d): d is ToolDef & { key: string } => d.key !== undefined).map((d) => [
    d.key,
    d.tool,
  ]),
);

function iconSvg(path: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  svg.appendChild(p);
  return svg;
}

export class Toolbar {
  readonly root: HTMLElement;
  private readonly buttons = new Map<EditorTool, HTMLButtonElement>();

  constructor(parent: HTMLElement, onPick: (tool: EditorTool) => void) {
    this.root = el('nav', 'ed-toolbar');
    this.root.setAttribute('aria-label', t('editor.tool.listLabel'));
    // Visual grouping: a thin separator before the first tool of each family
    // (sculpt, surface, world content, utility). Decoration only, no text.
    const groupStarts = new Set<EditorTool>(['raise', 'paint', 'place', 'region']);
    for (const def of TOOL_DEFS) {
      if (groupStarts.has(def.tool)) {
        const sep = el('span', 'ed-toolbar-sep');
        sep.setAttribute('aria-hidden', 'true');
        this.root.appendChild(sep);
      }
      const name = t(def.labelKey);
      const tip = def.key ? t('editor.tool.keyHint', { name, key: def.key.toUpperCase() }) : name;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ed-tool';
      b.dataset.tool = def.tool;
      b.title = tip;
      b.setAttribute('aria-label', tip);
      b.setAttribute('aria-pressed', 'false');
      b.appendChild(iconSvg(def.icon));
      if (def.key) {
        const kbd = el('span', 'ed-tool-key', def.key.toUpperCase());
        kbd.setAttribute('aria-hidden', 'true');
        b.appendChild(kbd);
      }
      b.addEventListener('click', () => onPick(def.tool));
      this.buttons.set(def.tool, b);
      this.root.appendChild(b);
    }
    parent.appendChild(this.root);
  }

  setActive(tool: EditorTool): void {
    for (const [tl, b] of this.buttons) {
      b.classList.toggle('active', tl === tool);
      b.setAttribute('aria-pressed', tl === tool ? 'true' : 'false');
    }
  }
}
