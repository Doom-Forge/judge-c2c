# Doomforge dashboard design system

## 0. Product research

- [Devpost judging guide](https://help.devpost.com/article/103-how-to-judge-an-online-hackathon):
  puts judging criteria and per-judge progress on the start screen, then presents
  one submission and a clear save-and-continue action.
- [RoundOne judge portal](https://www.roundone.dev/docs/links/judge-portal):
  groups project context beside the rubric and exposes a weighted total; Doomforge
  adopts the evidence grouping and keeps scores private, with no AI judge or
  passwordless shared judge links. Server-assigned roles and team assignments
  remain the access boundary.
- [Evalato program menu](https://hub.evalato.com/help/-the-program-menu):
  separates application intake, evaluation rounds, judge assignments, and results.
  Doomforge uses this separation for team intake, two review stages, and organizer
  controlled release.

## 1. Atmosphere & identity

Doomforge is a focused judging workspace: composed under deadline pressure,
clear about evidence and pending decisions. The visual language pairs deep
plum-graphite surfaces with a restrained royal-violet accent and formal serif
page headings. Functional copy, navigation, and judging controls stay in a
crisp sans-serif system face.

## 2. Color

| Role           | Token          | Light     | Dark      | Usage                                  |
| -------------- | -------------- | --------- | --------- | -------------------------------------- |
| Page           | `--df-canvas`  | `#f7f4fb` | `#100d18` | App background                         |
| Surface        | `--df-surface` | `#ffffff` | `#191522` | Main panels                            |
| Raised surface | `--df-raised`  | `#f3eff8` | `#221d2e` | Table headings and grouped content     |
| Primary text   | `--df-ink`     | `#241a32` | `#f3eff8` | Headings and body                      |
| Secondary text | `--df-muted`   | `#655b70` | `#aaa1b5` | Supporting information                 |
| Border         | `--df-line`    | `#ded6e8` | `#393348` | Dividers and controls                  |
| Accent         | `--df-accent`  | `#6b42b3` | `#c1a7ff` | Primary action and selected navigation |
| Warning        | `--df-warning` | `#94611a` | `#e9b766` | Pending or attention state             |
| Error          | `--df-danger`  | `#b42318` | `#ff7b72` | Failed or blocked state                |

Do not use a result color as decoration. Unpublished marks and scores remain
inside authenticated, role-checked views.

## 3. Typography

- Page headings use Georgia as a formal display face. UI and section headings
  use Avenir Next, SF Pro, system UI, then sans-serif.
- IDs, commit hashes, compact metadata, and technical evidence use the system
  monospace stack.
- Body text is at least 14px. The page title uses a responsive 34–48px scale;
  section headings use 18–24px and labels use 12–14px.
- Numeric scores and counts use tabular numerals.

## 4. Spacing & layout

The base spacing unit is 4px. Shared values are 4, 8, 12, 16, 24, 32, 40, and
48px. The content width is capped at 1440px with responsive side padding.

`Layout: Round 2 workspace - app navigation with a document-scrolling review surface -> fixed top navigation and one document scroll owner; table wrappers may scroll horizontally for wide evidence tables; no nested vertical page scrollers.`

At narrow widths the navigation wraps into a dedicated row and the content
panels become one column. Primary content must reflow at 390px without a
horizontal page scrollbar. Long IDs and URLs wrap within their own regions.

## 5. Components

### Workspace navigation

- Structure: brand, active workspace links, environment state, and optional
  account actions in one top navigation region.
- States: default, hover, active, keyboard focus, disabled.
- Accessibility: semantic navigation landmark; controls remain keyboard
  reachable and have visible focus.
- Layout: fixed-height top region; the document owns vertical scrolling.

### Judging stage summary

- Structure: one grouped horizontal summary with separate analysis-document
  and pull-request stages, their specified weights, and the pending/release
  rule.
- States: static policy summary; no score is shown unless returned by an
  authorized API.
- Accessibility: headings and stage order remain meaningful when stacked on
  mobile.
- Layout: two columns when space allows, one column on narrow screens.

### Evidence panel and table

- Structure: titled panel, optional filters, data table or empty/error state.
- States: loading, populated, empty, error, and disabled.
- Accessibility: native buttons and form labels; tables retain captions and
  column headers; status uses text as well as color.
- Layout: document scroll owns vertical movement; a table wrapper may own
  horizontal movement when columns require it.

### Action control

- Structure: one primary action per view, with secondary actions visually
  quieter.
- States: default, hover, pressed, focus-visible, disabled, loading.
- Accessibility: minimum 44px touch target and a visible 2px focus ring.

## 6. Motion & interaction

Use 120–180ms transitions for hover and pressed feedback, limited to color and
opacity. There is no decorative motion. Under reduced-motion preference,
transitions are disabled.

## 7. Depth & surfaces

Use tonal surfaces and neutral 1px rules. Keep the existing restrained shadow
for elevated dialogs only. Avoid colored edge bars, glow, blur, and cards inside
cards.

## 8. Accessibility constraints & accepted debt

- Target WCAG 2.2 AA text and control contrast in light and dark themes.
- All actions are keyboard reachable with visible focus.
- At 320px, the page reflows without horizontal scrolling except for genuinely
  two-dimensional evidence tables.
- Status labels remain explicit in text; color alone never carries meaning.
- No new dependency is needed for this vanilla HTML/CSS/JavaScript surface.

## 9. Grounding gap ledger

| ID  | Screen / state     | Gap                                                                                               | Fix                                                                                            | Proof                                                                                                                                                                                              | Status |
| --- | ------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| G1  | Workspace overview | The prior page led with a public PR form and did not explain the Round 2 document/PR stage split. | Add the specified 10/90 policy summary and organizer release rule above the live review queue. | Before captures: `/var/folders/hn/js7nvdv53j1d05_7hmn8ncyc0000gn/T/doomforge-dashboard-before-ThMt4b/desktop-1440-light.png` and `iphone-14-light.png`; compare after at desktop and phone widths. | Open   |
| G2  | Mobile navigation  | Existing navigation wraps without a role-oriented label or hierarchy.                             | Keep only current functional destinations and name the authenticated role workspace clearly.   | Browser capture at 390px and keyboard navigation.                                                                                                                                                  | Open   |
