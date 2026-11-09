# Doomforge dashboard recovery implementation plan

1. Rebuild `frontend/src/styles.css` as the single graphite/ivory/teal shell and shared component layer, including a responsive rail, breadcrumb header, session notices, overview cards, and focus states.
2. Align the sidebar route inventory with role destinations. Remove fake counters, static workspace switching, fictitious judging countdown, and settings navigation. Keep the `Sidebar` prop contract unchanged.
3. Simplify the top bar to breadcrumbs, the clearly labeled demo role selector when demo mode is active, real live-session state, and the session identity. Remove theme toggles and unsupported notification/command controls. Keep the `Topbar` prop contract unchanged.
4. Rework judge workspace, command center, and results CSS around paper surfaces, 15px minimum core body text, 44px controls, evidence/scoring split, readable tables, and small-screen stacking. Preserve all existing class names used by their React components.
5. Run the frontend typecheck and build after integration-ready changes; inspect the browser if the local preview can be started without changing another worker's state. Do not edit route/overview/judge logic or tests.

## Ownership

This work owns only the shared stylesheet, brand/sidebar/topbar components, judge workspace stylesheet, organizer command-center stylesheet, results stylesheet, and these design/plan notes. Route and data integration remains with the coordinating worker.
