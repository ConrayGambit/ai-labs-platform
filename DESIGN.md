---
name: AI Labs
description: A dark, ruled, evidentiary interface for running companies and building products alongside agents.
colors:
  ledger-black: "#08090a"
  ledger-black-deep: "#0c0d0e"
  dialog-slate: "#151617"
  mark-graphite: "#24252a"
  rule-graphite: "#2a2c31"
  veil-01: "rgba(255, 255, 255, 0.015)"
  veil-02: "rgba(255, 255, 255, 0.02)"
  veil-03: "rgba(255, 255, 255, 0.025)"
  veil-04: "rgba(255, 255, 255, 0.04)"
  rule-hairline: "rgba(255, 255, 255, 0.08)"
  rule-hairline-faint: "rgba(255, 255, 255, 0.05)"
  paper-white: "#f7f8f8"
  paper-dim: "#d0d6e0"
  graphite-mid: "#8a8f98"
  graphite-quiet: "#7a7e85"
  pure-white: "#ffffff"
  signal-indigo: "#7170ff"
  indigo-deep: "#5e6ad2"
  indigo-light: "#828fff"
  indigo-pale: "#c1c6ff"
  entry-green: "#27a644"
  entry-green-pale: "#a9e4c2"
  pending-amber: "#d8a73e"
  pending-amber-pale: "#ecd9a8"
  review-violet: "#b58aea"
  breach-red: "#e25c5c"
  breach-red-pale: "#ffc4c4"
  breach-wash: "rgba(180, 55, 55, 0.12)"
  breach-rule: "rgba(240, 90, 90, 0.25)"
  priority-urgent: "#ff8181"
  priority-high: "#e7b759"
  runtime-claude: "#e7b29c"
  runtime-claude-wash: "rgba(196, 102, 65, 0.13)"
  runtime-kimi: "#bdd7ff"
  runtime-kimi-wash: "rgba(68, 122, 195, 0.14)"
  scrim-heavy: "rgba(0, 0, 0, 0.82)"
  scrim-inset: "rgba(0, 0, 0, 0.35)"
typography:
  display:
    fontFamily: "Segoe UI Variable Display, Segoe UI, system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: "-0.5px"
  headline:
    fontFamily: "Segoe UI Variable Display, Segoe UI, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.4px"
  title:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "-0.24px"
  subtitle:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.35
    letterSpacing: "normal"
  body:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  control:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.35
    letterSpacing: "normal"
  label:
    fontFamily: "Segoe UI Variable Small, Segoe UI, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.06em"
  micro:
    fontFamily: "Segoe UI Variable Small, Segoe UI, system-ui, sans-serif"
    fontSize: "9px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.05em"
  mono:
    fontFamily: "Cascadia Mono, Consolas, ui-monospace, monospace"
    fontSize: "10px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.02em"
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  pill: "999px"
  dot: "50%"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  "2xl": "40px"
components:
  button-primary:
    backgroundColor: "{colors.indigo-deep}"
    textColor: "{colors.pure-white}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  button-primary-hover:
    backgroundColor: "{colors.signal-indigo}"
    textColor: "{colors.pure-white}"
  button-ghost:
    backgroundColor: "{colors.veil-02}"
    textColor: "{colors.graphite-mid}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  button-ghost-hover:
    backgroundColor: "{colors.veil-04}"
    textColor: "{colors.paper-dim}"
  card:
    backgroundColor: "{colors.veil-02}"
    textColor: "{colors.paper-dim}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "16px"
  card-hover:
    backgroundColor: "{colors.veil-04}"
  input:
    backgroundColor: "{colors.veil-03}"
    textColor: "{colors.paper-dim}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "9px 10px"
  nav-item:
    textColor: "{colors.graphite-mid}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
  nav-item-active:
    backgroundColor: "{colors.veil-04}"
    textColor: "{colors.paper-white}"
  pill:
    backgroundColor: "{colors.veil-03}"
    textColor: "{colors.graphite-quiet}"
    typography: "{typography.mono}"
    rounded: "{rounded.pill}"
    padding: "3px 7px"
  dialog:
    backgroundColor: "{colors.dialog-slate}"
    textColor: "{colors.paper-dim}"
    rounded: "{rounded.lg}"
    width: "min(620px, 100%)"
---

# Design System: AI Labs

## Overview

**Creative North Star: "The Ledger Room"**

This is an append-only record made visible. The interface is a dark, ruled surface on which entries
are laid down and never scrubbed out — cards, runs, reviews, findings, overrides, receipts. Its
authority comes from being unremarkable: a ledger that decorated itself would be less believable,
not more. Every panel is a row in a book that someone will read years from now to answer *who did
this, on what evidence, and who signed it.*

Everything follows from that. Surfaces are neutral and separated by hairlines rather than boxes.
Depth is a whisper of light on near-black, not a stack of floating cards. Type is small, dense and
confident, because the reader is an expert at a desk who wants the record, not an introduction to
it. Colour is rationed hard: on a screen where the accent appears everywhere, it means nothing, and
the one thing that must be findable at 2am — the item waiting on a human signature — is the one
thing that gets it. Machine-generated facts wear a monospaced face so the eye can tell what the
system asserts from what a person wrote.

The register is precise and evidentiary. Components should feel ruled, quiet and exact, as though
each one has an author and a timestamp attached. The confirmed anti-reference is **dashboard
candy** — gradient stat tiles, oversized rounded cards, celebratory colour, progress rings, anything
that decorates a number instead of sourcing it. A figure in this system earns its size by being
consequential, not by being the hero of a panel.

**Key Characteristics:**

- Near-black canvas (`#08090a`) with depth built from translucent white veils, never opaque grey plates
- Hairline rules at 5–8% white doing the work that borders, shadows and dividers do elsewhere
- Small, dense type: body at 13px, labels at 11px, machine facts at 10px monospaced
- One rationed indigo accent; six semantic status hues that never leave their states
- Flat at rest — glow marks live things, shadow is reserved for genuine overlay
- Windows-native faces throughout, no webfont, no network dependency

**A note on state.** The system described here is the system that ships. Type resolves to Segoe UI
Variable across its three optical cuts and Cascadia Mono with nothing fetched over the network; every
interactive element carries a focus ring; the accent has been pulled off chrome and rationed; every
colour the interface sets text in clears 4.5:1 against the surface behind it; and the radius scale is
three steps with no strays left. The one standing divergence is **spacing** — a set of hand-tuned odd
values (3, 5, 7, 9, 11, 13, 18, 22, 26px) survives from the original stylesheet. Those are normalised
when a component is next touched rather than in a sweep, because unlike a radius, a changed padding
moves everything around it. That is a stated policy, not a backlog item.

## Colors

A near-black ground, four grades of white light laid over it, one rationed indigo, and a fixed set
of status hues that are never borrowed for decoration.

### Primary

- **Signal Indigo** (`#7170ff`): the accent, and the scarcest colour in the system. It marks the
  single most consequential live or actionable thing on a screen — an item awaiting a human
  signature, a focused control, a ready state. Outside the application mark it is never a surface
  fill, and it never decorates.
- **Indigo Deep** (`#5e6ad2`): the resting state of the one primary button on a screen. Deliberately
  a step down from Signal Indigo, so the button reads as available rather than urgent, and brightens
  to the full accent on hover.
- **Indigo Light** (`#828fff`) and **Indigo Pale** (`#c1c6ff`): the accent's tinted register — ring
  strokes on ready-status dots, and legible accent text sitting on an accent wash. Pale indigo is
  the only accent value permitted for sustained reading.

### Secondary — the status set

Six hues, each bound to one meaning. They belong to state and never to chrome.

- **Entry Green** (`#27a644`, pale `#a9e4c2`): done, verified, healthy, service reachable. The
  colour of a closed entry.
- **Pending Amber** (`#d8a73e`, pale `#ecd9a8`): in progress, queued, running — work that is
  genuinely underway and not yet accountable.
- **Review Violet** (`#b58aea`): under review. Distinct from both the accent and from done, because
  a card in review is neither actionable by the owner nor finished.
- **Breach Red** (`#e25c5c`, pale `#ffc4c4`): blocked, failed, error, and the P0 stop. The only
  colour permitted to interrupt.

### Neutral

- **Ledger Black** (`#08090a`): the canvas. Every other surface is this colour with light laid over
  it.
- **Ledger Black Deep** (`#0c0d0e`): the sidebar — the one region that sits *beneath* the canvas
  rather than above it, so the navigation recedes and the work comes forward.
- **Dialog Slate** (`#151617`): overlay surfaces only. The single opaque plate in the system,
  because a dialog must fully occlude what it covers.
- **Veils 01–04** (`rgba(255,255,255,0.015 / 0.02 / 0.025 / 0.04)`): the surface ladder. Panels,
  cards, rows and hover states are all this white light at four strengths over Ledger Black.
- **Rule Hairline** (`rgba(255,255,255,0.08)`) and **Rule Hairline Faint**
  (`rgba(255,255,255,0.05)`): every border, divider and column edge. The faint grade separates
  regions; the full grade outlines objects.
- **Paper White** (`#f7f8f8`): primary text and the active navigation item.
- **Paper Dim** (`#d0d6e0`): sustained reading text — card titles, field values, body copy inside
  panels.
- **Graphite Mid** (`#8a8f98`): supporting text and resting control labels.
- **Graphite Quiet** (`#7a7e85`): metadata, counts, timestamps, placeholder and disabled text. The
  floor of legibility — and the floor is a measured one: 4.89:1 on the canvas, 4.77:1 on the sidebar,
  4.56:1 on the lightest veil. Nothing in the system may sit dimmer than this against a surface it
  has to be read on.
- **Rule Graphite** (`#2a2c31`) and **Mark Graphite** (`#24252a`): the two solid greys — the
  reporting-line elbows in the staff tree, and the plate behind a runtime glyph.

### Tertiary — the encoded set

Four places carry colour that is neither neutral nor a status verdict. Each encodes an identity or a
degree, and each is listed here so the difference between a system member and drift stays checkable.

- **Breach Wash** (`rgba(180,55,55,0.12)`) and **Breach Rule** (`rgba(240,90,90,0.25)`): the surface
  and border of an error banner or a failed field, carrying Breach Red Pale text. One pair, used at
  both scales — the banner and the inline field error are the same object at different sizes.
- **Priority Urgent** (`#ff8181`) and **Priority High** (`#e7b759`): degree, not state. They tint
  only the priority label on a card, never the card itself.
- **Runtime tints** — Claude (`#e7b29c` on `rgba(196,102,65,0.13)`), Kimi (`#bdd7ff` on
  `rgba(68,122,195,0.14)`), and the accent-family Hermes mark. These sit on the 29px runtime glyph
  and nowhere else. They encode which vendor is behind an employee, so a staff list is readable by
  provider without a legend.
- **Scrim Heavy** (`rgba(0,0,0,0.82)`) and **Scrim Inset** (`rgba(0,0,0,0.35)`): the dialog backdrop
  and the well behind a copyable command. The only true blacks — everywhere else, darker means less
  white light, not more black.

### Named Rules

**The Rationed Accent Rule.** Signal Indigo appears on no more than roughly a tenth of any screen,
and on at most one *primary* target per view. Its scarcity is the mechanism: the queue of things
waiting on a human signature is the thing it exists to make findable, and every extra indigo pill
spends that budget. Chrome — navigation, tabs, filter pills, metadata pills, badges and links — is
neutral.

**The Identity Exception.** The 30px application mark keeps the indigo gradient, and it is the only
static chrome that does. It sits in one fixed corner at roughly a thousandth of the viewport, so it
never competes with a queue item for attention — the eye stops seeing fixed furniture within a
session. This exception is bounded by both size and position: it licenses a mark, not a header, a
sidebar, or a coloured rail. Like The Focus Exception, it is exempt from the budget rather than
charged against it.

**The Focus Exception.** Focus is the one accent use that is never budgeted. Every interactive
element gets a visible `#7170ff` focus ring regardless of how much accent is already on screen.
Visibility of focus is an accessibility guarantee, not a decorative choice, and it outranks the
rationing rule.

**The Neutral Record Rule.** A surface never colours itself. Colour enters only as state — a status
dot, a gate verdict, a finding priority, a run outcome — and always through a hue with exactly one
meaning. If a panel needs to look important, it earns that with position, rule weight and type, not
with a tint.

## Typography

**Display Font:** Segoe UI Variable Display (with Segoe UI, system-ui)
**Body Font:** Segoe UI Variable Text (with Segoe UI, system-ui)
**Small/Label Font:** Segoe UI Variable Small (with Segoe UI, system-ui)
**Mono Font:** Cascadia Mono (with Consolas, ui-monospace)

**Character:** The Windows 11 type program, used as designed. Segoe UI Variable ships three optical
sizes and this system uses all three — Display cut for headings, Text for reading, Small for the
9–11px labels where the Text cut would blur shut. It is a face nobody notices, which is exactly
right for a record. Cascadia Mono is its purpose-built companion: tighter and colder than a general
mono, so identifiers and hashes read as machine output rather than as prose in a different font.

Both faces are present on the target platform. **Nothing is fetched over the network**, which is
what a local-first product that binds to loopback requires — an interface whose type silently
degrades on an offline machine is not local-first.

### Hierarchy

- **Display** (500, 26px, -0.5px, lh 1.15): portfolio figures on Command — the count of ventures,
  staff, open cards, spend. The only place type is permitted to get large, and only for a number
  that is genuinely consequential.
- **Headline** (500, 24px, -0.4px, lh 1.2): section headings that open a surface.
- **Title** (500, 19px, -0.24px, lh 1.3): the page title in the top bar and the dialog title.
- **Subtitle** (500, 14px, lh 1.35): the name of an object on its own card — a role title in the
  staff tree, a skill name, a venture name, the application wordmark. The largest type that appears
  inside a card rather than above a region.
- **Body** (400, 13px, lh 1.5): reading text — card descriptions, row labels, navigation, agent
  functions. Cap measure at 70–75 characters in prose regions; the reading panels already do this
  with a 1120px container.
- **Control** (500, 12px, lh 1.35): buttons, inputs, selects, tabs and pill filters. Every
  interactive control shares one size, so a row of mixed controls aligns optically.
- **Label** (500, 11px, 0.06em, uppercase): section labels in the sidebar, eyebrows above titles,
  field labels in forms. Uppercase with tracking is what makes an 11px label scan as a label rather
  than as small body text.
- **Micro** (500, 9px, 0.05em, uppercase): the floor of the ramp. Priority markers, metadata pills,
  run states, authority levels, and the secondary line inside a checkbox row. Legible only as a short
  uppercase token inside a pill or beside a status dot.
- **Mono** (500, 10px, 0.02em): machine facts only.

### Named Rules

**The Optical Size Rule.** Match the Segoe cut to the size band: Display above 20px, Text from 12 to
20px, Small at 11px and below. Setting an 11px label in the Display cut is the difference between a
label that reads and one that smudges, and it costs nothing to get right.

**The Mono Means Machine Rule.** Cascadia is reserved for facts the system generated and a human did
not write: identifiers, hashes, counts, token and cost figures, authority levels, runtime commands,
endpoints, install strings, timestamps. Never for prose, never for emphasis, never for a heading. If
a person typed it, it is not mono.

**The Small Type Is Earned Rule.** Below 11px, type survives only as a short token in a container
that frames it — 10px monospace against a hairline-bordered pill, 9px uppercase beside a status dot.
Never set a sentence at 10px or below, and never put anything there that a person must read to make
a decision. **Nine sizes is the whole ramp**; a tenth is drift, not a new role.

## Layout

**The shell.** A two-column grid: a fixed 236px sidebar and a fluid main area. The sidebar is sticky
at full viewport height and sits on the one surface darker than the canvas, so navigation reads as
the frame rather than as content. The top bar is 82px, sticky, and translucent — an 82% Ledger Black
wash over an 18px backdrop blur — so content dissolves under it while scrolling rather than clipping
against a hard edge. Content sits at 22px top, 24px sides, 40px bottom.

**Reading widths are capped, deliberately.** Workspace panels cap at 1120px and the staff tree at
850px, both centred. A record is read in a column, not stretched across a 34-inch monitor.

**The board is the exception.** Six gate columns at `minmax(220px, 1fr)` with a hard 1380px minimum,
scrolling horizontally inside its own container via `:has(.board)`. The page itself never scrolls
sideways — only the board does, inside its own frame.

**Content grids auto-fit rather than fixing column counts:** runtime cards at `minmax(260px, 1fr)`,
skill cards at `minmax(300px, 1fr)`, organization cards at `minmax(260px, 1fr)`, portfolio figures at
`minmax(140px, 1fr)`. The Command split is asymmetric — `minmax(240px, 1fr)` beside
`minmax(320px, 2fr)` — because the ledger of statuses is a narrower object than the run list beside
it.

**Rhythm.** A 4px base with steps at 4 / 8 / 12 / 16 / 24 / 40. Card interiors take 16px, dense rows
8–12px, section separations 24px. *Incumbent divergence: the shipped stylesheet uses many odd
intermediate values (3, 5, 7, 9, 11, 13, 18, 22, 26px) from hand-tuning. New work uses the scale;
existing values are normalised when a component is next touched, not in a sweep.*

**Responsive.** Two breakpoints, both real collapses rather than cosmetic reflows.

- **900px:** the Command split and three-column form rows go to a single column.
- **760px:** the sidebar stops being a sidebar — static, full width, with primary navigation as a
  three-column grid and the project list and status footer hidden outright. The top bar drops to
  74px and loses the command hint. The staff tree's indent per depth drops from 54px to 18px and its
  connector elbow narrows from 28px to 9px, so hierarchy survives on a narrow screen instead of
  pushing cards off it.

### Named Rules

**The Board Scrolls, The Page Doesn't Rule.** Horizontal overflow belongs to the component that
needs it, inside its own `overflow-x` container. The document body never scrolls sideways at any
width.

**The Hidden Beats The Squeezed Rule.** At 760px the secondary sidebar regions are hidden, not
compressed. A navigation list crushed to 90px is worse than one that is honestly absent, and the
surfaces it reaches are still reachable from the primary navigation grid.

## Elevation & Depth

The system is flat at rest and builds depth from tonal light rather than from cast shadow. Three
mechanisms, three distinct jobs, and they do not substitute for one another.

**Veils build the surface stack.** A panel is Ledger Black with white light laid over it at 1.5–4%.
Four steps is the whole ladder: 1.5% for the quietest containers, 2% for cards and rows, 2.5% for
inputs and marks, 4% for hover. This is why the palette has no opaque grey plates — a surface is the
canvas plus light, so nesting never accumulates into muddy grey.

**Hairlines make edges.** Every boundary is a 5% or 8% white rule. Rules do the work that shadows do
in other systems, which is what makes the interface read as ruled paper rather than as stacked
panels.

**Glow marks live things, shadow marks overlay.** A glow says *this is active, ready or focused* — a
project dot's `currentColor` bloom, the primary button's indigo bloom, the focus ring. A shadow says
*this floats above the page*, and only the dialog is permitted one. Static chrome gets neither: the
application mark carried a 24px halo and lost it, because a wordmark is never live and a zero-offset
coloured halo on something that cannot change state is decoration wearing a signal's clothes.

### Shadow Vocabulary

- **Overlay lift** (`box-shadow: 0 20px 80px rgba(0, 0, 0, 0.55)`): dialogs only. Deep, soft and far,
  so the dialog reads as genuinely above the page rather than embossed onto it.
- **Accent bloom** (`box-shadow: 0 2px 16px rgba(94, 106, 210, 0.18)`): the primary button at rest.
  The one place a control advertises itself.
- **Live dot** (`box-shadow: 0 0 10px currentColor`): status and project dots, inheriting the dot's
  own colour so the glow is always the right hue.
- **Focus ring** (`box-shadow: 0 0 0 3px rgba(113, 112, 255, 0.09)` with a
  `rgba(113, 112, 255, 0.7)` border): every focusable control.
- **Inset rule** (`box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.05)`): the active navigation
  item, where an outer border would shift layout.

**Blur is structural, not decorative.** Three backdrop filters, each where a surface genuinely
overlaps content: 18px under the top bar, 16px under the sticky dialog heading, 6px on the dialog
backdrop.

### Named Rules

**The Three Jobs Rule.** Veil for the surface stack, glow for signal, shadow for overlay. A new
component picks the mechanism that matches its job — it does not add a shadow to look elevated, and
it does not add a glow to look important.

**The One Shadow Rule.** Exactly one component type casts a real drop shadow: the dialog. If
something new appears to need one, it is either an overlay (and should be a dialog) or it is not
elevated at all.

## Shapes

Rectangles with a small, consistent softening. Nothing in this system is round except things that
are genuinely dots.

**Three radii carry everything.** 6px for controls — buttons, inputs, selects, list rows, tabs. 8px
for containers — cards, board columns, panels, the application mark, form fieldsets. 12px for
dialogs, the only surface allowed to feel like a separate object. Pills use 999px and status dots
use 50%, and those are shapes rather than scale steps.

This is enforced, not aspirational: the stylesheet once articulated five container radii between 5px
and 9px, and every stray has been folded into the three steps. The difference between 5, 6 and 7px is
not perceivable and never survived as a system — it only made the scale unfalsifiable, because with
five neighbouring values no new number is ever obviously wrong.

**Borders are the form language.** Almost every object is defined by a hairline rather than by a
fill, which is why the interface holds together at 1.5% surface contrast. Dashed hairlines mark a
slot where something is absent but expected — an empty gate column, an add-project affordance — and
that is the only place a dashed rule appears.

**The reporting elbow.** The staff tree draws hierarchy with an L-shaped hairline in Rule Graphite
(`#2a2c31`), 28px wide, on a 7px bottom-left corner, faded out entirely at the root by
`opacity: min(1, var(--depth))`. It is the one drawn line in the system that is neither a border nor
a divider, and it is worth preserving exactly.

### Named Rules

**The Three Radii Rule.** 6px controls, 8px containers, 12px overlays. Anything else is a stray.

**The Dashed Means Absent Rule.** A dashed hairline means *nothing is here yet and something should
be*. It never means disabled, never means optional, and never appears on a container that holds
content.

## Components

### Buttons

Three weights, and a screen should rarely show more than one of the first.

- **Shape:** softened rectangle (6px), 8px × 12px padding, Control type (12px / 500).
- **Primary:** Indigo Deep (`#5e6ad2`) with white text, a 10% white hairline and the accent bloom.
  Brightens to Signal Indigo (`#7170ff`) on hover. One per view — the primary action of that
  surface. Disabled drops to 60% opacity with a `wait` cursor, because the disabled state here means
  *submitting*, not *forbidden*.
- **Ghost:** Veil 02 on a hairline with Graphite Mid text, lifting to Veil 04 with Paper Dim text on
  hover. The default for everything that is not the primary action.
- **Icon:** 30px circle, hairline bordered, Veil 03, Graphite Mid glyph. Used only for dismissal and
  other single-glyph actions where a label would be noise.
- **Row action** (the card-level action, e.g. starting a run): full-width, Veil 02, faint hairline,
  10px text, Graphite Quiet at rest — deliberately recessive until hovered, when it takes an accent
  hairline (`rgba(113,112,255,0.35)`), Pale Indigo text and a 7% accent wash. This is the one place
  the accent is permitted on hover for a non-primary control, because it is the moment work starts.

### Cards / Containers

- **Corner style:** 8px.
- **Background:** Veil 02, rising to Veil 04 on hover. Never an opaque plate.
- **Border:** Rule Hairline (8%) for objects; Rule Hairline Faint (5%) for regions and columns.
- **Shadow strategy:** none. See Elevation & Depth.
- **Internal padding:** 16px for content cards, 12px for dense cards, 10px for board columns.

### Inputs / Fields

- **Style:** Veil 03 on a full hairline, 6px radius, 9px × 10px padding, Paper Dim text at Control
  size. Labels sit above in Label type, Graphite Mid.
- **Focus:** border to `rgba(113,112,255,0.7)` plus a 3px `rgba(113,112,255,0.09)` ring. The ring is
  wide and faint rather than narrow and bright, so a focused field in a dense form is obvious without
  being loud.
- **Disabled:** 45% opacity, `not-allowed` cursor. Used where a runtime genuinely has no flag for an
  option — the field states *unsupported* rather than pretending the option exists.
- **Checkbox rows:** the input is a 15px accent-tinted box inside a bordered 56px row carrying a
  bold label and a small explanatory line. The whole row is the target, not the box.

### Navigation

- **Style:** full-width 6px rows, 8px × 10px, Body type at 500 weight, Graphite Mid at rest.
- **Hover:** Paper Dim text on a 3% wash.
- **Active:** Paper White text, 5.5% wash, and an inset 5% hairline instead of an outer border so
  nothing shifts. Navigation is *not* accented — position and weight carry the current surface.
- **Mobile (≤760px):** the sidebar becomes a static full-width block and the primary navigation
  becomes a three-column grid; secondary regions are hidden rather than compressed.

### Status Dots

The system's smallest and most-repeated object: an 8px ring with a 45–50% fill of its own hue —
Indigo Light for ready, Pending Amber for in progress, Review Violet for review, Entry Green for
done, Breach Red for blocked, and a bare Graphite Quiet ring for an undefined state. A hollow ring
with a translucent fill reads as a state marker; a solid disc would read as a bullet.

### Pills and Badges

One shape (999px), three registers: **neutral** (Veil 03, hairline, Graphite Quiet) for metadata and
counts; **mono** (10px Cascadia) for authority levels, run states and counts; **tinted** for genuine
state, using a status hue at ~14% wash with its pale text. Tinted pills are the exception, not the
default.

### Runtime Mark

A 29px rounded square (7px) holding a short monospaced glyph, tinted per provider — each runtime gets
its own wash and text colour so a staff list can be read by provider at a glance without a legend.
This is a legitimate exception to the Neutral Record Rule: the tint encodes an identity, not a
decoration.

### Dialog

`min(620px, 100%)`, 12px radius, Dialog Slate (`#151617`) — the one opaque surface — on an 11% white
hairline with the overlay lift. The backdrop is 82% black at 6px blur. The heading is sticky with its
own blur so a long form scrolls under a title that stays put. Compact variants cap at 500px.

Behaviour is part of the component: focus moves to `[data-autofocus]` or the first focusable element
on open, Tab is trapped in both directions, Escape closes, focus returns to the opener on unmount,
and a click on the backdrop dismisses. Any new overlay inherits this component rather than
reimplementing it.

### Signature Component — the Reporting Tree

The staff hierarchy, rendered as indented cards rather than as a diagram: 54px of indent per depth
(18px on mobile), each card drawing its own connector elbow in Rule Graphite, with the elbow faded to
nothing at the root. A card carries the runtime mark, the role title, the agent name beneath it, an
authority pill pushed right, the job function in Graphite Mid, and a row of metadata pills. It is the
clearest expression of the whole system: an org chart that reads as a ruled document rather than as
boxes and arrows.

## Do's and Don'ts

### Do:

- **Do** build every surface as Ledger Black plus a veil (1.5 / 2 / 2.5 / 4% white). Nesting stays
  clean because nothing is an opaque plate.
- **Do** define objects with hairlines — 8% for objects, 5% for regions. If a new component looks
  undefined, the answer is a rule, not a shadow.
- **Do** give every interactive element a visible `#7170ff` focus ring. This is exempt from the
  accent budget.
- **Do** use the three Segoe optical cuts by size band — Display above 20px, Text 12–20px, Small at
  11px and below.
- **Do** reserve Cascadia Mono for machine-generated facts: identifiers, hashes, counts, costs,
  authority levels, commands, endpoints.
- **Do** put horizontal overflow inside the component that needs it. The board scrolls; the page
  does not.
- **Do** state an unsupported capability as unsupported — a disabled field with an explanation, not
  a hidden control or a plausible-looking fake.
- **Do** reuse the dialog component for any overlay, so focus trapping, Escape and focus restoration
  come for free.
- **Do** hide secondary navigation regions at 760px rather than compressing them.

### Don't:

- **Don't** load a webfont. Both faces ship with the platform, and a local-first product that fetches
  type over the network degrades silently on the machine it was designed for. Reach for the four
  stacks on `:root` — `--font-display`, `--font-text`, `--font-small`, `--font-mono` — never a
  literal family name.
- **Don't** spend Signal Indigo on chrome. Navigation, tabs, filter pills, metadata pills, badges and
  links are neutral. The queue waiting on a human signature is what the accent exists for; the
  application mark and the focus ring are its only exemptions.
- **Don't** tell two things apart with a hue when rule weight, face or position will do it. Skill
  pills and tuning pills were an accent tint against an amber tint; they are now a full hairline
  against a monospaced face, which also says something true — a tuning value is a machine fact.
- **Don't** set text in a colour that has not been measured against the surface behind it. Graphite
  Quiet at 4.56:1 on the lightest veil is the floor; a one-off grey dimmer than the token is how a
  system fails an audit it thought it passed.
- **Don't** introduce a second accent hue. Colour beyond the neutrals belongs to the six status
  meanings, and a new meaning needs a new state, not a new colour.
- **Don't** cast a drop shadow on anything but a dialog.
- **Don't** add a radius outside 6 / 8 / 12px. The scale is deliberately coarse so that a fourth
  value is visibly wrong rather than arguably fine.
- **Don't** set prose in monospace, or any sentence at 10px.
- **Don't** build dashboard candy: gradient stat tiles, progress rings, oversized rounded hero
  cards, celebratory colour on completion. A figure earns its size by being consequential.
- **Don't** use a dashed border for anything except a slot where something is expected and absent.
- **Don't** show a state the interface has not verified. An optimistic checkmark, a fake progress
  bar or a "done" that means "request sent" contradicts the product's own definition of done.
- **Don't** declare a colour token without using it. A token nothing references is a second,
  competing source of truth that will eventually be revived by someone who assumes it is live.
  `--panel`, `--surface` and `--surface-hover` were exactly that and have been deleted; the veil
  ladder is the surface system.
