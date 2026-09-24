# Performance and Robustness Audit

Project: **ChatGPT Sidebar Organizer**  
Audited release: **2.2.0**  
Audit date: **2026-09-23**

## Executive summary

The script has a modest idle footprint and does not use a polling loop. Its persistent activity consists of one page-level MutationObserver, one capture-phase document click listener used to synchronize native deletions, eleven delegated listeners on the Organizer root, and three window listeners. Temporary modal listeners are attached to disposable modal nodes and are removed when that DOM is replaced.

The largest practical costs are not the listeners themselves. They are:

1. Keeping the indexed metadata object in memory.
2. Rendering all visible conversation rows when Organizer rerenders.
3. Scanning ChatGPT's virtualized native history during a user-initiated reindex.
4. Serializing the full state when it is saved to `localStorage`.

Version 2.2.0 reduces full-reindex persistence and repeated counting work, adds defensive normalization and failure recovery, and keeps higher-risk architectural changes out of this release.

## Scope and method

The audit covered:

- Persistent and temporary event listeners
- MutationObserver behavior
- Timers, debouncing, and possible polling
- Native history scanning
- Render and sort complexity
- `localStorage` serialization and failure behavior
- Import validation and malformed-state recovery
- Project exclusion and section-memory rules
- Conversation URL/title validation
- Duplicate script injection and modal lifecycle

Testing used Node.js syntax validation plus a dependency-free VM harness that loads the userscript's real core functions. The harness supplies malformed backups, invalid URLs, legacy data, Project URLs, storage errors, large ordering arrays, and HTML-sensitive titles. Static assertions verify listener topology and full-scan cleanup paths.

This is not a guarantee against future ChatGPT DOM or internal API changes. A live end-to-end test cannot make unstable private web interfaces permanent.

## Listener and observer inventory

| Lifetime | Count | Purpose |
| --- | ---: | --- |
| Organizer root listeners | 11 | Delegated input, change, click, conversation drag/drop, and window-drag pointer handling |
| `window` listeners | 3 | Resize, `popstate`, and cross-tab `storage` updates |
| `document` listeners | 1 | Capture native ChatGPT delete confirmation |
| MutationObserver | 1 | Detect title/navigation/sidebar changes |
| Polling intervals | 0 | No `setInterval` is used |
| Temporary modal listeners | Variable | Bound only to the current modal DOM; discarded on close/replacement |

The root uses event delegation, so the number of permanent listeners does not grow with the number of conversations or sections. Repeatedly opening **Manage sections** does not accumulate its old listeners: closing a modal replaces the modal layer with a clean clone.

## Load behavior

### Idle

At idle, there is no periodic work. The MutationObserver receives ChatGPT page mutations but ignores mutations originating inside Organizer. Relevant sidebar scans are debounced by 450 ms, title refresh is debounced by 180 ms, and search rerendering is debounced by 120 ms.

### Normal interaction

Most state-changing actions serialize the complete Organizer state once. This is reasonable for normal localStorage-sized datasets. Dragging the Organizer window updates styles during pointer movement but writes its final position only on pointer release.

### Manual reindex

Reindex is intentionally the most expensive action. It scrolls the native virtualized history list for up to 180 steps, waiting for ChatGPT to load each region. Version 2.2.0 no longer writes the complete state after every changed step. It keeps changes in memory and persists once when the scan finishes or stops early.

The scan now tracks the running conversation count incrementally instead of repeatedly calling `Object.keys(state.chats)` on every step. Candidate history-scroller scores are also computed once per candidate. Automatic sidebar scans are paused while a full manual scan is running, then scheduled once after completion.

### Rendering

Filtering and sorting are approximately `O(C log C)` for `C` visible conversations. Section lookup contributes a small additional factor. Rerendering replaces the visible list HTML, so DOM cost grows with the number of expanded visible rows.

Virtualized rendering was considered but intentionally not introduced. It would materially change drag ordering, jump-to-section behavior, list heights, and accessibility, creating more regression risk than the current release goal allows.

## Storage and memory estimates

Synthetic states were serialized and normalized using the release test harness:

| Conversations | JSON size | Observed normalization time* |
| ---: | ---: | ---: |
| 100 | 27,527 bytes | 1.3–2.2 ms |
| 1,000 | 276,077 bytes | 9.8–11 ms |
| 5,000 | 1,388,741 bytes | 35–49 ms |

\*Several local runs in the provided environment; timings are indicative, not a browser performance guarantee.

The serialized data averages roughly 275–280 bytes per synthetic conversation before browser-specific string/storage overhead. In-memory JavaScript objects require more space than their JSON representation, and expanded DOM rows can exceed the metadata footprint. Browser localStorage quotas vary, but the common limiting factor will generally be storage quota or rendering thousands of simultaneous rows, not event-listener memory.

The userscript source itself is under 100 KB and is not duplicated per conversation.

## Changes made in 2.2.0

| Area | Previous risk/cost | Change | Functional risk |
| --- | --- | --- | --- |
| Full reindex persistence | A changed scan step could serialize and write the entire state repeatedly | Collect in memory and save once in `finally` | Low |
| Full reindex counting | Repeated full `Object.keys` scans | Incremental added-count tracking | Low |
| Concurrent auto scans | Sidebar mutations could schedule redundant scans during manual reindexing | Pause auto scans during reindex and schedule one final refresh | Low |
| Reindex failure | DOM replacement could leave the action stuck as running | `try/catch/finally` restores state and button | Low |
| History scroller scoring | DOM anchor count could be recomputed during sort comparisons | Cache one score per candidate | Low |
| Mutation callback | Multiple passes over each record batch | One short-circuiting pass derives all flags | Low |
| Duplicate injection | A second userscript injection could create duplicate roots/listeners | Exit when the Organizer root already exists | Low |
| Local storage failure | Quota/privacy errors could interrupt an action | Catch the error, retain in-memory state, and warn once | Low |
| Imported state | Malformed values could break rendering or preserve unnecessary fields | Normalize known fields, rekey by canonical URL, repair references, and cap input size/count | Low |
| Manual order edge lookup | `Math.min(...largeArray)`/`Math.max(...largeArray)` could exceed argument limits | Streaming min/max loop | Low |
| Filter rendering | Sorting could mutate the persistent section array during render | Sort a copy | Low |

## Robustness results

Automated result: **14/14 core robustness checks passed**, plus the bilingual structural parity test.

Covered scenarios:

- Invalid stored JSON
- Invalid, short, and non-HTTP conversation URLs
- URL canonicalization
- Project exclusion while preserving section memory
- Duplicate and malformed sections
- Empty/malformed titles and unsupported statuses
- Rejection of **Open desktop app** navigation entries
- Legacy `Hidden` to `Backlog` migration
- Removal of `Work`/options suffixes from native titles
- HTML escaping for user-controlled names and titles
- Duplicate section creation
- 50,000-entry manual-order edge calculation
- Storage quota exception containment
- No polling interval and single observer topology
- Batched full-reindex persistence with guaranteed cleanup
- Batch editor restricted to unsectioned, non-Project conversations

Run the checks with:

```bash
node tests/robustness.test.cjs
node tests/bilingual-parity.test.cjs
```

Run JavaScript syntax validation with:

```bash
node --check chatgpt-sidebar-organizer.user.js
```

## Risks intentionally not optimized

### DOM virtualization

Not implemented because it could break custom drag ordering, section jumps, and expanded/collapsed semantics. Consider it only if real-world datasets show visible performance problems at thousands of simultaneously rendered rows.

### Narrower MutationObserver root

The observer still watches the document subtree because ChatGPT may replace its navigation/sidebar container during SPA transitions. Restricting it to the current sidebar node would reduce callbacks but risks silently losing indexing after that node is replaced.

### Internal rename/delete endpoints

These endpoints are inherently less stable than public APIs. The script keeps modern and legacy fallbacks but cannot guarantee future compatibility.

### Full history API retrieval

The script does not attempt to enumerate a private account database endpoint. It scans only what the signed-in ChatGPT web interface loads, avoiding a larger privacy and compatibility surface.

## Bilingual distribution

Version 2.2.0 ships separate English and Simplified Chinese userscripts, READMEs, and manuals. The two scripts use the same storage key and data schema and differ only in user-facing localization. Both retain multilingual compatibility patterns for recognizing localized ChatGPT navigation labels, placeholders, deletion controls, and missing-conversation messages.

The bilingual parity test verifies matching versions, storage identifiers, function sets, listener topology, observer counts, and key performance safeguards. Only one language variant should be enabled at a time.

## Conclusion

The current listener structure is not expected to create meaningful memory pressure: permanent listener count is fixed and modal listeners are disposable. For typical datasets, metadata memory and routine interaction cost are modest. The most important performance improvement was batching writes during manual reindexing. The remaining major scaling opportunity is list virtualization, but it was correctly deferred because preserving existing behavior has higher priority than speculative optimization.
