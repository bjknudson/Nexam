# AI-made test versions

A teacher asks an outside AI assistant for a different version of a test, such as new values, new questions on the same skills, or a different order, and brings the result back. Nexam reviews it with them and creates it as a new test. The original stays as it is.

## The round trip

It is three steps in one window, **Ask the AI → Paste its reply → Review**, with Back and Next between them. Going back keeps what you pasted and the decisions you made.

1. **Test builder ▸ ✦ Use AI…** builds the prompt. (Also in **JSON… ▸ ✦ Use AI…**, which starts from the JSON as edited there.)
   - Tick common requests: *Make a new version*, *Change the order*, *Change variable values*, *Create new questions*, *Keep the same difficulty levels*, *Keep the same standards distribution*, *Keep question types and number of choices*, *Group into sections*.
   - Add your own words under **Anything else**.
   - The prompt always explains math in `$…$` (with doubled backslashes in JSON). It explains `variables` and `{{calc: …}}` when the test uses them.
   - For requests that change questions, it asks the AI to return every question with its original `id`.
2. **Copy the prompt and the JSON into the AI.**
3. **Next, then paste the reply.** (Or **JSON… ▸ Import AI version…** to paste one directly.)
   - Code fences, a sentence before or after the JSON, and single backslashes in LaTeX are all handled (`aiJson.ts`).
4. **Review.** Every slot is listed in order:
   - **Kept:** identical to the original, so the new version shares it.
   - **Changed:** shown beside the original, both filled in with their values, with the correct choice marked.
   - **New:** a question with no matching original, added where it appears.
   - **Kept (the AI left it out):** put back from the original where it was. Untick *Keep any question the AI left out* to drop such questions instead.
   - **Warnings** come from the usual question checks (e.g. LaTeX outside `$…$`). The review also warns about a worked-out numeric answer that isn't a number, and choices that come out the same.
5. **Decide on each question.**
   - **Changed:** *Keep* (the default), *Needs work*, or *Use original*, which puts the original back in that spot (undo with *Use the AI's version instead*).
   - **New:** *Keep*, *Needs work*, or *Leave out*.
   - **Kept:** a quiet *Needs work…* link, to have the AI change a question it left alone.
   - **Needs work** opens a note: what should change.
6. **Ask AI to fix N questions →** (shown instead of Create while any question needs work).
   - The follow-up prompt holds only those questions, each with your note, and asks for exactly those back with the same ids. Paste it into the same AI chat.
   - A new question with no id is given a temporary one (`new_1`, `new_2`…) so its answer can be matched. Nexam replaces it with a real id on Create.
   - Paste the reply and press Next: each returned question replaces the one with the same id, and the version is checked again against the **original test**. Reworked questions get a *Reworked* tag. Repeat as needed.
   - The reply must hold exactly the ids asked for. Anything else is refused with what was expected and what came back, rather than guessed (`versionRework.ts`).
   - Every decision edits the pasted JSON and checks it again, so the review always shows what Create will make.
7. **Create version B.**
   - New and changed questions are created in the bank.
   - A new test draft gets the next free version letter and the same title, so it groups with the original in the gradebook. It also keeps the sections, print settings and courses.
   - It all happens at once, or not at all.

## Rules

- **Slots aren't strict.** A version may be longer or shorter (e.g. to fill in or adjust a test). Questions are matched to their originals by `id`.
- **Except with interchangeable sheets.** When the test is set to share one answer sheet across versions, the new version must have the same number of questions, and each position the same type and number of choices. Otherwise it can't be created, and the review says which positions differ.
- **Kept questions are shared** between versions. Editing one later changes it in both versions, as with any question used in two tests.
- **Not recorded yet:** which original a changed question replaced (a `based_on` link). Add it if reports need to compare question 4 across versions.

## Code

- `app/backend/test_versions.py`: `plan_test_version` (preview) and `build_version_test`.
- `BankWorkspaceService.preview_test_version` and `create_test_version`, at `POST /api/tests/{id}/versions/preview` and `POST /api/tests/{id}/versions`.
- Each review item's `payload_index` says which pasted question it came from, so decisions can change that entry.
- Frontend: `AiPromptDialog.tsx` (the prompt builder), `VersionImportDialog.tsx` (paste, review, decisions and the follow-up), `versionRework.ts` (the JSON changes, the follow-up prompt and the strict merge) and `aiJson.ts` (reading the reply).
