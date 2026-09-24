# ChatGPT Sidebar Organizer Manual

**English** | [简体中文](manual.zh-CN.md)

This manual applies to version **2.2.0**.

The English and Simplified Chinese userscripts have identical functionality and share the same local data. Install and enable only one language variant at a time.

## 1. What Organizer stores

Organizer stores only organizational metadata in the current browser:

- Conversation title and URL
- Section assignment and section color
- Optional status tag
- Custom conversation and section order
- Window position, filters, and collapsed state
- Pending information needed when creating a conversation inside a section

Conversation messages are not copied into Organizer. The data does not automatically sync between browsers or devices.

## 2. The Organizer window

The panel is a movable window so it does not have to cover ChatGPT's native sidebar.

- Drag the `⠿` beside **Chat Organizer** to move the window.
- Select `×` to close the panel. The small **Organizer** launcher remains available.
- Select `↑` to return the conversation list to the top.
- Select `▾` to expand every section.
- Select `▴` to collapse every section.

The left directory shows section colors and names. Select a name to jump directly to that section. Counts are intentionally omitted from the directory to keep it compact.

## 3. Creating and managing sections

Select **Sections** in the header.

### Create a section

1. Select **New section**.
2. Enter a name.
3. Choose one of the 12 preset colors or use the color picker.
4. Select **Create**.

Section names must be unique, ignoring capitalization and surrounding spaces.

### Edit or reorder sections

- Change the name or color directly in **Manage sections**.
- Drag the `⠿` handle to change section order.
- Select **Done** to save text and color changes.

### Delete sections

- Select `×` on one section to delete it.
- Select **Delete all sections** to remove every section.

Deleting a section never deletes ChatGPT conversations. Conversations assigned to it become unsectioned.

## 4. Assigning a conversation

Open a saved ChatGPT conversation. The current-conversation card appears near the top of Organizer.

Select that card, or select `•••` on any indexed row, to open **Organize conversation**. You can then:

- Assign a section or return the conversation to **Unsectioned**.
- Set `Active`, `Reference`, `Backlog`, or `No status`.
- Create a new section without leaving the editor.
- Remove the conversation from the local Organizer index.

Section and status are independent. A conversation may belong to a section without a status, have a status while unsectioned, or use both.

Organizer does not maintain a separate local display name. The displayed name always follows the actual ChatGPT conversation title.

## 5. Status tags

- **No status** — no tag is displayed.
- **Active** — currently being used or developed.
- **Reference** — retained primarily for future reference.
- **Backlog** — intentionally deferred for later; it does not hide the conversation.

Backups from older versions that used `Hidden` are automatically migrated to `Backlog`.

## 6. Indexing conversations

Organizer automatically notices visible conversation links in ChatGPT's native navigation and records an opened conversation.

Select **Reindex** for a broader scan. Organizer will:

1. Find the scrollable native history list.
2. Move to its top.
3. Scroll through the virtualized list in steps.
4. Collect valid conversation links and titles as they load.
5. Restore the previous scroll position when possible.

Reindexing cannot bypass ChatGPT's own history availability. If a very old conversation is not loaded by the native interface, find it through ChatGPT search and open it once; Organizer can then index it.

Invalid navigation entries such as **Open desktop app**, placeholder titles such as **Untitled chat**, and implausible conversation IDs are rejected.

## 7. Project conversations

Conversations inside a ChatGPT Project are not displayed in Organizer.

If a conversation already has a section and is then moved into a Project, its section assignment remains stored. When it leaves the Project, Organizer restores that section. If no valid section assignment exists, it returns as unsectioned.

## 8. Creating a conversation inside a section

Each section header contains `＋`.

1. Select `＋` on the destination section.
2. Organizer opens a new ChatGPT conversation.
3. Send the first message.
4. Once ChatGPT creates the saved conversation URL, Organizer assigns it to the selected section.

The pending assignment expires after 30 minutes. You can also cancel it from the current-conversation card before sending the first message.

## 9. Search and filters

The search field matches indexed titles only.

Select **Filter** to combine:

- Section: all, unsectioned, or one specific section
- Status: all, no status, Active, Reference, or Backlog
- Type: all, Chat, Work, or GPT
- Sort: custom drag order, recently visited, least recently visited, or title A–Z

Select **Clear filters** to restore the default view.

## 10. Custom ordering

Drag the `⠿` on the left of a conversation to reorder it within the same section. A conversation cannot be dragged directly into a different section; use the conversation editor for that.

If another sort mode is active, beginning a drag converts the visible arrangement into the saved custom order and switches back to **Custom drag order**.

## 11. Batch operations

Select **Batch** to organize multiple conversations. The batch list intentionally contains only conversations that are currently unsectioned and not in a Project.

1. Search within the batch list if needed.
2. Select individual conversations or **Select visible**.
3. Choose a section, a status, or both.
4. Select **Apply**.

Fields left as **Keep unchanged** are not modified. Once a section is assigned, those conversations will not appear in the next batch window.

## 12. Rename and delete

Each row provides:

- `✎` — rename the actual ChatGPT conversation.
- `×` — delete the actual ChatGPT conversation after confirmation.
- `•••` — edit only Organizer section/status metadata.

Rename and delete use the conversation ID and ChatGPT's signed-in web session. They do not depend on the conversation currently being visible in the native history list.

Deleting through Organizer is irreversible. Removing a row through **Remove from local index** is different: it leaves the ChatGPT conversation untouched and it may be indexed again later.

If a conversation was deleted elsewhere, Organizer attempts to remove its stale local entry after native deletion confirmation or after detecting that an Organizer link opens a missing conversation.

## 13. Backup and restore

Open **⚙ Settings and backup**.

- **Export JSON backup** downloads all Organizer metadata.
- **Import JSON** replaces the current Organizer state after confirmation.
- **Clear Organizer data** resets sections, statuses, index, ordering, and UI settings without deleting ChatGPT conversations.

Imports are normalized before use. Invalid URLs, malformed entries, duplicate section IDs, unsupported statuses, and stale references are repaired or removed. Imports are limited to 5 MB, 500 sections, and 20,000 conversations to prevent accidental browser lockups.

## 14. Troubleshooting

### Reindex cannot find the history list

Open ChatGPT's native sidebar and make sure the conversation history is visible, then try again. Organizer still collects currently visible links even when it cannot find a scrollable container.

### A title temporarily says “Fetching title…”

ChatGPT may initially expose only a placeholder. Organizer updates the title when the real title appears in the native sidebar or browser title.

### Rename or delete fails

Refresh ChatGPT and verify that you are signed into the correct account. ChatGPT may have changed its internal endpoints; consult the project's issue policy before reporting a reproducible regression.

### Data disappears after clearing browser data

Organizer uses site-local browser storage. Import a previously exported JSON backup.

### The browser reports that data cannot be saved

The browser may have disabled or exhausted storage for the ChatGPT site. Export a backup if possible, remove unnecessary indexed records, and check the browser's site-storage settings.

## 15. Performance behavior

- There is no polling interval.
- One MutationObserver watches navigation and native sidebar replacement events.
- DOM-triggered scans and search rendering are debounced.
- A manual full reindex batches local persistence instead of rewriting the complete state after every scroll step.
- Modal-specific listeners are discarded with the modal DOM and do not accumulate across repeated opens.

For measurements, test coverage, and intentionally deferred optimizations, see [AUDIT_REPORT.md](AUDIT_REPORT.md).
