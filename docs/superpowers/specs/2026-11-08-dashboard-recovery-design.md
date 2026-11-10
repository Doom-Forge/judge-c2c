# Doomforge dashboard recovery design

## Product and audience

Doomforge is a private engineering evaluation arena. Judges need to inspect evidence beside scoring controls; organizers need to read operational state and publish reliable results; participants need to understand their submission and evaluation status. This redesign gives all three roles the same calm, legible workspace frame.

## Agreed visual system

- **Graphite** `#252c2c`: persistent navigation and dark context surfaces.
- **Ivory** `#f6f5ee`: page canvas and the visual field around work.
- **Paper** `#fffefa`: cards and form surfaces.
- **Muted teal** `#387b72`: primary action, focus, selected navigation, and positive state.
- **Ink** `#202827`: high contrast copy; **stone** `#68716d`: secondary copy; **rule** `#d8ddd5`: quiet structure.
- Typography: bundled Inter Variable for editorial headings and body; bundled JetBrains Mono only for evidence identifiers, scores, timestamps, and compact system labels. No new font dependency.
- Layout: 256px graphite role navigation, 72px ivory utility header, content constrained to 1480px with 24px gutters and 32px section rhythm. Surfaces use crisp borders and modest 8px corners.
- Controls: minimum 44px for interactive controls, visible teal keyboard focus, responsive single-column layouts, reduced motion respected.

## Layout sketch

```text
┌ graphite navigation ┐  ┌ ivory topbar: breadcrumb · role identity ──────┐
│ Doomforge mark      │  │                                                │
│ role workspace     │  │  page thesis / title                           │
│                    │  │  live evidence and actions                     │
│ role routes        │  │  ┌ paper surface ─┐ ┌ paper surface ─┐          │
│                    │  │  │ context        │ │ decision       │          │
│ private workspace  │  │  └────────────────┘ └────────────────┘          │
└────────────────────┘  └────────────────────────────────────────────────┘
```

## Signature

A four-cell forge mark resolves into a single teal aperture in the graphite sidebar. The asymmetry signals a place where raw engineering evidence becomes a judged result, without adding decoration to the work surface.

## Review before implementation

The deliberately chosen risk is a restrained warm ivory field against a dense graphite navigation rail, with all role accents converging on muted teal. It follows the explicitly selected palette while avoiding generic dashboard gradients, oversized metric heroes, gratuitous serif display type, and tiny labels. Evidence and scoring retain distinct surfaces and a clear reading order.

## Scope

Apply the visual system to the shared shell, role navigation, judge evidence/scoring workspace, organizer command center, and results surface. Keep React behavior and route ownership with the integration work; remove shell controls or links that do not represent live behavior.
