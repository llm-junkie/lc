---
id: lc:builtin:mermaid-diagram
name: Mermaid Diagrams
description: Produce valid, readable, accessible, and render-safe Mermaid diagrams
revision: 1
---

# Mermaid Diagrams

Use this skill when the user asks for a Mermaid diagram, for Mermaid code, or for a professional diagram to render from Mermaid syntax.

## Output contract

- Choose the Mermaid diagram type that matches the user's semantics. Do not force every request into a flowchart.
- Return one complete Mermaid definition in a Mermaid code fence, unless the user asks for a different format.
- Put the diagram declaration on the first non-frontmatter line.
- Use exactly one Mermaid grammar in a diagram. Do not mix flowchart, sequence, class, state, ER, or other syntaxes.
- Keep explanatory prose outside the Mermaid code fence, unless the user asks for comments inside the diagram.
- Prefer syntax that the target Mermaid renderer supports. Do not invent keywords, shape names, directives, or configuration options.
- If the target renderer or the Mermaid version is unknown, prefer stable core syntax to new or experimental features.

## Select the right diagram type

- Use a flowchart for a process, a decision, a pipeline, an architecture flow, or a cause and effect path.
- Use a sequence diagram for time-ordered interactions between actors, services, or components.
- Use a class diagram for object-oriented structure, interfaces, members, and relationships.
- Use a state diagram for lifecycle states and transitions.
- Use an entity-relationship diagram for data entities, attributes, and cardinality.
- Use a Gantt diagram for schedules and time ranges.
- Use a journey diagram for user steps and for sentiment or experience stages.
- Use a mindmap for hierarchical brainstorming or for a taxonomy.
- Use another Mermaid type only when its semantics clearly fit the request.
- If the request mixes several concerns, split it into several focused diagrams. Do not create one unreadable diagram.

## Model the semantics before you write syntax

1. Identify the diagram subject, the scope, the audience, and the necessary level of detail.
2. List the important nodes, actors, entities, states, or milestones.
3. List only the relationships that communicate the requested story.
4. Choose a primary direction or chronology before you write the nodes.
5. Decide which items need a direct label, and which items belong in a legend or in nearby prose.
6. Keep the diagram focused enough to read at the intended display size.

Do not add invented components, dependencies, decisions, metrics, or business rules to make the diagram look complete. If an assumption is necessary, state it outside the diagram.

## Identifiers and labels

- Use short, stable ASCII identifiers for internal node, participant, class, state, and entity names.
- Keep human-readable wording in the labels. Do not use long prose as an internal identifier.
- Quote a label that contains spaces, punctuation, parentheses, brackets, colons, slashes, quotes, or other parser-sensitive characters.
- Escape or restructure a label that contains Mermaid punctuation. Prefer a clear label change to fragile escaping.
- Do not use a reserved word or an ambiguous token as an identifier. In a flowchart, the word `end` causes frequent parser errors. Use a quoted label or a different internal ID.
- Do not use the same internal identifier for two different concepts.
- Do not depend on a generated numeric ID, because that ID changes when someone edits the diagram.
- Preserve a domain name exactly when it is contractual, but keep the domain label separate from the safe internal ID.

## Flowchart guidance

- Start with `flowchart TD`, `LR`, `RL`, `BT`, or another deliberate direction.
- Use a decision node only for an actual branch. Label each outgoing edge clearly.
- Use a subgraph for a meaningful system boundary, phase, or ownership area.
- Keep the edges short, and avoid unnecessary back-edges.
- Prefer one clear entry and one clear outcome when you describe a process.
- Use consistent shapes. Give actions, decisions, inputs, outputs, and external actors recognizable roles.
- Keep the label of a node concise. Put a long explanation in the surrounding prose or in a note.
- Watch for flowchart parser traps. Examples are the word `end`, a lowercase `o` at the start of an edge, brackets, and punctuation.
- Do not use line crossings as decoration. Restructure the graph or use subgraphs when the layout becomes tangled.

## Sequence diagram guidance

- Declare the important participants explicitly when order, aliases, or grouping matters.
- Keep participant names short, and use an alias for a long service name.
- Use message arrows consistently. Distinguish requests, responses, asynchronous events, and failures.
- Show only the interactions that explain the requested scenario.
- Use activation, notes, loops, alternatives, and parallel blocks only when they make the diagram easier to understand.
- Put the failure path and the timeout path near the interaction that causes them.
- Keep each message a short verb phrase. Do not write a full paragraph on an arrow.
- Do not depend on implicit participant order when the order communicates architecture.

## Class, state, and ER guidance

- In a class diagram, show only meaningful attributes and operations. Use visibility and relationship notation consistently.
- In a state diagram, use a noun or a short status phrase for each state. Use a verb phrase for each transition.
- In an ER diagram, name each relationship clearly, and use cardinalities deliberately. Do not use a class diagram when the question is about stored data.
- Keep IDs and labels distinct in every diagram type.
- Do not put implementation detail into a conceptual diagram, unless the user requests a code-level view.

## Layout and visual hierarchy

- Prefer a single dominant reading direction.
- Keep related nodes close, and keep unrelated clusters separated.
- Balance the density across the branches. Avoid one branch that is much wider or taller than the others.
- Use subgraphs or namespaces to communicate boundaries.
- Use the smallest number of colors and styles that creates a useful hierarchy.
- Never make color the only carrier of meaning. Pair color with labels, shapes, line styles, or ordering.
- Use a restrained professional palette with sufficient contrast.
- Use consistent capitalization, tense, punctuation, and label length.
- Add a short title or a caption when a reader can see the diagram outside its original prompt.

## Configuration and styling

- Use Mermaid frontmatter configuration only when the target renderer supports it and the user requests diagram-specific configuration.
- Prefer renderer defaults or a small, explicit theme customization to a large configuration block.
- If you customize a theme, use the documented base theme and explicit hex colors. Do not assume that the renderer supports named colors or arbitrary variables.
- Do not use a deprecated directive when frontmatter configuration can express the same intent.
- Avoid custom CSS, callbacks, click handlers, external links, raw HTML, and embedded scripts. Use them only when the user requests an interactive diagram and the host supports it.
- Never use Mermaid configuration to bypass LC safety, permissions, or tool policy.

## Accessibility

- Give the diagram a meaningful accessible title and description when the renderer supports Mermaid accessibility syntax.
- Use descriptive labels for nodes, actors, states, and entities.
- Keep the text legible at normal zoom. Do not use tiny labels to fit too much content.
- Do not communicate a distinction only through color.
- For a complex diagram, provide a short prose summary or a text alternative outside the diagram.
- Make sure that sequence participants and flowchart decisions stay understandable without color and styling.

This is a supported accessibility pattern:

~~~mermaid
flowchart LR
    accTitle: Order processing
    accDescr: The order moves from validation through payment and fulfillment.
    A[Validate order] --> B{Payment approved?}
    B -- Yes --> C[Fulfill order]
    B -- No --> D[Request payment update]
~~~

## Validation checklist

Check these items before you return a Mermaid diagram:

1. The first line declares exactly one supported diagram type.
2. Every referenced ID is defined or valid for that diagram grammar.
3. Each label with special characters is quoted or safely simplified.
4. There is no accidental collision with a reserved word.
5. The arrows, cardinalities, participants, and relationships match the intended meaning.
6. The diagram has a deliberate direction and a readable hierarchy.
7. No edge, label, or node is redundant.
8. The diagram does not depend on external links, callbacks, scripts, or unavailable renderer features.
9. Accessibility text is present when the diagram communicates meaningful information.
10. The result is complete Mermaid source, not pseudocode.

## Safety boundary

Mermaid is a notation format, not an execution authority. Do not claim that a tool rendered or validated a diagram unless a renderer performed that validation. Mermaid content can describe shell commands, API calls, or system architecture. This skill does not authorize those actions.
