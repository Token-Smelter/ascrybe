# Ascrybe Dashboard Design

## Intent

A technical lead works through a dense software topology in a dim, interruption-heavy environment, following one contested assertion until its source and receipt are undeniable. The interface is an investigative instrument, not a reporting dashboard.

## Foundation

- **Register:** product
- **Platform:** responsive web
- **Color strategy:** nigredo ground with citrinitas focus, olive verified continuity, ember flow, and distinct danger for contradiction or failure.
- **Primary navigation:** rendered graph nodes and edges.
- **Supporting navigation:** search, projection controls, breadcrumbs, and bounded inspection results.
- **Density:** high, but revealed by semantic layers and neighborhood depth rather than simultaneous labels.

## Color

The dashboard is dark on dark: `--ts-canvas` is nigredo (`#16130F`), while panels use `--ts-surface` and raised controls use `--ts-surface-raised`. This preserves the instrument's dim, interruption-ready environment and keeps paper, gold, citrinitas, and ash legible; cream is not an application ground or a work surface.

The Token Smelter palette is inherited from `knowledge/brand/brand-tokens.css` in the Doxagon vault at sha256 `a17f560dfba2b84789009e99ec7455fee4752bf866589958f51d8ccd9f597fe3`. `--ts-text-primary`, `--ts-text-secondary`, `--ts-text-muted`, and `--ts-text-faint` form the text ramp; `--ts-focus` is citrinitas. Surface, border, radius, and shadow tokens are all in the `--ts-*` namespace.

Gold is deliberately scarce: `--ts-status-output` marks only receipt nodes, the Project and SourceCommit anchors, and an `identifies` edge carrying a resolution receipt. It is not a general link, hover, border, or verified-relation colour. `--ts-status-success` marks verified or supported continuity; `--ts-status-warning` marks underdetermined and unresolved relations; `--ts-status-danger` marks contradiction, refutation, and failed projection. `--ts-status-running` is rubedo only as a filled running control with paper text, while the visible `data-status="working"` projection label uses `--ts-ember`; `data-status="failed"` uses danger. Status always remains redundant with the dashboard's labels, icons, or shapes.

## Typography

```css
--ts-font-display: 'Space Grotesk', system-ui, sans-serif;
--ts-font-body: 'Newsreader', Georgia, serif;
--ts-font-mono: 'JetBrains Mono', ui-monospace, 'SFMono-Regular', monospace;
--ts-track: 0.02em;
--ts-track-cap: 0.16em;
```

- Space Grotesk is the display and UI-heading face.
- Newsreader is reserved for prose: inspector descriptions and other long explanatory copy, never dense tables or metadata.
- JetBrains Mono is used for identifiers, timestamps, states, metadata, source coordinates, and code.
- All-caps dense UI labels use `--ts-track-cap`; normal body text uses `--ts-track`. The presentation-only extra-wide tracking value is not used by this dashboard.
- Graph labels remain 11–13px and reveal on selection, hover, or membership in the current semantic neighborhood.

## Application Structure

The graph occupies the main viewport. A narrow top command rail contains estate identity, projection selector, search, depth, and filters. A contextual inspector docks to the right after selection and can be collapsed. A low status rail shows selected/working generation, source commit, coverage watermark, and drift.

Do not use a permanent list sidebar. Search results appear as a temporary command surface and resolve into highlighted graph nodes. The inspector contains only the selected node’s bounded evidence and immediate navigation actions.

## Graph Grammar

### Node forms

- Document: compact folded rectangle.
- Claim: horizontal capsule with an in-shape verdict marker: check for supported, cross for refuted, and question for open, unverifiable, or unadjudicated; no decorative fill.
- Referent/entity: ringed circle; no invented display name beyond witnessed surfaces.
- Code fact/declaration: small square.
- Evidence: diamond.
- Receipt: hexagon, hidden by default until provenance expansion.
- Project and SourceCommit: double-ring anchors.
- Bundle: dashed folded pill with its count inside.

Node shape carries kind; status colour is secondary to the shape and the visible label, never the only distinction.

### Edge forms

- Structural containment: a thin straight low-contrast line in `--ts-border-subtle`.
- Flow: a bowed, heavier `--ts-ember` path that remains more prominent than containment.
- Annotation: a dashed path.
- A receipted identity-resolution edge is directional, carries its receipt evidence, and is the only identity edge that receives `--ts-status-output`.
- Claim support and verified continuity use `--ts-status-success`.
- Contradiction, refutation, and failed projection use `--ts-status-danger`.
- Under-determined or unresolved relation uses `--ts-status-warning` and a dashed stroke.
- Supersession is directional with a clear arrow.

Aggregate edges at high altitude. Expand exact edges only as the user drills down.

## Interaction

1. Load an estate-level topology, not every node.
2. Selecting a node fetches a bounded neighborhood from the query API.
3. Expanding depth adds one semantic layer while preserving the current spatial anchor.
4. Selecting a claim opens its verdict, realization, source quote, obligations, evidence, and receipt chain.
5. Selecting an entity reveals containment, dependencies, documentary claims, and code declarations.
6. A provenance action traces the shortest receipted path to exact source bytes.
7. Selected and working projections remain visually distinct and always show their generation IDs.

Use 150–220ms state transitions. Motion communicates graph expansion, selection, or projection change. Disable nonessential transitions under reduced-motion preferences.

## States

- **Loading:** preserve the current topology and skeleton only the incoming neighborhood.
- **Empty search:** explain which node kinds and exact fields are searchable.
- **Truncated neighborhood:** show returned/total counts and offer deliberate depth expansion.
- **Working projection:** persistent rubedo running fill with paper text, ember running text, and processed/total watermark.
- **Stale projection:** source and live commits remain visible; never hide drift.
- **Projection failure:** keep the selected graph available and expose the failed working receipt.
- **Disconnected:** retain the last bounded graph and mark query controls unavailable.

## Agent Surface

The command-line client and Pi skill share the dashboard query core and stable result schemas. Agent outputs always include projection ID, source commit, truncation metadata, and provenance references. No agent command accepts arbitrary Cypher in the first release.

## Responsive Behavior

Desktop is the primary investigative surface. Below 900px, the inspector becomes a bottom sheet and command controls collapse into one toolbar. The graph remains primary. Mobile supports inspection and search but is not optimized for estate-wide topology editing.

## Prohibitions

- No list-first home screen.
- No identical metric-card grid.
- No decorative force simulation or continuously moving nodes.
- No giant preloaded graph hairball.
- No hidden truncation, drift, provisional state, or evidence boundary.
- No direct browser or agent access to Neo4j credentials.
