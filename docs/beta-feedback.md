# Beta feedback

A temporary feedback tool for the beta: testers report problems and ideas from inside Nexam, by email, with no GitHub (or any other) account. GitHub Issues stays the development source of truth. Reports are triaged into it by hand.

The code is in `app/frontend/src/feedback/`. Remove it, or hide it behind a setting, when the beta ends.

## What testers see

- **Help ▸ Send Feedback…** (every window), and a **Feedback** button in the main window's top bar.
  - **Type:** Bug, Suggestion or General. The form's questions change with it: what happened and what you expected, the idea and how it would help, or a free message.
  - **Area of Nexam:** starts on the screen they're using (Question editor, Drawing tool, Gradebook…), and can be changed.
  - **Screenshot (optional):** they choose an image file. Email links can't carry attachments, so the form reminds them to attach it, and to check that it shows no student information.
  - **Name (optional),** remembered on that computer.
  - **Included automatically, with a checkbox to leave it out:** Nexam version (and the backend's, if different), operating system, which window, and window size. Nothing from the open bank or gradebook is included.
  - **See the full report** shows exactly what will be sent.
- **Sending:**
  - **Open in email** opens their mail app with the report filled in, addressed to the feedback address.
  - **Copy report** is for webmail (Gmail in a browser) or anyone whose mail app doesn't open.
  - A long report goes on the clipboard, and the email says to paste it, because mail apps cut long links.
  - An unsent draft survives closing the window.
- **Help ▸ What's New in This Beta…** shows the release notes. They also open once by themselves after an update (main window only), with "Please try" items for retesting.

Subjects look like `[Nexam beta 0.17.2] Bug · Drawing tool: Arc jumps when dragged`, so an inbox filter on `[Nexam beta` collects them.

## Setup

- **Feedback address:** in GitHub, go to **Settings ▸ Secrets and variables ▸ Actions ▸ Variables** and add `FEEDBACK_EMAIL`. Both release workflows pass it to the build as `VITE_FEEDBACK_EMAIL`. Without it, the form offers **Copy report** only.
- **Local development:** put `VITE_FEEDBACK_EMAIL=you@example.com` in `app/frontend/.env.local` (ignored by git), then restart the dev server.
- **Release notes:** add an entry at the top of `RELEASE_NOTES` in `app/frontend/src/feedback/releaseNotes.ts` with each release, including `retest` items. A version with no entry shows the newest earlier notes.

## Running the beta

- **Testers:** start with 5–12 teachers across subjects and comfort levels with technology. Keep a roster (name, school, subject, OS, version installed).
- **Each release:**
  1. Publish a beta build with a clear version and a What's New entry.
  2. Ask for 2–3 workflows to try, as its "Please try" items.
  3. Let reports come in whenever testers hit something.
  4. Triage once a week. Merge duplicates, then open GitHub issues labeled `bug`, `enhancement` or `feedback`, linking the report by subject line.
  5. Close the loop: say what was fixed in the next What's New, and reply to the testers whose reports led to it.
- **Priorities:** don't rank by how often something is asked for alone. A bug that stops one teacher saving a bank outranks a popular cosmetic request.

## Later, if email gets in the way

- **A small relay to GitHub Issues** (e.g. a free Cloudflare Worker holding a GitHub token): Send would open an issue directly, screenshot included, still with no tester account. The token must live in the relay, never in the app. The form's report text is already issue-ready.
- **Canny** for suggestions and voting (free for up to 25 tracked users). Testers would sign in with an email. Worth it if feature requests outgrow an inbox.
