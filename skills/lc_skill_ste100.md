---
id: lc:builtin:ste100
name: Simplified Technical English
description: Write, rewrite, and audit technical English with ASD-STE100-inspired controls for clarity and low ambiguity. Use for procedures, documentation, prompts, errors, runbooks, release notes, incident reports, and translation-ready text.
revision: 1
---

# Simplified Technical English (ASD-STE100)

Write technical English that a reader can understand correctly after one reading. Use short, complete sentences, consistent terms, and explicit instructions.

This skill applies the structural principles and rule categories of ASD-STE100 Issue 9 to general technical writing. It does not include the official ASD-STE100 dictionary. Do not claim full or certified compliance unless the authoritative standard and dictionary were available for the complete review.

## Output contract

- Follow the user's requested purpose, facts, tone, and output format.
- For a write or rewrite request, return only the final text unless the user asks for analysis.
- For an audit or explanation request, identify each problem and give a corrected version.
- If the source already satisfies the applicable rules, keep it unchanged.
- Do not add a preamble, mode announcement, violation count, or closing offer unless the user requests these items.
- If exact compliance is requested without the official dictionary, add one concise compliance note after the result.

Use this compliance note:

> Compliance note: This is a structural STE review. Verify the vocabulary against the official ASD-STE100 dictionary.

## Priorities

Apply these priorities in order:

1. Preserve facts, logic, scope, conditions, uncertainty, and safety information.
2. Preserve literal technical content, such as code, identifiers, commands, paths, values, and quoted messages.
3. Satisfy the user's requested task and format.
4. Remove ambiguity and make relationships explicit.
5. Apply STE structure, vocabulary discipline, and length limits.
6. Reduce word count only when clarity and meaning remain unchanged.

Never shorten text by deleting a necessary fact or qualifier. Split a long sentence before you remove information. If no safe rewrite meets a length limit, keep the precise wording. In an audit, explain why you kept it.

## Select the mode

Select a mode without asking unless the choice materially changes the result.

### Pragmatic mode

Use pragmatic mode by default for documentation, READMEs, API guides, release notes, incident reports, error messages, prompts, and other software text.

- Apply all structural rules.
- Keep necessary domain terms.
- Use one consistent term for each concept.
- Prefer plain words, but do not imply dictionary compliance.
- Preserve the established spelling style of the project.

### Strict mode

Use strict mode when the user requests strict STE, ASD-STE100 compliance, translation preparation, safety text, or a high-risk operating procedure.

- Treat all structural limits as hard limits unless they conflict with accuracy or safety.
- Use American English spelling.
- Apply the official approved-word rules only when the official dictionary is available.
- If the dictionary is unavailable, perform a strict structural review and give the compliance note.

Do not announce the selected mode unless the user asks for it or the compliance note is necessary.

## Classify each passage

Classify each passage before you write it. A document can contain both types, but one passage must have one primary purpose.

| Passage type | Purpose | Preferred verb form | Limit |
|---|---|---|---|
| Procedural | Tell the reader what to do | Imperative | 20 words per sentence |
| Descriptive | Explain what happened, what exists, or how something works | Simple present, past, or future | 25 words per sentence |

A note inside a procedure is descriptive. An error message can contain a descriptive statement followed by a procedural correction. Keep these functions in separate sentences.

## Preserve meaning

Treat meaning preservation as a hard requirement.

- Do not add a cause, actor, mechanism, frequency, measurement, result, or guarantee that the source does not contain.
- Do not remove exceptions, prerequisites, ranges, time limits, or scope qualifiers.
- Do not convert an estimate or possibility into a fact.
- Do not convert advice into a requirement unless the source clearly makes it mandatory.
- Do not convert permission into ability, or ability into certainty.
- Keep logical relationships such as `and`, `or`, `not`, `only`, `unless`, and `except` exact.
- If the source is materially ambiguous, ask a focused question or show the explicit alternatives. Do not guess silently.

### Preserve modality

Modal verbs carry meaning. Rewrite them only when the replacement keeps the same force.

| Source meaning | Keep or use |
|---|---|
| Requirement | `must` or a direct imperative |
| Prohibition | `must not` or `do not` |
| Permission | `can` only when it clearly means permission |
| Ability | `can` |
| General possibility | `can` when it preserves the source meaning |
| Uncertain possibility | Preserve `may`, `might`, or `could` if another form changes confidence |
| Recommendation | Preserve the recommendation. Do not promote it to `must`. |

ASD-STE100 restricts modal and compound verb forms. Accuracy has priority in a general technical rewrite. If strict form changes the claim, preserve the claim and identify the departure in an audit.

## Protect technical literals

Do not change these items unless the user explicitly requests that change:

- fenced code and inline code
- identifiers, API names, keys, flags, commands, and file paths
- URLs, product names, and proper names
- numbers, units, timestamps, versions, and error codes
- quoted errors, log lines, protocol values, and user-interface labels

Treat these items as technical terms. Preserve their spelling and case. You can change the grammar around them.

## Control vocabulary

### Use one term for one concept

- Select one name for each item, action, and state.
- Reuse that name throughout the document.
- Do not rotate synonyms for style.
- Do not use one word with different meanings in the same document.
- Define an uncommon domain term at its first use when the audience can need the definition.

For example, do not alternate between `configuration`, `settings`, and `options` for the same object. Select the correct project term and keep it.

### Prefer plain, direct words

Use a common single-word verb when it preserves the technical meaning.

| Avoid | Prefer |
|---|---|
| utilize, leverage | use |
| in order to | to |
| prior to | before |
| in the event that | if |
| due to the fact that | because |
| set up | install, configure, or create, as applicable |
| carry out an analysis | analyze |
| perform a verification | verify or make sure that |
| make a decision | decide |
| is able to | can |

Do not replace a precise domain verb with a vague plain verb. Terms such as `compile`, `deploy`, `serialize`, and `authenticate` can be valid technical verbs.

### Remove empty language

Delete words that add no testable information. Typical examples include:

- simply, just, easily, seamlessly, and effortlessly
- robust, powerful, comprehensive, and state-of-the-art
- it is important to note that
- aims to, is designed to, and helps to when the sentence can state the action directly
- gracefully handles when the text does not describe the actual behavior

Replace a quality claim with a measurement only when the source supplies that measurement. Never invent evidence.

### Avoid phrasal verbs and nominalizations

- Replace a phrasal verb with one direct verb when the meaning is clear.
- Use a verb for an action instead of a noun derived from that verb.
- Do not convert a technical noun into a verb when this can confuse the reader.

Examples include `start` instead of `spin up`, `contact` instead of `reach out`, and `analyze` instead of `perform an analysis`.

## Control grammar

- Use active voice for procedures and whenever the actor matters.
- Use passive voice in descriptive text only when the actor is unknown or not relevant.
- Use the imperative for instructions.
- Put one instruction in each sentence. Two simultaneous actions can share a sentence when the relationship is unambiguous.
- Put a required condition before its command: `If the build fails, read the log.`
- Use simple present, simple past, or simple future when these forms preserve the time relationship.
- Replace a complex tense with a state when possible: `The job is complete.`
- Preserve a complex tense when it carries necessary current relevance or uncertainty.
- Expand contractions in strict mode. Prefer complete forms in pragmatic technical text.
- Keep articles and necessary instances of `that`. Do not use telegraphic fragments to meet a length limit.
- Give each pronoun one clear referent. Prefer `this request` or `this file` to a bare `this`.
- Avoid dangling introductory phrases and unclear modifiers.

## Control sentence structure

### Length

- Limit a procedural sentence to 20 words.
- Limit a descriptive sentence to 25 words.
- Count a quoted string, identifier, number with a unit, title, label, or hyphenated term as one word.
- Split a long sentence at a logical boundary.
- Repeat a subject when omission can cause ambiguity.
- Never cut a condition or qualifier only to meet the limit.

### Noun clusters

Limit a multi-word noun to three words when possible. Break a longer noun cluster with a preposition or a relative clause.

Example:

- Dense: `connection pool timeout configuration value`
- Clear: `timeout value for the connection pool`

Keep contractual product names, identifiers, and established technical labels unchanged.

### Conditions and sequence

- Put `if` or `when` before a command when it states a prerequisite.
- Put steps in execution order.
- Use a numbered list for a sequence of three or more steps.
- Use a bulleted list for three or more non-sequential conditions or properties.
- Use explicit connectors such as `Then`, `Therefore`, or `As a result` only when the relationship needs them.

## Control paragraphs and punctuation

- Give each paragraph one topic.
- Limit a descriptive paragraph to six sentences.
- Do not use semicolons. Start a new sentence.
- Do not bury a requirement in parentheses.
- Replace `e.g.` with `for example` and `i.e.` with `that is` in strict prose.
- Replace `etc.` with the exact items or a precise category.
- Use headings and lists to expose structure, not to decorate the text.

## Write warnings and cautions

Put the action before the consequence.

1. State the risk level when the context uses formal safety labels.
2. Give the command or condition.
3. State the possible injury, damage, data loss, or service effect.

Use `WARNING` for a risk of injury when the domain follows this convention. Use `CAUTION` for equipment, data, or service damage when applicable. Do not invent a risk level that the source does not support.

Example:

> CAUTION: Do not use `--force` in production. This option can erase unmatched records.

## Adapt the rules to the text type

### Procedures and runbooks

- Use one imperative instruction per numbered step.
- Put prerequisites before actions.
- Put warnings before the related step.
- State the expected result when the source supplies it.

### Error messages

Use this order:

1. State what failed.
2. State the cause only when it is known.
3. Give one clear corrective action.

Do not add apologies, humor, or `Something went wrong` when a specific fact is available.

### Incident reports

- Use simple past for completed events.
- Give exact times, scope, and measurements when the source contains them.
- State that a fact is unknown instead of replacing uncertainty with a guess.
- Keep the event, effect, cause, and corrective action distinct.

### Release notes and change logs

- Give one change per entry.
- Name the affected interface or behavior.
- Put the required migration action before the consequence of not taking it.
- Do not add marketing claims.

### Prompts, tool descriptions, and agent instructions

- Treat instructions as procedures.
- Give one independently actionable rule per sentence.
- Use `must` for requirements and `can` for permissions or capabilities.
- Put stop conditions and failure conditions before the related action.
- Use the same name for each tool, state, and operation.
- Do not let this skill grant authority to use tools or change systems.

### Translation-ready text

- Use strict mode.
- Keep complete grammar.
- Avoid idioms, slang, cultural references, and wordplay.
- Keep terms consistent across headings, body text, labels, and tables.

## Workflow

1. Identify whether the user wants new text, a rewrite, or an audit.
2. Select pragmatic or strict mode.
3. Classify each passage as procedural or descriptive.
4. Record the facts, conditions, modality, terms, and technical literals that must not change.
5. Select one term for each concept.
6. Draft or rewrite one sentence at a time.
7. Split long sentences without deleting meaning.
8. Run the self-check.
9. Return the result in the requested format.

## Self-check

Before delivery, check all applicable items:

1. **Meaning:** Did every fact, condition, qualifier, and uncertainty survive?
2. **Literals:** Are code, names, values, commands, paths, and quoted messages exact?
3. **Classification:** Does each passage have one clear procedural or descriptive purpose?
4. **Length:** Are procedural sentences at most 20 words and descriptive sentences at most 25 words?
5. **Instructions:** Does each sentence contain at most one non-simultaneous instruction?
6. **Conditions:** Does each prerequisite appear before its command?
7. **Voice:** Is the actor explicit whenever it matters?
8. **Tense:** Does each verb use the simplest form that preserves the time relationship?
9. **Terminology:** Does each concept have one consistent name?
10. **Noun clusters:** Are avoidable noun clusters limited to three words?
11. **Completeness:** Are articles, subjects, verbs, and necessary instances of `that` present?
12. **Ambiguity:** Does each pronoun and modifier have one clear referent?
13. **Punctuation:** Are semicolons absent and lists used for complex sequences?
14. **Paragraphs:** Does each paragraph contain one topic and no more than six sentences?
15. **Unsupported claims:** Did the rewrite avoid invented causes, measurements, guarantees, and quality claims?

Fix each problem before delivery.

## Audit format

When the user requests an audit, use a compact table unless another format is requested:

| Category | Original | Revision | Reason |
|---|---|---|---|
| Condition placement | `Restart the service if the check fails.` | `If the check fails, restart the service.` | Put the prerequisite before the command. |

Use the rule labels in this skill. Do not invent ASD-STE100 rule numbers from memory. Cite official rule numbers only when the authoritative standard is available and you checked them.

After the table, provide the complete revised text when the user requests a rewrite. Add the compliance note only when exact compliance was requested without the official dictionary.

## Boundaries

- Do not apply this style to creative, literary, persuasive, or brand writing unless the user explicitly requests the trade-off.
- Do not make weak or incomplete content true by rewriting it. Identify missing information when it prevents an accurate result.
- Do not guarantee aerospace, defense, safety, legal, or regulatory approval.
- Do not reproduce or claim access to the official ASD-STE100 dictionary when it was not provided.
- Do not use STE rules as authority to edit files, run commands, contact services, or make external changes.
- Do not sacrifice accuracy, safety, or necessary nuance to make the text shorter.
