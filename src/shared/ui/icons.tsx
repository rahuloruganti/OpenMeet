/**
 * One icon system for the whole UI: Lucide (ISC) through `lucide-react`, with
 * the app's size and stroke baked in so no surface re-invents it.
 *
 * - 16px by default (20 for a primary action: pass `size={20}`).
 * - `strokeWidth` 1.25 with `absoluteStrokeWidth`, so the line stays 1.25px at
 *   every size instead of scaling with the viewBox.
 * - `currentColor`; the colour comes from the surrounding text (--ink-2 at
 *   rest, --ink on hover), never from the icon itself.
 * - Decorative by default (`aria-hidden`); pass `label` to give it an
 *   accessible name and `role="img"`.
 *
 * Icons are pre-bound so a surface only imports what it renders:
 * `<IconSearch />`. `ICONS` is the same set keyed by name for data-driven lists
 * (the command palette, shortcut tables).
 */
import { forwardRef, type ComponentProps } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Copy,
  Download,
  Ellipsis,
  ExternalLink,
  Eye,
  Folder,
  Info,
  LoaderCircle,
  Lock,
  Mic,
  Monitor,
  Moon,
  PanelLeft,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Square,
  Sun,
  Tag,
  Trash2,
  TriangleAlert,
  Volume2,
  VolumeX,
  X,
  type LucideIcon,
} from "lucide-react";

export type IconProps = Omit<
  ComponentProps<LucideIcon>,
  "size" | "strokeWidth"
> & {
  size?: number;
  strokeWidth?: number;
  /** Accessible name. Omit for a decorative icon next to visible text. */
  label?: string;
};

function boundIcon(Base: LucideIcon) {
  return forwardRef<SVGSVGElement, IconProps>(function Icon(
    { size = 16, strokeWidth = 1.25, label, ...rest },
    ref,
  ) {
    return (
      <Base
        ref={ref}
        size={size}
        strokeWidth={strokeWidth}
        absoluteStrokeWidth
        aria-hidden={label ? undefined : true}
        aria-label={label}
        role={label ? "img" : undefined}
        focusable={label ? undefined : false}
        {...rest}
      />
    );
  });
}

/* Arrows and chevrons. */
export const IconArrowLeft = boundIcon(ArrowLeft);
export const IconArrowRight = boundIcon(ArrowRight);
export const IconArrowUp = boundIcon(ArrowUp);
export const IconArrowDown = boundIcon(ArrowDown);
export const IconChevronLeft = boundIcon(ChevronLeft);
export const IconChevronRight = boundIcon(ChevronRight);
export const IconChevronUp = boundIcon(ChevronUp);
export const IconChevronDown = boundIcon(ChevronDown);

/* Actions and objects. */
export const IconX = boundIcon(X);
export const IconPlus = boundIcon(Plus);
export const IconSearch = boundIcon(Search);
export const IconMic = boundIcon(Mic);
export const IconStop = boundIcon(Square);
export const IconPause = boundIcon(Pause);
export const IconPlay = boundIcon(Play);
export const IconFolder = boundIcon(Folder);
export const IconTag = boundIcon(Tag);
export const IconSettings = boundIcon(Settings);
export const IconCheck = boundIcon(Check);
export const IconAlert = boundIcon(TriangleAlert);
export const IconInfo = boundIcon(Info);
export const IconDownload = boundIcon(Download);
export const IconTrash = boundIcon(Trash2);
export const IconCopy = boundIcon(Copy);
export const IconCalendar = boundIcon(Calendar);
export const IconClock = boundIcon(Clock);
export const IconSparkles = boundIcon(Sparkles);
export const IconPanelLeft = boundIcon(PanelLeft);
export const IconMore = boundIcon(Ellipsis);
export const IconExternalLink = boundIcon(ExternalLink);
export const IconRefresh = boundIcon(RefreshCw);
export const IconEye = boundIcon(Eye);
export const IconLock = boundIcon(Lock);
export const IconPencil = boundIcon(Pencil);
export const IconVolumeOn = boundIcon(Volume2);
export const IconVolumeOff = boundIcon(VolumeX);
export const IconSpinner = boundIcon(LoaderCircle);

/* Theme choice in the palette and Settings. */
export const IconMonitor = boundIcon(Monitor);
export const IconSun = boundIcon(Sun);
export const IconMoon = boundIcon(Moon);

/** The same set keyed by name, for tables and the command palette. */
export const ICONS = {
  arrowLeft: IconArrowLeft,
  arrowRight: IconArrowRight,
  arrowUp: IconArrowUp,
  arrowDown: IconArrowDown,
  chevronLeft: IconChevronLeft,
  chevronRight: IconChevronRight,
  chevronUp: IconChevronUp,
  chevronDown: IconChevronDown,
  close: IconX,
  plus: IconPlus,
  search: IconSearch,
  mic: IconMic,
  stop: IconStop,
  pause: IconPause,
  play: IconPlay,
  folder: IconFolder,
  tag: IconTag,
  settings: IconSettings,
  check: IconCheck,
  alert: IconAlert,
  info: IconInfo,
  download: IconDownload,
  trash: IconTrash,
  copy: IconCopy,
  calendar: IconCalendar,
  clock: IconClock,
  sparkles: IconSparkles,
  panelLeft: IconPanelLeft,
  more: IconMore,
  externalLink: IconExternalLink,
  refresh: IconRefresh,
  eye: IconEye,
  lock: IconLock,
  pencil: IconPencil,
  volumeOn: IconVolumeOn,
  volumeOff: IconVolumeOff,
  spinner: IconSpinner,
  monitor: IconMonitor,
  sun: IconSun,
  moon: IconMoon,
} as const;

export type IconName = keyof typeof ICONS;
